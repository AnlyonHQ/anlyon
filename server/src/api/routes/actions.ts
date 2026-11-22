import { auditRequest } from "../audit-caller.ts";
import { requireCostAdmission } from "../middleware/expensive-work.ts";
import { Hono, type Context, type Next } from "hono";
import {
  callerAuthority,
  requireApiKey,
  requireApiKeyScope,
  requirePermission,
} from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody, validateQuery } from "../middleware/validation.ts";
import { idempotencyMiddleware } from "../middleware/idempotency.ts";
import { oauthPrincipal, policyActor, sessionRequester } from "../policy-actor.ts";
import { resolveInvocation } from "../../core/actions/resolution.ts";
import { budgetGuard } from "../middleware/budget.ts";
import { releaseUndispatchedActionBudget } from "../../core/billing/action-accounting.ts";
import { haltGuard } from "../middleware/halt.ts";
import {
  createActionSchema,
  importActionsSchema,
  invokeActionSchema,
  listInvocationsQuerySchema,
  resolveInvocationSchema,
  updateActionSchema,
  listEffectsQuerySchema,
  effectNoteSchema,
  resolveEffectSchema,
  createPreviewSchema,
  refreshPreviewSchema,
} from "../../utils/validation.ts";
import {
  addEffectNote,
  createPreviewForAction,
  getEffect,
  getPreview,
  listEffects,
  refreshPreview,
  replayEffectOperation,
  requestReconciliation,
  resolveEffectManually,
} from "../../core/effects/service.ts";
import {
  createAction,
  listActionVersions,
  deleteAction,
  getAction,
  getInvocation,
  invokeAction,
  replayInvocationForKey,
  type InvokeOutcome,
  listActions,
  listInvocations,
  updateAction,
} from "../../core/actions/service.ts";
import { importActionsFromOpenApi } from "../../core/actions/import.ts";
import { buildPaginatedResponse } from "../../utils/pagination.ts";
import { pathParam } from "../params.ts";
import { assertOwnEndUser, assertSameEndUser, listedEndUser, requireEndUserWhenRequired } from "../end-user-context.ts";
import { InvocationNotFoundError, NotFoundError } from "../../utils/errors.ts";
import { signOffIfLoosening } from "../governance-gate.ts";

const actionsRouter = new Hono();

actionsRouter.use("*", requireApiKey);
actionsRouter.use("*", rateLimitByWorkspace);
const RECOVERY_PATH = /\/effects\/[^/]+\/(reconcile|notes|resolve)$/;
const externalHalt = haltGuard("external");
actionsRouter.use("*", (c: Context, next: Next) => RECOVERY_PATH.test(c.req.path) ? next() : externalHalt(c, next));
actionsRouter.use("/:ref/invoke", async (c: Context, next: Next) => {
  if (c.req.method === "POST") c.set("idempotencyCurrentState", true);
  await next();
});
actionsRouter.use("*", idempotencyMiddleware);

actionsRouter.get(
  "/invocations",
  requireApiKeyScope("actions:read"),
  validateQuery(listInvocationsQuerySchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const environmentId = c.get("environmentId");
    const query = c.get("validatedQuery");
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const { invocations, total } = await listInvocations(workspaceId, {
      actionRef: query.action,
      status: query.status,
      endUserId: listedEndUser(c, query.endUserId),
      actingFor: query.actingFor,
      limit,
      offset,
      environmentId,
    });

    const page = Math.floor(offset / limit) + 1;
    return c.json({ success: true, ...buildPaginatedResponse(invocations, total, page, limit) });
  }
);

actionsRouter.get(
  "/invocations/:id",
  requireApiKeyScope("actions:read"),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const invocation = await getInvocation(workspaceId, pathParam(c, "id"), c.get("environmentId"));
    assertOwnEndUser(c, invocation.endUserId, () => new InvocationNotFoundError(pathParam(c, "id")));
    return c.json({ success: true, data: invocation });
  }
);

