import { Hono, type Context } from "hono";
import { requireApiKey, requireApiKeyScope, requirePermission } from "../middleware/auth.ts";
import { requireFeature } from "../middleware/feature-gate.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody, validateQuery } from "../middleware/validation.ts";
import {
  confirmEndUserConnectionSchema,
  createConnectLinkSchema,
  createEndUserSessionSchema,
  decideEndUserApprovalSchema,
  listApprovalsQuerySchema,
  listEndUsersQuerySchema,
  setEndUserConnectionSchema,
} from "../../utils/validation.ts";
import { confirmConnection, createConnectLink } from "../../core/end-users/connect.ts";
import {
  deleteEndUserConnection,
  eraseEndUser,
  listEndUserConnections,
  listEndUsers,
  setEndUserApiKey,
} from "../../core/end-users/connections.ts";
import { approveApproval, cancelEndUserApprovals, denyApproval, listEndUserApprovals } from "../../core/approvals/service.ts";
import { mintSessionToken, sessionLifetimeSeconds, type SessionCapability } from "../../core/end-users/session-token.ts";
import { ApiError, ValidationError } from "../../utils/errors.ts";
import { buildPaginatedResponse } from "../../utils/pagination.ts";
import { auditCaller, auditRequest } from "../audit-caller.ts";
import { pathEndUser, requireEndUserWhenRequired } from "../end-user-context.ts";
import { pathParam } from "../params.ts";

const endUsersRouter = new Hono();

endUsersRouter.use("*", requireFeature("connected-accounts"));
endUsersRouter.use("*", requireApiKey);
endUsersRouter.use("*", rateLimitByWorkspace);

const scopeOf = (c: Context) => ({ workspaceId: c.get("workspaceId") as string, environmentId: c.get("environmentId") as string });

function integrationParam(c: Context): string {
  const integration = pathParam(c, "integration");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(integration)) throw new ValidationError("integration must be a catalogue id, e.g. gmail");
  return integration;
}

endUsersRouter.get("/", requireApiKeyScope("end-users:read"), validateQuery(listEndUsersQuerySchema), async (c: Context) => {
  const query = c.get("validatedQuery") as { cursor?: string; limit?: number; prefix?: string; integration?: string };
  const context = requireEndUserWhenRequired(c);
  const page = await listEndUsers(scopeOf(c), query);
  const data = context.required ? page.endUsers.filter((u) => u.endUserId === context.endUserId) : page.endUsers;
  return c.json({ success: true, data, pagination: { nextCursor: context.required ? null : page.nextCursor } });
});

endUsersRouter.get("/:endUserId/connections", requireApiKeyScope("end-users:read"), async (c: Context) => {
  const data = await listEndUserConnections(scopeOf(c), pathEndUser(c));
  return c.json({ success: true, data });
});

endUsersRouter.post(
  "/:endUserId/connect-links",
  requireApiKeyScope("end-users:write"),
  requirePermission("connections.manage"),
  validateBody(createConnectLinkSchema),
  async (c: Context) => {
    const body = c.get("validatedBody") as { integration: string; redirectUrl?: string };
    const link = await createConnectLink(scopeOf(c), pathEndUser(c), body);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: { url: link.url, expiresAt: link.expiresAt, integration: link.integration } }, 201);
  },
);

endUsersRouter.post(
  "/:endUserId/connections/confirm",
  requireApiKeyScope("end-users:write"),
  requirePermission("connections.manage"),
  validateBody(confirmEndUserConnectionSchema),
  async (c: Context) => {
    const body = c.get("validatedBody") as { flowId: string };
    const data = await confirmConnection(scopeOf(c), pathEndUser(c), body.flowId, auditCaller(c).actor);
    return c.json({ success: true, data });
  },
);

endUsersRouter.put(
  "/:endUserId/connections/:integration",
  requireApiKeyScope("end-users:write"),
  requirePermission("connections.manage"),
  validateBody(setEndUserConnectionSchema),
  async (c: Context) => {
    const body = c.get("validatedBody") as { token?: string; fields?: Record<string, string> };
    const given = body.fields ? { fields: body.fields } : (body.token as string);
    const data = await setEndUserApiKey(scopeOf(c), pathEndUser(c), integrationParam(c), given, auditCaller(c).actor);
    return c.json({ success: true, data });
  },
);

