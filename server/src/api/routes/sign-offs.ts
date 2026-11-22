import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireApiKey, requirePermission, requireSession, requireWorkspaceAccess } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody } from "../middleware/validation.ts";
import { auditCaller } from "../audit-caller.ts";
import { pathParam } from "../params.ts";
import { env } from "../../config/env.ts";
import { escapeHtml } from "../../utils/html.ts";
import { ApiError, ValidationError } from "../../utils/errors.ts";
import {
  approveSignOff,
  assertMaySignOff,
  cancelSignOff,
  getSignOff,
  getSignOffRow,
  listSignOffs,
  type PublicSignOffStatus,
  rejectSignOff,
  type SignOffReader,
  toPublicSignOff,
} from "../../core/governance/sign-offs.ts";
import { verifySignOffLink } from "../../core/governance/sign-off-links.ts";
import { isHumanPresent } from "../governance-gate.ts";
import { renderDiff } from "../../core/governance/classify.ts";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { signOffRequests } from "../../db/schema/sign-offs.ts";

const STATUSES = ["pending", "applied", "rejected", "expired", "cancelled", "failed"] as const;
const listQuery = (c: Context) => {
  const status = c.req.query("status");
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    throw new ValidationError(`status is one of: ${STATUSES.join(", ")}.`);
  }
  const limitText = c.req.query("limit");
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new ValidationError("limit is a whole number from 1 to 100.");
  return { status: status as PublicSignOffStatus | undefined, limit };
};

