import { Hono, type Context, type Next } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { apiKeys } from "../../db/schema/workspaces.ts";
import { environments } from "../../db/schema/environments.ts";
import { endUserErasures } from "../../db/schema/end-user-erasures.ts";
import { erasedEndUserId } from "../../core/end-users/identity.ts";
import { requireFeature } from "../middleware/feature-gate.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody, validateQuery } from "../middleware/validation.ts";
import { createConnectLinkSchema, decideEndUserApprovalSchema, sessionApprovalsQuerySchema } from "../../utils/validation.ts";
import { ApiError, ApprovalNotFoundError, ValidationError } from "../../utils/errors.ts";
import { isValidUUID } from "../../utils/uuid-validator.ts";
import { buildPaginatedResponse } from "../../utils/pagination.ts";
import { createConnectLink } from "../../core/end-users/connect.ts";
import { deleteEndUserConnection, listEndUserConnections } from "../../core/end-users/connections.ts";
import { approveApproval, denyApproval, getApproval, listEndUserApprovals } from "../../core/approvals/service.ts";
import { verifySessionToken, type SessionCapability, type SessionClaims } from "../../core/end-users/session-token.ts";
import { sessionApprovalViews, sessionConnectionView } from "../../core/end-users/session-views.ts";
import type { AuditActor } from "../../core/audit/event-schema.ts";
import { markCredentialRejected } from "../credential-rejection.ts";
import { pathParam } from "../params.ts";

export const END_USER_SESSION_PATH = "/api/v2/end-user-session";

const router = new Hono();

const EXPOSED_HEADERS = "X-Request-Id, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset";

function allowOrigin(c: Context, origin: string): void {
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Access-Control-Expose-Headers", EXPOSED_HEADERS);
}

router.use("*", async (c, next) => {
  c.header("Vary", "Origin");
  if (c.req.method !== "OPTIONS") return next();
  const origin = c.req.header("Origin");
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    c.header("Access-Control-Max-Age", "600");
  }
  return c.body(null, 204);
});

router.use("*", requireFeature("connected-accounts"));

async function requireEndUserSession(c: Context, next: Next) {
  const origin = c.req.header("Origin");
  const refuse = (code: string, message: string): ApiError => {
    markCredentialRejected(c);
    if (origin) allowOrigin(c, origin);
    return new ApiError(401, code, message);
  };

  const match = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("Authorization") ?? "");
  if (!match) throw refuse("END_USER_SESSION_REQUIRED", "Send an end-user session token as Authorization: Bearer eus_...");
  const check = verifySessionToken(match[1]);
  if (!check.ok) {
    if (check.reason === "expired") throw refuse("END_USER_SESSION_EXPIRED", "This session has expired. Fetch a new one from your server.");
    throw refuse("END_USER_SESSION_INVALID", "This end-user session token is not valid.");
  }
  const claims = check.claims;

  const [row] = isValidUUID(claims.kid) && isValidUUID(claims.ws) && isValidUUID(claims.env)
    ? await db.select({ isActive: apiKeys.isActive, expiresAt: apiKeys.expiresAt, allowed: environments.allowedRedirectUrls })
      .from(apiKeys)
      .innerJoin(environments, eq(environments.id, apiKeys.environmentId))
      .where(and(eq(apiKeys.id, claims.kid), eq(apiKeys.workspaceId, claims.ws), eq(apiKeys.environmentId, claims.env)))
      .limit(1)
    : [];
  if (!row || row.isActive !== "true" || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) {
    throw refuse("END_USER_SESSION_INVALID", "The API key that created this session was revoked or has expired.");
  }

  const [erased] = await db.select({ erasedAt: endUserErasures.erasedAt }).from(endUserErasures).where(and(
    eq(endUserErasures.environmentId, claims.env),
    eq(endUserErasures.erasedAs, erasedEndUserId(claims.ws, claims.eu)),
  )).limit(1);
  if (erased && claims.iat <= Math.floor(erased.erasedAt.getTime() / 1000)) {
    throw refuse("END_USER_SESSION_INVALID", "This end user was erased. Fetch a new session from your server.");
  }

  if (origin) {
    if (!allowedOrigins(row.allowed ?? []).has(origin)) {
      throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "This origin is not one of the environment's allowed redirect URLs. Add your app's URL under Integrations, Connect settings.");
    }
    allowOrigin(c, origin);
  }

  c.set("workspaceId", claims.ws);
  c.set("environmentId", claims.env);
  c.set("authType", "endUserSession");
  c.set("apiKeyId", claims.kid);
  c.set("endUserSession", claims);
  await next();
}

