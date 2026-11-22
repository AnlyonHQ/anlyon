import { Hono, type Context } from "hono";
import { requireApiKey, requireApiKeyResourceScopes } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody, validateQuery } from "../middleware/validation.ts";
import { idempotencyMiddleware } from "../middleware/idempotency.ts";
import {
  startRunSchema,
  endRunSchema,
  ingestSpansSchema,
  importOtlpTraceSchema,
  listRunsQuerySchema,
  addFeedbackSchema,
} from "../../utils/validation.ts";
import {
  startRun,
  endRun,
  ingestSpans,
  listRuns,
  getRunWithTree,
  exportRunAsOtlp,
  importOtlpTrace,
  addFeedback,
  listFeedback,
  type Scope,
  type ReadScope,
} from "../../core/runs/service.ts";
import { ValidationError } from "../../utils/errors.ts";
import { pathParam } from "../params.ts";

const runsRouter = new Hono();

runsRouter.use("*", requireApiKey);
runsRouter.use("*", requireApiKeyResourceScopes("runs:read", "runs:write"));
runsRouter.use("*", rateLimitByWorkspace);
runsRouter.use("*", idempotencyMiddleware);

function writeScope(c: Context): Scope {
  const environmentId = c.get("environmentId") as string | undefined;
  if (!environmentId) {
    throw new ValidationError("Writing runs requires an environment-scoped API key.");
  }
  return { workspaceId: c.get("workspaceId") as string, environmentId };
}

function readScope(c: Context): ReadScope {
  return {
    workspaceId: c.get("workspaceId") as string,
    environmentId: (c.get("environmentId") as string | undefined) ?? c.req.query("environmentId") ?? null,
  };
}

runsRouter.post("/", validateBody(startRunSchema), async (c: Context) => {
  const input = c.get("validatedBody");
  const run = await startRun(writeScope(c), {
    ...input,
    metadata: { ...(input.metadata ?? {}), requestId: c.get("requestId") as string },
  });
  return c.json({ success: true, data: run }, 201);
});

runsRouter.get("/", validateQuery(listRunsQuerySchema), async (c: Context) => {
  const q = c.get("validatedQuery");
  const { runs, total } = await listRuns(readScope(c), {
	search: q.search,
    status: q.status,
    agentId: q.agentId,
    userId: q.userId,
    startedAfter: q.startedAfter ? new Date(q.startedAfter) : undefined,
    startedBefore: q.startedBefore ? new Date(q.startedBefore) : undefined,
    limit: q.limit,
    offset: q.offset,
  });
  return c.json({
    success: true,
    data: runs,
    pagination: { total, limit: q.limit, offset: q.offset, hasMore: q.offset + runs.length < total },
  });
});

runsRouter.get("/:runId", async (c: Context) => {
  const { run, spans } = await getRunWithTree(readScope(c), pathParam(c, "runId"));
  return c.json({ success: true, data: { ...run, spans } });
});

runsRouter.get("/:runId/export", async (c: Context) => {
  const scope = readScope(c);
  const runId = pathParam(c, "runId");
  const [{ run, spans }, feedback] = await Promise.all([
    getRunWithTree(scope, runId),
    listFeedback(scope, runId),
  ]);
  return c.json({ success: true, data: exportRunAsOtlp(run, spans, feedback) });
});

runsRouter.post("/import", validateBody(importOtlpTraceSchema), async (c: Context) => {
  const run = await importOtlpTrace(writeScope(c), c.get("validatedBody"));
  return c.json({ success: true, data: run }, 201);
});

runsRouter.patch("/:runId", validateBody(endRunSchema), async (c: Context) => {
  const run = await endRun(writeScope(c), pathParam(c, "runId"), c.get("validatedBody"));
  return c.json({ success: true, data: run });
});

runsRouter.post("/:runId/spans", validateBody(ingestSpansSchema), async (c: Context) => {
  const { spans } = c.get("validatedBody");
  const requestId = c.get("requestId") as string;
  const result = await ingestSpans(writeScope(c), pathParam(c, "runId"), spans.map((span: Record<string, unknown>) => ({
    ...span,
    attributes: { ...((span.attributes as Record<string, unknown> | undefined) ?? {}), requestId },
  })));
  return c.json({ success: true, data: result });
});

runsRouter.post("/:runId/feedback", validateBody(addFeedbackSchema), async (c: Context) => {
  const userId = c.get("userId") as string | undefined;
  const feedback = await addFeedback(
    writeScope(c),
    pathParam(c, "runId"),
    c.get("validatedBody"),
    userId ?? null,
  );
  return c.json({ success: true, data: feedback }, 201);
});

runsRouter.get("/:runId/feedback", async (c: Context) => {
  const feedback = await listFeedback(readScope(c), pathParam(c, "runId"));
  return c.json({ success: true, data: feedback });
});

export default runsRouter;