const signOffId = (c: Context) => {
  const id = pathParam(c, "signOffId");
  if (!/^sor_[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ValidationError("A sign-off request id looks like sor_...");
  return id;
};

const noteSchema = z.object({ note: z.string().trim().max(1000).optional() }).strict();

export const signOffsRouter = new Hono();
signOffsRouter.use("*", requireApiKey);
signOffsRouter.use("*", rateLimitByWorkspace);

function reader(c: Context): SignOffReader {
  if (isHumanPresent(c)) return { type: "session", workspaceId: c.get("workspaceId") as string };
  return {
    type: "credential",
    workspaceId: c.get("workspaceId") as string,
    environmentId: c.get("environmentId") as string,
    keyId: (c.get("apiKeyId") as string | undefined) ?? null,
    oauthClientId: (c.get("oauthClientId") as string | undefined) ?? null,
    userId: (c.get("userId") as string | undefined) ?? null,
  };
}

signOffsRouter.get("/", async (c: Context) => {
  return c.json({ success: true, data: await listSignOffs(reader(c), listQuery(c)) });
});

signOffsRouter.get("/:signOffId", async (c: Context) => {
  return c.json({ success: true, data: await getSignOff(signOffId(c), reader(c)) });
});

signOffsRouter.post("/:signOffId/cancel", async (c: Context) => {
  const who = reader(c);
  if (who.type !== "credential") {
    throw new ApiError(400, "SIGN_OFF_CANCEL_BY_REQUESTER", "The credential that asked is the one that can cancel its request. Reject it in the console instead.");
  }
  return c.json({ success: true, data: await cancelSignOff(signOffId(c), who, auditCaller(c).context) });
});

export const signOffsConsoleRouter = new Hono();

signOffsConsoleRouter.get("/:workspaceId/sign-offs", requireSession, requireWorkspaceAccess, async (c: Context) => {
  return c.json({ success: true, data: await listSignOffs({ type: "session", workspaceId: pathParam(c, "workspaceId") }, listQuery(c)) });
});

signOffsConsoleRouter.get("/:workspaceId/sign-offs/:signOffId", requireSession, requireWorkspaceAccess, async (c: Context) => {
  return c.json({ success: true, data: await getSignOff(signOffId(c), { type: "session", workspaceId: pathParam(c, "workspaceId") }) });
});

const decide = (decision: "approve" | "reject") => async (c: Context) => {
  const decider = { userId: c.get("userId") as string, via: "console" as const, note: c.get("validatedBody").note ?? null, context: auditCaller(c).context };
  const workspaceId = pathParam(c, "workspaceId");
  const result = decision === "approve"
    ? await approveSignOff(workspaceId, signOffId(c), decider)
    : await rejectSignOff(workspaceId, signOffId(c), decider);
  return c.json({ success: true, data: result });
};

signOffsConsoleRouter.post(
  "/:workspaceId/sign-offs/:signOffId/approve",
  requireSession, requireWorkspaceAccess, requirePermission("governance.sign_off"), validateBody(noteSchema),
  decide("approve"),
);

signOffsConsoleRouter.post(
  "/:workspaceId/sign-offs/:signOffId/reject",
  requireSession, requireWorkspaceAccess, requirePermission("governance.sign_off"), validateBody(noteSchema),
  decide("reject"),
);

export const signOffLinksRouter = new Hono();

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function page(c: Context, status: 200 | 400 | 403 | 404 | 409, title: string, body: string) {
  c.header("Content-Security-Policy", PAGE_CSP);
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  return c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#0a0a0a;--muted:#555;--border:#e5e5e5;--panel:#f5f5f5;--btn:#171717;--btnfg:#fafafa}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#fafafa;--muted:#a3a3a3;--border:#262626;--panel:#171717;--btn:#fafafa;--btnfg:#171717}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:40px 16px}
h1{font-size:20px;line-height:1.35;margin:0 0 8px}
p{color:var(--muted);margin:0 0 16px}
pre{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}
form{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
textarea{width:100%;min-height:64px;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;padding:8px;background:var(--bg);color:var(--fg);font:inherit}
button{border:1px solid var(--border);border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;background:var(--bg);color:var(--fg)}
button.primary,a.primary{background:var(--btn);color:var(--btnfg);border-color:var(--btn)}
a.primary{display:inline-block;border:1px solid var(--btn);border-radius:8px;padding:8px 14px;font-weight:600;text-decoration:none}
</style></head><body><main>${body}</main></body></html>`, status);
}

async function linkContext(c: Context) {
  const claims = verifySignOffLink(pathParam(c, "token"), env.DELIVERY_SECRET_MASTER_KEY);
  if (!claims) return { error: page(c, 404, "Link not valid", "<h1>This link is not valid</h1><p>It may have expired, or it was changed. Open the request in the console instead.</p>") } as const;
  const [found] = await db.select({ workspaceId: signOffRequests.workspaceId }).from(signOffRequests).where(eq(signOffRequests.signOffId, claims.signOffId)).limit(1);
  if (!found) return { error: page(c, 404, "Not found", "<h1>This request no longer exists</h1>") } as const;
  return { claims, workspaceId: found.workspaceId } as const;
}

function describe(row: ReturnType<typeof toPublicSignOff>): string {
  return `<h1>${escapeHtml(row.summary)}</h1>
<p>An agent asked to loosen one of its guardrails. It cannot apply this itself: a workspace admin has to approve it. Nothing changes until you decide.</p>
<pre>${escapeHtml(renderDiff(row.changes))}</pre>
<p>Requested ${escapeHtml(new Date(row.createdAt).toUTCString())}. Expires ${escapeHtml(new Date(row.expiresAt).toUTCString())}.</p>`;
}

function finalState(row: ReturnType<typeof toPublicSignOff>): string {
  const what: Record<string, string> = {
    applied: "Approved and applied.",
    rejected: "Rejected. Nothing changed.",
    expired: "Expired. Nothing changed.",
    cancelled: "Withdrawn by the agent. Nothing changed.",
    failed: `Approved, but it could not be applied: ${row.error?.message ?? "unknown reason"} Nothing changed.`,
    pending: "Still waiting for a decision.",
  };
  return `${describe(row)}<p><strong>${escapeHtml(what[row.status] ?? row.status)}</strong></p><p><a href="${escapeHtml(row.signOffUrl)}">Open it in the console</a></p>`;
}

signOffLinksRouter.get("/:token", async (c: Context) => {
  const ctx = await linkContext(c);
  if ("error" in ctx) return ctx.error;
  const row = toPublicSignOff(await getSignOffRow(ctx.workspaceId, ctx.claims.signOffId));
  if (row.status !== "pending") return page(c, 200, "Sign-off", finalState(row));
  return page(c, 200, "Sign-off needed", `${describe(row)}
<p><a class="primary" href="${escapeHtml(row.signOffUrl)}">Review and approve in the console</a></p>
<p>Approving needs you signed in. You can reject it from here.</p>
<form method="post">
  <textarea name="note" maxlength="1000" placeholder="Note (optional)"></textarea>
  <button type="submit" name="decision" value="reject">Reject</button>
</form>`);
});

signOffLinksRouter.post("/:token", async (c: Context) => {
  const ctx = await linkContext(c);
  if ("error" in ctx) return ctx.error;
  const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const decision = form.decision;
  if (decision === "approve") {
    const pendingRow = toPublicSignOff(await getSignOffRow(ctx.workspaceId, ctx.claims.signOffId));
    return page(c, 403, "Sign in to approve", `<h1>Approve this in the console</h1><p>A link in an email is not enough to loosen a guardrail. Nothing changed.</p><p><a class="primary" href="${escapeHtml(pendingRow.signOffUrl)}">Review and approve in the console</a></p>`);
  }
  if (decision !== "reject") return page(c, 400, "Choose", "<h1>Open the request in the console to approve it, or reject it here</h1>");
  const note = typeof form.note === "string" && form.note.trim() ? form.note.trim().slice(0, 1000) : null;
  try {
    await assertMaySignOff(ctx.workspaceId, ctx.claims.userId);
  } catch {
    return page(c, 403, "Not allowed", "<h1>You can no longer decide this</h1><p>A workspace admin approves or rejects a change an agent asked for.</p>");
  }
  const decider = { userId: ctx.claims.userId, via: "email_link" as const, note, context: auditCaller(c).context };
  try {
    const row = await rejectSignOff(ctx.workspaceId, ctx.claims.signOffId, decider);
    return page(c, 200, "Decided", finalState(row));
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 409) {
      return page(c, 409, "Already decided", finalState(toPublicSignOff(await getSignOffRow(ctx.workspaceId, ctx.claims.signOffId))));
    }
    throw error;
  }
});