function allowedOrigins(urls: readonly string[]): Set<string> {
  const origins = new Set<string>();
  for (const url of urls) {
    try {
      origins.add(new URL(url).origin);
    } catch {
    }
  }
  return origins;
}

router.use("*", requireEndUserSession);
router.use("*", rateLimitByWorkspace);

const session = (c: Context) => c.get("endUserSession") as SessionClaims;
const scopeOf = (c: Context) => ({ workspaceId: session(c).ws, environmentId: session(c).env });
const actorOf = (c: Context): AuditActor => ({ type: "api_key", id: session(c).kid });

function requireCapability(capability: SessionCapability) {
  return async (c: Context, next: Next) => {
    if (!session(c).cap.includes(capability)) {
      throw new ApiError(403, "END_USER_SESSION_SCOPE", `This session cannot use ${capability}. The API key that created it needs the end-users:${capability === "approvals" ? "approvals" : "write"} scope.`);
    }
    await next();
  };
}

function integrationParam(c: Context): string {
  const integration = pathParam(c, "integration");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(integration)) throw new ValidationError("integration must be a catalogue id, e.g. gmail");
  return integration;
}

router.get("/connections", requireCapability("connections"), async (c: Context) => {
  const data = await listEndUserConnections(scopeOf(c), session(c).eu);
  return c.json({ success: true, data: data.map(sessionConnectionView) });
});

router.post("/connect-links", requireCapability("connections"), validateBody(createConnectLinkSchema), async (c: Context) => {
  const body = c.get("validatedBody") as { integration: string; redirectUrl?: string };
  const link = await createConnectLink(scopeOf(c), session(c).eu, body, { mcpServers: true });
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: { url: link.url, expiresAt: link.expiresAt, integration: link.integration } }, 201);
});

router.delete("/connections/:integration", requireCapability("connections"), async (c: Context) => {
  await deleteEndUserConnection(scopeOf(c), session(c).eu, integrationParam(c), actorOf(c));
  return c.json({ success: true, data: { deleted: true } });
});

router.get("/approvals", requireCapability("approvals"), validateQuery(sessionApprovalsQuerySchema), async (c: Context) => {
  const query = c.get("validatedQuery") as { status?: "pending" | "approved" | "denied" | "expired"; limit?: number; offset?: number };
  const limit = query.limit ?? 20;
  const offset = query.offset ?? 0;
  const { approvals, total } = await listEndUserApprovals(scopeOf(c), session(c).eu, { status: query.status, limit, offset });
  const data = await sessionApprovalViews(scopeOf(c), session(c).eu, approvals);
  return c.json({ success: true, ...buildPaginatedResponse(data, total, Math.floor(offset / limit) + 1, limit) });
});

router.get("/approvals/:approvalId", requireCapability("approvals"), async (c: Context) => {
  const approvalId = pathParam(c, "approvalId");
  const approval = await getApproval(scopeOf(c).workspaceId, approvalId, scopeOf(c).environmentId);
  if (approval.decider !== "end_user" || approval.endUserId !== session(c).eu) {
    throw new ApprovalNotFoundError(`Approval not found: ${approvalId}`);
  }
  const [data] = await sessionApprovalViews(scopeOf(c), session(c).eu, [approval]);
  return c.json({ success: true, data });
});

router.post("/approvals/:approvalId/decide", requireCapability("approvals"), validateBody(decideEndUserApprovalSchema), async (c: Context) => {
  const body = c.get("validatedBody") as { decision: "approve" | "deny"; reason?: string };
  const claims = session(c);
  const ctx = { deciderKeyId: claims.kid, deciderUserId: null, note: body.reason, endUserId: claims.eu, via: "end_user_session" as const };
  const decide = body.decision === "approve" ? approveApproval : denyApproval;
  const result = await decide(claims.ws, pathParam(c, "approvalId"), ctx, claims.env);
  const [approval] = await sessionApprovalViews(scopeOf(c), claims.eu, [result.approval]);
  return c.json({ success: true, data: { approval, ...(result.invocation ? { result: { status: result.invocation.status } } : {}) } });
});

export default router;