actionsRouter.post(
  "/invocations/:id/resolve",
  requireApiKeyScope("actions:resolve"),
  requirePermission("actions.resolve"),
  validateBody(resolveInvocationSchema),
  async (c: Context) => {
    const invocation = await resolveInvocation(
      c.get("workspaceId"),
      c.get("environmentId") as string,
      pathParam(c, "id"),
      c.get("validatedBody"),
      policyActor(c),
    );
    return c.json({ success: true, data: invocation });
  }
);

actionsRouter.get(
  "/effects",
  requireApiKeyScope("actions:read"),
  validateQuery(listEffectsQuerySchema),
  async (c: Context) => {
    const query = c.get("validatedQuery");
    const { effects, total, limit, offset } = await listEffects(c.get("workspaceId"), c.get("environmentId") as string, {
      ...query,
      endUserId: listedEndUser(c, query.endUserId),
    });
    const page = Math.floor(offset / limit) + 1;
    const response = buildPaginatedResponse(effects, total, page, limit);
    return c.json({ success: true, ...response, pagination: { ...response.pagination, hasMore: offset + effects.length < total } });
  }
);

actionsRouter.get("/effects/:id", requireApiKeyScope("actions:read"), async (c: Context) => {
  const effect = await getEffect(c.get("workspaceId"), c.get("environmentId") as string, pathParam(c, "id"));
  assertOwnEndUser(c, effect.endUserId, () => new NotFoundError("Effect"));
  return c.json({ success: true, data: effect });
});

actionsRouter.post("/effects/:id/reconcile", requireApiKeyScope("actions:invoke"), requirePermission("actions.invoke"), async (c: Context) => {
  const effect = await requestReconciliation(c.get("workspaceId"), c.get("environmentId") as string, pathParam(c, "id"));
  return c.json({ success: true, data: effect });
});

actionsRouter.post(
  "/effects/:id/notes",
  requireApiKeyScope("actions:resolve"),
  requirePermission("actions.resolve"),
  validateBody(effectNoteSchema),
  async (c: Context) => {
    const effect = await addEffectNote(c.get("workspaceId"), c.get("environmentId") as string, pathParam(c, "id"),
      c.get("validatedBody").note, policyActor(c));
    return c.json({ success: true, data: effect }, 201);
  }
);

actionsRouter.post(
  "/effects/:id/resolve",
  requireApiKeyScope("actions:resolve"),
  requirePermission("actions.resolve"),
  validateBody(resolveEffectSchema),
  async (c: Context) => {
    const effect = await resolveEffectManually(c.get("workspaceId"), c.get("environmentId") as string, pathParam(c, "id"),
      c.get("validatedBody"), policyActor(c));
    return c.json({ success: true, data: effect });
  }
);

actionsRouter.post(
  "/effects/:id/replay",
  requireApiKeyScope("actions:resolve"),
  requirePermission("actions.resolve"),
  async (c: Context) => {
    const effect = await replayEffectOperation(c.get("workspaceId"), c.get("environmentId") as string, pathParam(c, "id"), policyActor(c));
    return c.json({ success: true, data: effect });
  }
);

actionsRouter.get("/previews/:id", requireApiKeyScope("actions:read"), async (c: Context) => {
  const preview = await getPreview(c.get("workspaceId"), c.get("environmentId") as string, pathParam(c, "id"));
  assertSameEndUser(c, preview.endUserId, () => new NotFoundError("Preview"));
  return c.json({ success: true, data: preview });
});

actionsRouter.post(
  "/previews/:id/refresh",
  requireApiKeyScope("actions:invoke"),
  requirePermission("actions.invoke"),
  validateBody(refreshPreviewSchema),
  async (c: Context) => {
    const body = c.get("validatedBody");
    const old = await getPreview(c.get("workspaceId"), c.get("environmentId") as string, pathParam(c, "id"));
    assertSameEndUser(c, old.endUserId, () => new NotFoundError("Preview"));
    const preview = await refreshPreview(c.get("workspaceId"), c.get("environmentId") as string, pathParam(c, "id"), {
      requestedByKeyId: (c.get("apiKeyId") as string | undefined) ?? null,
      ttlSeconds: body.ttlSeconds,
    });
    return c.json({ success: true, data: preview }, 201);
  }
);

