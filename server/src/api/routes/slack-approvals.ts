import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireApiKey, requireApiKeyResourceScopes, requirePermission } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody } from "../middleware/validation.ts";
import { validateUUID } from "../../utils/uuid-validator.ts";
import { AuthorizationError } from "../../utils/errors.ts";
import { env } from "../../config/env.ts";
import { instanceSetting } from "../../core/instance/settings.ts";
import { auth } from "../../utils/auth.ts";
import { createLogger } from "../../lib/logger.ts";
import { verifySlackSignature } from "../../core/slack-approvals/signature.ts";
import { routeInteraction, type SlackInteractionPayload } from "../../core/slack-approvals/service.ts";
import {
  finishSlackIdentityLink,
  getSlackApprovalsSettings,
  removeSlackApprovalRoute,
  setSlackApprovalRoute,
  startSlackIdentityLink,
  unlinkSlackIdentity,
} from "../../core/slack-approvals/settings.ts";
import { pathParam } from "../params.ts";

const logger = createLogger({ module: "slack-approvals-routes" });

export const slackApprovalsRouter = new Hono();
slackApprovalsRouter.use("*", requireApiKey);
slackApprovalsRouter.use("*", requireApiKeyResourceScopes("integrations:read", "integrations:write"));
slackApprovalsRouter.use("*", rateLimitByWorkspace);

const routeSchema = z.object({
  integrationId: z.string().guid(),
  channelId: z.string().regex(/^[CG][A-Z0-9]{2,30}$/, "Not a Slack channel id"),
  channelName: z.string().min(1).max(100),
});

slackApprovalsRouter.get("/", async (c: Context) => {
  const userId = c.get("authType") === "session" ? (c.get("userId") as string) : null;
  const data = await getSlackApprovalsSettings(c.get("workspaceId"), userId);
  return c.json({ success: true, data });
});

export function routeEnvironment(c: Context): string {
  const environmentId = validateUUID(pathParam(c, "environmentId"), "Environment ID");
  if (c.get("authType") !== "session" && c.get("environmentId") !== environmentId) {
    throw new AuthorizationError("This credential can change the Slack channel of its own environment only. Use a key for that environment, or the console.");
  }
  return environmentId;
}

slackApprovalsRouter.put(
  "/routes/:environmentId",
  requirePermission("notifications.manage"),
  validateBody(routeSchema),
  async (c: Context) => {
    const body = c.get("validatedBody") as z.infer<typeof routeSchema>;
    const data = await setSlackApprovalRoute({
      workspaceId: c.get("workspaceId"),
      environmentId: routeEnvironment(c),
      integrationId: body.integrationId,
      channelId: body.channelId,
      channelName: body.channelName,
      userId: (c.get("userId") as string | undefined) ?? null,
    });
    return c.json({ success: true, data });
  },
);

slackApprovalsRouter.delete("/routes/:environmentId", requirePermission("notifications.manage"), async (c: Context) => {
  const removed = await removeSlackApprovalRoute(c.get("workspaceId"), routeEnvironment(c));
  return c.json({ success: true, data: { removed } });
});

function sessionUser(c: Context): string {
  if (c.get("authType") !== "session" || !c.get("userId")) {
    throw new AuthorizationError("Linking a Slack account needs a signed-in member. An API key has no Slack account.");
  }
  return c.get("userId") as string;
}

slackApprovalsRouter.post("/identity/start", async (c: Context) => {
  const data = await startSlackIdentityLink(c.get("workspaceId"), sessionUser(c));
  return c.json({ success: true, data });
});

slackApprovalsRouter.delete("/identity", async (c: Context) => {
  const removed = await unlinkSlackIdentity(c.get("workspaceId"), sessionUser(c));
  return c.json({ success: true, data: { removed } });
});

let scheduleWork: (work: Promise<void>) => void = (work) => {
  work.catch((error) => logger.error({ error: error instanceof Error ? error.message : error }, "Slack interaction failed"));
};
export function setSlackWorkScheduler(fn: (work: Promise<void>) => void): void {
  scheduleWork = fn;
}

export const slackPublicRouter = new Hono({ strict: false });

slackPublicRouter.post("/interactions", async (c: Context) => {
  const signingSecret = instanceSetting("slack.signing_secret");
  if (!signingSecret) return c.json({ error: "Slack approvals are not configured" }, 503);

  const rawBody = await c.req.text();
  const verified = verifySlackSignature({
    signingSecret,
    timestamp: c.req.header("x-slack-request-timestamp"),
    signature: c.req.header("x-slack-signature"),
    rawBody,
  });
  if (!verified.ok) {
    logger.warn({ reason: verified.reason }, "Slack interaction refused: signature");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: SlackInteractionPayload;
  try {
    const raw = new URLSearchParams(rawBody).get("payload");
    if (!raw) return c.json({ error: "Missing payload" }, 400);
    payload = JSON.parse(raw) as SlackInteractionPayload;
  } catch {
    return c.json({ error: "Malformed payload" }, 400);
  }

  const outcome = await routeInteraction(payload);
  if (outcome.work) scheduleWork(outcome.work);
  return outcome.response ? c.json(outcome.response) : c.body(null, 200);
});

slackPublicRouter.get("/identity/callback", async (c: Context) => {
  const frontend = env.FRONTEND_URL || env.BETTER_AUTH_URL;
  const back = (query: string) => c.redirect(`${frontend}/settings/integrations?${query}`);
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (c.req.query("error") || !code || !state) {
    return back(`slack_link_error=${encodeURIComponent("Slack sign-in was cancelled.")}`);
  }
  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  const { hasWorkspaceAccess } = await import("../../core/workspace/service.ts");
  const result = await finishSlackIdentityLink({
    state,
    code,
    sessionUserId: session?.user.id ?? null,
    hasAccess: hasWorkspaceAccess,
  });
  if (!result.ok) return back(`slack_link_error=${encodeURIComponent(result.error)}`);
  return back("slack_linked=true");
});