endUsersRouter.delete(
  "/:endUserId/connections/:integration",
  requireApiKeyScope("end-users:write"),
  requirePermission("connections.manage"),
  async (c: Context) => {
    await deleteEndUserConnection(scopeOf(c), pathEndUser(c), integrationParam(c), auditCaller(c).actor);
    return c.json({ success: true, data: { deleted: true } });
  },
);

endUsersRouter.get(
  "/:endUserId/approvals",
  requireApiKeyScope("end-users:approvals"),
  validateQuery(listApprovalsQuerySchema),
  async (c: Context) => {
    const query = c.get("validatedQuery") as { status?: "pending" | "approved" | "denied" | "expired"; limit?: number; offset?: number };
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const { approvals, total } = await listEndUserApprovals(scopeOf(c), pathEndUser(c), { status: query.status, limit, offset });
    const page = Math.floor(offset / limit) + 1;
    return c.json({ success: true, ...buildPaginatedResponse(approvals, total, page, limit) });
  },
);

endUsersRouter.post(
  "/:endUserId/approvals/:approvalId/decide",
  requireApiKeyScope("end-users:approvals"),
  requirePermission("approvals.decide"),
  validateBody(decideEndUserApprovalSchema),
  async (c: Context) => {
    const endUserId = pathEndUser(c);
    const body = c.get("validatedBody") as { decision: "approve" | "deny"; reason?: string };
    const ctx = {
      deciderKeyId: (c.get("apiKeyId") as string | undefined) || null,
      deciderUserId: (c.get("userId") as string | undefined) || null,
      note: body.reason,
      endUserId,
    };
    const decide = body.decision === "approve" ? approveApproval : denyApproval;
    const result = await decide(c.get("workspaceId"), pathParam(c, "approvalId"), ctx, c.get("environmentId") as string);
    return c.json({ success: true, data: { approval: result.approval, ...(result.invocation ? { invocation: result.invocation } : {}) } });
  },
);

endUsersRouter.post(
  "/:endUserId/sessions",
  requireApiKeyScope("end-users:write"),
  validateBody(createEndUserSessionSchema),
  async (c: Context) => {
    const keyId = c.get("apiKeyId") as string | undefined;
    if (c.get("authType") !== "apiKey" || !keyId) {
      throw new ApiError(403, "END_USER_SESSION_API_KEY_REQUIRED", "End-user session tokens are created by your server with an API key.");
    }
    const endUserId = pathEndUser(c);
    const body = c.get("validatedBody") as { ttlSeconds?: number };
    const scopes = (c.get("apiKeyScopes") ?? []) as string[];
    const capabilities: SessionCapability[] = scopes.includes("end-users:approvals") ? ["connections", "approvals"] : ["connections"];
    const lifetime = sessionLifetimeSeconds(body.ttlSeconds, (c.get("credentialExpiresAt") as Date | null | undefined) ?? null);
    if (lifetime < 1) throw new ApiError(400, "API_KEY_EXPIRING", "This API key expires too soon to create a session.");
    const { workspaceId, environmentId } = scopeOf(c);
    const { token, expiresAt } = mintSessionToken({ workspaceId, environmentId, endUserId, keyId, capabilities }, lifetime);
    auditRequest(c, {
      workspaceId, environmentId, endUserId, type: "end_user.session_created",
      resource: { type: "end_user", id: endUserId }, data: { expiresAt: expiresAt.toISOString(), capabilities },
    });
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: { token, expiresAt, endUserId, capabilities } }, 201);
  },
);

endUsersRouter.delete(
  "/:endUserId",
  requireApiKeyScope("end-users:write"),
  requirePermission("connections.manage"),
  async (c: Context) => {
    const data = await eraseEndUser(scopeOf(c), pathEndUser(c), auditCaller(c).actor, cancelEndUserApprovals);
    return c.json({ success: true, data });
  },
);

export default endUsersRouter;