actionsRouter.post(
  "/import",
  requireApiKeyScope("actions:write"),
  requirePermission("actions.manage"),
  validateBody(importActionsSchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const environmentId = c.get("environmentId");
    const body = c.get("validatedBody");
    const pending = await signOffIfLoosening(c, "action.import", {}, body);
    if (pending) return pending;

    const result = await importActionsFromOpenApi(workspaceId, body.spec, {
      authority: callerAuthority(c),
      baseUrl: body.baseUrl,
      auth: body.auth,
      requiresApproval: body.requiresApproval,
      dryRun: body.dryRun,
      only: body.only,
      governed: body.governed,
      operations: body.operations,
      environmentId,
    });
    if (!result.dryRun) {
      for (const imported of result.created) {
        auditRequest(c, {
          workspaceId, environmentId, type: "action.definition.created", resource: { type: "action", id: imported.name },
          data: { actionName: imported.name, method: imported.method, urlTemplate: imported.urlTemplate, source: "openapi_import" },
        });
      }
    }

    return c.json({ success: true, data: result }, result.dryRun ? 200 : 201);
  }
);

actionsRouter.post(
  "/",
  requireApiKeyScope("actions:write"),
  requirePermission("actions.manage"),
  validateBody(createActionSchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const environmentId = c.get("environmentId");
    const body = c.get("validatedBody");
    const input = { ...body, urlTemplate: body.urlTemplate ?? "" };
    const pending = await signOffIfLoosening(c, "action.create", {}, input);
    if (pending) return pending;
    const action = await createAction(workspaceId, input, callerAuthority(c), environmentId);
    auditRequest(c, {
      workspaceId, environmentId, type: "action.definition.created", resource: { type: "action", id: action.id },
      data: actionAuditData(action),
    });
    return c.json({ success: true, data: action }, 201);
  }
);

actionsRouter.get("/", requireApiKeyScope("actions:read"), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const actions = await listActions(workspaceId, c.get("environmentId"));
  return c.json({ success: true, data: actions });
});

function invokeResponse(c: Context, { replayed, ...result }: InvokeOutcome) {
  if (replayed) {
    c.header("X-Idempotent-Replay", "current-state");
  }
  return c.json({ success: true, data: result }, result.pendingApproval ? 202 : 200);
}

async function replayDurableInvocation(c: Context, next: Next) {
  const key = c.get("idempotencyKey") as string | undefined;
  const fingerprint = c.get("idempotencyFingerprint") as string | undefined;
  const environmentId = c.get("environmentId") as string | undefined;
  if (key && fingerprint && environmentId) {
    const existing = await replayInvocationForKey(c.get("workspaceId"), environmentId, key, fingerprint);
    if (existing) return invokeResponse(c, existing);
  }
  const legacyResponse = c.get("idempotencyLegacyResponse") as Response | undefined;
  if (legacyResponse) return legacyResponse;
  await next();
}

actionsRouter.post(
  "/:ref/invoke",
  requireApiKeyScope("actions:invoke"),
  requirePermission("actions.invoke"),
  replayDurableInvocation,
  requireCostAdmission,
  validateBody(invokeActionSchema),
  budgetGuard("actionInvokes"),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const body = c.get("validatedBody");
    const keyId = c.get("apiKeyId") as string | undefined;
    const key = c.get("idempotencyKey") as string | undefined;
    const fingerprint = c.get("idempotencyFingerprint") as string | undefined;

    const result = await invokeAction(workspaceId, pathParam(c, "ref"), body.input ?? {}, {
      endUser: requireEndUserWhenRequired(c),
      requestedByKeyId: keyId || null,
      requestedByOAuth: oauthPrincipal(c) ?? null,
      requestedByUserId: sessionRequester(c) ?? null,
      environmentId: (c.get("environmentId") as string | undefined) || null,
      traceRunId: body.runId,
      traceParentSpanId: body.parentSpanId,
      budgetReservationId: c.get("budgetReservationId"),
      ...(key && fingerprint ? { idempotency: { key, fingerprint } } : {}),
      ...(body.retryOf ? { retryOf: body.retryOf } : {}),
      effect: {
        operationKey: body.operationKey,
        previewId: body.previewId,
        dependsOn: body.dependsOn,
        compensates: body.compensates,
      },
    });

    const reservationId = c.get("budgetReservationId") as string | undefined;
    if (result.replayed && reservationId) await releaseUndispatchedActionBudget(workspaceId, reservationId);

    return invokeResponse(c, result);
  }
);

