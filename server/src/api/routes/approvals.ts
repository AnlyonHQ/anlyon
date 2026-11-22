import { Hono, type Context } from "hono";
import { assertScope, requireApiKey, requireApiKeyScope, requirePermission } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody, validateQuery } from "../middleware/validation.ts";
import { idempotencyMiddleware } from "../middleware/idempotency.ts";
import {
  createApprovalSchema,
  decideApprovalSchema,
  getApprovalQuerySchema,
  listApprovalsQuerySchema,
} from "../../utils/validation.ts";
import {
  approveApproval,
  createApproval,
  denyApproval,
  getApproval,
  listApprovals,
  waitForApproval,
} from "../../core/approvals/service.ts";
import { buildPaginatedResponse } from "../../utils/pagination.ts";
import { ApiError, ApprovalNotFoundError } from "../../utils/errors.ts";
import { assertOwnEndUser, listedEndUser } from "../end-user-context.ts";
import { getRunWithTree } from "../../core/runs/service.ts";
import { adviceByPublicId } from "../../core/assistant/service.ts";
import { oauthPrincipal, sessionRequester } from "../policy-actor.ts";
import { pathParam } from "../params.ts";

async function withAdvice<T extends { id: string }>(c: Context, items: T[]): Promise<Array<T & { advice?: unknown }>> {
  if (c.get("authType") !== "session" || items.length === 0) return items;
  const advice = await adviceByPublicId(c.get("workspaceId"), items.map((item) => item.id));
  return items.map((item) => (advice.has(item.id) ? { ...item, advice: advice.get(item.id) } : item));
}

const approvalsRouter = new Hono();

approvalsRouter.use("*", requireApiKey);
approvalsRouter.use("*", rateLimitByWorkspace);
approvalsRouter.use("*", idempotencyMiddleware);

approvalsRouter.post(
  "/",
  requireApiKeyScope("approvals:write"),
  requirePermission("approvals.request"),
  validateBody(createApprovalSchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const body = c.get("validatedBody");
    const keyId = c.get("apiKeyId") as string | undefined;
    const environmentId = (c.get("environmentId") as string | undefined) || null;

    if (body.runId) {
      if (!environmentId) {
        throw new ApiError(400, "TRACE_CONTEXT_REQUIRES_ENVIRONMENT", "Approval trace context requires an environment-scoped API key");
      }
      await getRunWithTree({ workspaceId, environmentId }, body.runId);
    }

    const approval = await createApproval(workspaceId, body, {
      requestedByKeyId: keyId || null,
      requestedByOAuth: oauthPrincipal(c) ?? null,
      requestedByUserId: sessionRequester(c) ?? null,
      environmentId,
      traceRunId: body.runId,
      traceParentSpanId: body.parentSpanId,
    });
    return c.json({ success: true, data: approval }, 201);
  }
);

approvalsRouter.get(
  "/",
  requireApiKeyScope("approvals:read"),
  validateQuery(listApprovalsQuerySchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const query = c.get("validatedQuery");
    if (query.decider === "end_user") assertScope(c, "end-users:approvals");
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const { approvals, total } = await listApprovals(workspaceId, {
      status: query.status,
      decisionOrigin: query.decisionOrigin,
      endUserId: listedEndUser(c, query.endUserId),
      actingFor: query.actingFor,
      decider: query.decider,
      limit,
      offset,
      environmentId: c.get("environmentId"),
    });

    const page = Math.floor(offset / limit) + 1;
    return c.json({ success: true, ...buildPaginatedResponse(await withAdvice(c, approvals), total, page, limit) });
  }
);

approvalsRouter.get(
  "/:id",
  requireApiKeyScope("approvals:read"),
  validateQuery(getApprovalQuerySchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const { waitSeconds } = c.get("validatedQuery");
    const approvalId = pathParam(c, "id");

    const approval =
      waitSeconds && waitSeconds > 0
        ? await waitForApproval(workspaceId, approvalId, waitSeconds, c.get("environmentId"))
        : await getApproval(workspaceId, approvalId, c.get("environmentId"));
    assertOwnEndUser(c, approval.endUserId, () => new ApprovalNotFoundError(`Approval not found: ${approvalId}`));

    const [data] = await withAdvice(c, [approval]);
    return c.json({ success: true, data });
  }
);

approvalsRouter.post(
  "/:id/approve",
  requireApiKeyScope("approvals:decide"),
  requirePermission("approvals.decide"),
  validateBody(decideApprovalSchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const body = c.get("validatedBody");

    const result = await approveApproval(workspaceId, pathParam(c, "id"), {
      deciderKeyId: (c.get("apiKeyId") as string | undefined) || null,
      deciderUserId: (c.get("userId") as string | undefined) || null,
      deciderOAuthClientId: oauthPrincipal(c)?.clientId ?? null,
      note: body.note,
    }, c.get("environmentId"));

    return c.json({ success: true, data: result });
  }
);

approvalsRouter.post(
  "/:id/deny",
  requireApiKeyScope("approvals:decide"),
  requirePermission("approvals.decide"),
  validateBody(decideApprovalSchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const body = c.get("validatedBody");

    const result = await denyApproval(workspaceId, pathParam(c, "id"), {
      deciderKeyId: (c.get("apiKeyId") as string | undefined) || null,
      deciderUserId: (c.get("userId") as string | undefined) || null,
      deciderOAuthClientId: oauthPrincipal(c)?.clientId ?? null,
      note: body.note,
    }, c.get("environmentId"));

    return c.json({ success: true, data: result });
  }
);

export default approvalsRouter;
