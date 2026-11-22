import { requireVerifiedSender } from "../middleware/verified-sender.ts";
import { Hono, type Context } from "hono";
import { requireApiKey, requireApiKeyResourceScopes } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { haltGuard } from "../middleware/halt.ts";
import { validateBody, validateQuery } from "../middleware/validation.ts";
import { idempotencyMiddleware } from "../middleware/idempotency.ts";
import { budgetGuard } from "../middleware/budget.ts";
import { requireSecretReferenceAuthority } from "../middleware/secret-reference.ts";
import {
  createSubscriptionSchema,
  createTopicSchema,
  listEventsQuerySchema,
  publishEventSchema,
  updateSubscriptionSchema,
  updateTopicSchema,
} from "../../utils/validation.ts";
import {
  createSubscription,
  createTopic,
  deleteSubscription,
  deleteTopic,
  getEventWithDeliveries,
  getTopic,
  listEvents,
  listSubscriptions,
  listTopics,
  publishEvent,
  rotateSubscriptionSecret,
  updateSubscription,
  updateTopic,
} from "../../core/events/service.ts";
import { buildPaginatedResponse } from "../../utils/pagination.ts";
import { getRunWithTree } from "../../core/runs/service.ts";
import { ApiError } from "../../utils/errors.ts";
import { pathParam } from "../params.ts";

const eventsRouter = new Hono();

eventsRouter.use("*", requireApiKey);
eventsRouter.use("*", requireApiKeyResourceScopes("events:read", "events:write"));
eventsRouter.use("*", rateLimitByWorkspace);
eventsRouter.use("*", haltGuard("intake"));
eventsRouter.use("*", idempotencyMiddleware);

eventsRouter.get("/topics", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const topics = await listTopics(workspaceId, c.get("environmentId") as string | undefined);
  return c.json({ success: true, data: topics });
});

eventsRouter.post("/topics", validateBody(createTopicSchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const environmentId = c.get("environmentId") as string | undefined;
  const body = c.get("validatedBody");
  const topic = await createTopic(workspaceId, body, environmentId);
  return c.json({ success: true, data: topic }, 201);
});

eventsRouter.get("/topics/:ref", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const topic = await getTopic(workspaceId, pathParam(c, "ref"), c.get("environmentId") as string | undefined);
  return c.json({ success: true, data: topic });
});

eventsRouter.patch("/topics/:ref", validateBody(updateTopicSchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const environmentId = c.get("environmentId") as string | undefined;
  const body = c.get("validatedBody");
  const topic = await updateTopic(workspaceId, pathParam(c, "ref"), body, environmentId);
  return c.json({ success: true, data: topic });
});

eventsRouter.delete("/topics/:ref", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  await deleteTopic(workspaceId, pathParam(c, "ref"), c.get("environmentId") as string | undefined);
  return c.json({ success: true, data: { deleted: true } });
});

eventsRouter.get("/topics/:ref/subscriptions", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const subscriptions = await listSubscriptions(workspaceId, pathParam(c, "ref"), c.get("environmentId") as string | undefined);
  return c.json({ success: true, data: subscriptions });
});

eventsRouter.post(
  "/topics/:ref/subscriptions",
  validateBody(createSubscriptionSchema),
  requireSecretReferenceAuthority((b) => [b as { headers?: Record<string, unknown> | null }]),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const environmentId = c.get("environmentId") as string | undefined;
    const body = c.get("validatedBody");
    const subscription = await createSubscription(workspaceId, pathParam(c, "ref"), body, environmentId);
    return c.json({ success: true, data: subscription }, 201);
  }
);

eventsRouter.patch(
  "/subscriptions/:subscriptionId",
  validateBody(updateSubscriptionSchema),
  requireSecretReferenceAuthority((b) => [b as { headers?: Record<string, unknown> | null }]),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const environmentId = c.get("environmentId") as string | undefined;
    const body = c.get("validatedBody");
    const subscription = await updateSubscription(
      workspaceId,
      pathParam(c, "subscriptionId"),
      body,
      environmentId
    );
    return c.json({ success: true, data: subscription });
  }
);

eventsRouter.delete("/subscriptions/:subscriptionId", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  await deleteSubscription(workspaceId, pathParam(c, "subscriptionId"), c.get("environmentId") as string | undefined);
  return c.json({ success: true, data: { deleted: true } });
});

eventsRouter.post("/subscriptions/:subscriptionId/rotate-secret", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const result = await rotateSubscriptionSecret(workspaceId, pathParam(c, "subscriptionId"), c.get("environmentId") as string | undefined);
  return c.json({ success: true, data: result });
});

eventsRouter.post("/", requireVerifiedSender, validateBody(publishEventSchema), budgetGuard("eventPublishes"), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const body = c.get("validatedBody");
  const environmentId = c.get("environmentId") as string | undefined;
  if (body.runId) {
    if (!environmentId) {
      throw new ApiError(400, "TRACE_CONTEXT_REQUIRES_ENVIRONMENT", "Event trace context requires an environment-scoped API key");
    }
    await getRunWithTree({ workspaceId, environmentId }, body.runId);
  }
  const result = await publishEvent(workspaceId, body, {
    traceRunId: body.runId,
    traceParentSpanId: body.parentSpanId,
    environmentId,
  });
  return c.json({ success: true, data: result }, result.deduplicated ? 200 : 202);
});

eventsRouter.get("/", validateQuery(listEventsQuerySchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const { topic, type, limit, offset } = c.get("validatedQuery");
  const page = Math.floor((offset ?? 0) / (limit ?? 20)) + 1;
  const { events, total } = await listEvents(workspaceId, { topic, type, limit, offset, environmentId: c.get("environmentId") as string | undefined });
  return c.json({ success: true, ...buildPaginatedResponse(events, total, page, limit ?? 20) });
});

eventsRouter.get("/:eventId", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const event = await getEventWithDeliveries(workspaceId, pathParam(c, "eventId"), c.get("environmentId") as string | undefined);
  return c.json({ success: true, data: event });
});

export default eventsRouter;
