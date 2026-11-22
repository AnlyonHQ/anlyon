import { Hono, type Context } from "hono";
import { requireApiKey, requireApiKeyScope, requirePermission } from "../middleware/auth.ts";
import { requireCostAdmission } from "../middleware/expensive-work.ts";
import { requireFeature } from "../middleware/feature-gate.ts";
import { haltGuard } from "../middleware/halt.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody } from "../middleware/validation.ts";
import { analyzeFunctionSourceSchema, createFunctionSchema, publishFunctionVersionSchema, runFunctionSchema } from "../../utils/validation.ts";
import { analyzeSource } from "../../core/functions/analysis.ts";
import { archiveFunction, createFunction, getVersion, listFunctions, listVersions, publishVersion } from "../../core/functions/service.ts";
import { getRun, listRuns, MAX_LISTED_RUNS, startRun } from "../../core/functions/runs.ts";
import { FunctionRunNotFoundError } from "../../core/functions/errors.ts";
import { handleFunctionCall, MAX_CALL_BODY_BYTES } from "../../core/functions/calls.ts";
import { bearerToken } from "../../core/functions/run-token.ts";
import { RUNNER_SIGNATURE_HEADER } from "../../core/functions/runner-signing.ts";
import { auditCaller, auditRequest } from "../audit-caller.ts";
import { assertOwnEndUser, listedEndUser, requireEndUserWhenRequired } from "../end-user-context.ts";
import { ValidationError } from "../../utils/errors.ts";
import { sessionRequester } from "../policy-actor.ts";
import { pathParam } from "../params.ts";
import { env } from "../../config/env.ts";

const runnerConfigured = () => Boolean(env.FUNCTION_RUNNER_URL);

const functionsRouter = new Hono();
functionsRouter.use("*", requireFeature("functions", runnerConfigured));
functionsRouter.use("*", requireApiKey);
functionsRouter.use("*", rateLimitByWorkspace);
functionsRouter.use("*", haltGuard("external"));

const scopeOf = (c: Context) => ({ workspaceId: c.get("workspaceId") as string, environmentId: c.get("environmentId") as string });
const publisherOf = (c: Context) => ({
  keyId: c.get("authType") === "apiKey" ? ((c.get("apiKeyId") as string | undefined) ?? null) : null,
  userId: (c.get("userId") as string | undefined) ?? null,
});

functionsRouter.post(
  "/",
  requireApiKeyScope("functions:write"),
  requirePermission("actions.manage"),
  validateBody(createFunctionSchema),
  async (c: Context) => {
    const body = c.get("validatedBody") as { name: string; description?: string };
    const created = await createFunction(scopeOf(c), body);
    auditRequest(c, {
      ...scopeOf(c),
      type: "function.created",
      resource: { type: "function", id: created.id },
      data: { functionName: created.name },
    });
    return c.json({ success: true, data: created }, 201);
  },
);

functionsRouter.delete(
  "/:name",
  requireApiKeyScope("functions:write"),
  requirePermission("actions.manage"),
  async (c: Context) => {
    const archived = await archiveFunction(scopeOf(c), pathParam(c, "name"));
    auditRequest(c, {
      ...scopeOf(c),
      type: "function.deleted",
      resource: { type: "function", id: archived.id },
      data: { functionName: archived.name },
    });
    return c.json({ success: true, data: { deleted: true, id: archived.id, name: archived.name } });
  },
);

functionsRouter.get("/", requireApiKeyScope("functions:read"), async (c: Context) => {
  return c.json({ success: true, data: await listFunctions(scopeOf(c)) });
});

functionsRouter.post(
  "/analysis",
  requireApiKeyScope("functions:write"),
  requirePermission("actions.manage"),
  validateBody(analyzeFunctionSourceSchema),
  async (c: Context) => {
    const body = c.get("validatedBody") as { language: "javascript" | "python"; source: string };
    return c.json({ success: true, data: await analyzeSource(body.language, body.source) });
  },
);

functionsRouter.get("/:name/versions", requireApiKeyScope("functions:read"), async (c: Context) => {
  return c.json({ success: true, data: await listVersions(scopeOf(c), pathParam(c, "name")) });
});

functionsRouter.get("/:name/versions/:version", requireApiKeyScope("functions:read"), async (c: Context) => {
  const raw = pathParam(c, "version");
  if (raw !== "current" && !/^[1-9]\d{0,8}$/.test(raw)) {
    throw new ValidationError('The version is a number from 1, or "current".');
  }
  const version = raw === "current" ? "current" : Number(raw);
  return c.json({ success: true, data: await getVersion(scopeOf(c), pathParam(c, "name"), version) });
});