actionsRouter.post(
  "/:ref/previews",
  requireApiKeyScope("actions:invoke"),
  requirePermission("actions.invoke"),
  validateBody(createPreviewSchema),
  async (c: Context) => {
    const body = c.get("validatedBody");
    const preview = await createPreviewForAction(c.get("workspaceId"), c.get("environmentId") as string, pathParam(c, "ref"),
      body.input ?? {}, {
        requestedByKeyId: (c.get("apiKeyId") as string | undefined) ?? null,
        ttlSeconds: body.ttlSeconds,
        runId: body.runId,
        endUserId: requireEndUserWhenRequired(c).endUserId,
      });
    return c.json({ success: true, data: preview }, 201);
  }
);

actionsRouter.get(
  "/:ref/invocations",
  requireApiKeyScope("actions:read"),
  validateQuery(listInvocationsQuerySchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const query = c.get("validatedQuery");
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const { invocations, total } = await listInvocations(workspaceId, {
      actionRef: pathParam(c, "ref"),
      status: query.status,
      endUserId: listedEndUser(c, query.endUserId),
      actingFor: query.actingFor,
      limit,
      offset,
      environmentId: c.get("environmentId"),
    });

    const page = Math.floor(offset / limit) + 1;
    return c.json({ success: true, ...buildPaginatedResponse(invocations, total, page, limit) });
  }
);

actionsRouter.get(
  "/:ref/versions",
  requireApiKeyScope("actions:read"),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const versions = await listActionVersions(
      workspaceId,
      pathParam(c, "ref"),
      c.get("environmentId"),
    );
    return c.json({ success: true, data: versions });
  },
);

actionsRouter.get("/:ref", requireApiKeyScope("actions:read"), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const action = await getAction(workspaceId, pathParam(c, "ref"), c.get("environmentId"));
  return c.json({ success: true, data: action });
});

actionsRouter.patch(
  "/:ref",
  requireApiKeyScope("actions:write"),
  requirePermission("actions.manage"),
  validateBody(updateActionSchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const environmentId = c.get("environmentId");
    const body = c.get("validatedBody");
    const pending = await signOffIfLoosening(c, "action.update", { ref: pathParam(c, "ref") }, body);
    if (pending) return pending;
    const action = await updateAction(workspaceId, pathParam(c, "ref"), body, callerAuthority(c), environmentId);
    auditRequest(c, {
      workspaceId, environmentId, type: "action.definition.updated", resource: { type: "action", id: action.id },
      data: { ...actionAuditData(action), changed: Object.keys(body) },
    });
    return c.json({ success: true, data: action });
  }
);

actionsRouter.delete("/:ref", requireApiKeyScope("actions:write"), requirePermission("actions.manage"), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  await deleteAction(workspaceId, pathParam(c, "ref"), callerAuthority(c), c.get("environmentId"));
  auditRequest(c, {
    workspaceId, environmentId: c.get("environmentId"), type: "action.definition.deleted",
    resource: { type: "action", id: pathParam(c, "ref") }, data: { actionRef: pathParam(c, "ref") },
  });
  return c.json({ success: true, data: { deleted: true } });
});

function actionAuditData(action: { id: string; name: string; method: string; urlTemplate: string; requiresApproval: boolean; enabled: boolean; currentVersionId: string | null }) {
  return {
    actionId: action.id, actionName: action.name, method: action.method, urlTemplate: action.urlTemplate,
    requiresApproval: action.requiresApproval, enabled: action.enabled, versionId: action.currentVersionId,
  };
}

export default actionsRouter;