functionsRouter.get("/:name/runs", requireApiKeyScope("functions:read"), async (c: Context) => {
  const limitText = c.req.query("limit");
  if (limitText !== undefined && !/^\d{1,3}$/.test(limitText)) {
    throw new ValidationError(`limit is a whole number from 1 to ${MAX_LISTED_RUNS}.`);
  }
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (limit < 1 || limit > MAX_LISTED_RUNS)) {
    throw new ValidationError(`limit is a whole number from 1 to ${MAX_LISTED_RUNS}.`);
  }
  const endUserId = listedEndUser(c, c.req.query("endUserId") || undefined);
  const runs = await listRuns(scopeOf(c), pathParam(c, "name"), {
    ...(endUserId !== undefined ? { endUserId } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  return c.json({ success: true, data: runs });
});

functionsRouter.post(
  "/:name/versions",
  requireApiKeyScope("functions:write"),
  requirePermission("actions.manage"),
  validateBody(publishFunctionVersionSchema),
  async (c: Context) => {
    const published = await publishVersion(scopeOf(c), pathParam(c, "name"), c.get("validatedBody"), publisherOf(c));
    auditRequest(c, {
      ...scopeOf(c),
      type: "function.version_published",
      resource: { type: "function", id: published.function.id },
      data: {
        functionName: published.function.name,
        functionVersionId: published.version.id,
        version: published.version.version,
        language: published.version.language,
        digest: published.version.digest,
        allowedActions: published.version.allowedActions,
        budgets: published.version.budgets,
        straightThrough: published.version.straightThrough,
      },
    });
    return c.json({ success: true, data: published }, 201);
  },
);

functionsRouter.post(
  "/:name/runs",
  requireApiKeyScope("functions:run"),
  requireApiKeyScope("actions:invoke"),
  requirePermission("actions.invoke"),
  requireCostAdmission,
  validateBody(runFunctionSchema),
  async (c: Context) => {
    const body = c.get("validatedBody") as { input?: Record<string, unknown>; mode?: "plan" | "apply" | "straight_through"; planRunId?: string };
    const run = await startRun(scopeOf(c), pathParam(c, "name"), body.input, {
      mode: body.mode ?? "plan",
      ...(body.planRunId ? { planRunId: body.planRunId } : {}),
      endUser: requireEndUserWhenRequired(c),
      requestedByKeyId: c.get("authType") === "apiKey" ? ((c.get("apiKeyId") as string | undefined) ?? null) : null,
      requestedByUserId: sessionRequester(c) ?? null,
      actor: auditCaller(c).actor,
    });
    return c.json({ success: true, data: run }, 200);
  },
);

const functionRunsRouter = new Hono();
functionRunsRouter.use("*", requireFeature("functions", runnerConfigured));
functionRunsRouter.use("*", requireApiKey);
functionRunsRouter.use("*", rateLimitByWorkspace);

functionRunsRouter.get("/:id", requireApiKeyScope("functions:read"), async (c: Context) => {
  const id = pathParam(c, "id");
  const run = await getRun(scopeOf(c), id);
  assertOwnEndUser(c, run.endUserId, () => new FunctionRunNotFoundError(id));
  return c.json({ success: true, data: run });
});

const internalFunctionRunsRouter = new Hono();
internalFunctionRunsRouter.use("*", requireFeature("functions", runnerConfigured));
internalFunctionRunsRouter.post("/:runId/calls", async (c: Context) => {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_CALL_BODY_BYTES) {
    return c.json({ ok: false, error: { code: "INVALID_CALL", message: "The call is too large." } }, 413);
  }
  const body = await c.req.text();
  if (body.length > MAX_CALL_BODY_BYTES) {
    return c.json({ ok: false, error: { code: "INVALID_CALL", message: "The call is too large." } }, 413);
  }
  const answer = await handleFunctionCall({
    runId: pathParam(c, "runId"),
    token: bearerToken(c.req.header("authorization")),
    signature: c.req.header(RUNNER_SIGNATURE_HEADER) ?? null,
    path: `/api/internal/function-runs/${encodeURIComponent(pathParam(c, "runId"))}/calls`,
    body,
  });
  return c.json(answer.body, answer.status as 200);
});

export { functionRunsRouter, internalFunctionRunsRouter };
export default functionsRouter;
