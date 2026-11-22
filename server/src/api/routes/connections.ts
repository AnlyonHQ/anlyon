import { Hono, type Context } from "hono";
import { requireApiKey, requireApiKeyResourceScopes, requirePermissionForWrites } from "../middleware/auth.ts";
import { requireFeature } from "../middleware/feature-gate.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody, validateQuery } from "../middleware/validation.ts";
import { completeConnectSessionSchema, connectWithKeySchema, createConnectSessionSchema, findIntegrationRouteQuerySchema, reconnectConnectionSchema, secretNameSchema } from "../../utils/validation.ts";
import { availableIntegrations, checkConnection, completeSession, connectWithKey, listConnections, reconnect, startSession } from "../../core/connections/service.ts";
import { requireConnectionProvider } from "../../core/connections/provider.ts";
import { findIntegrationRoute } from "../../core/connections/integration-route.ts";
import { integrationsOverview } from "../../core/connections/overview.ts";
import { env } from "../../config/env.ts";
import { ValidationError } from "../../utils/errors.ts";
import { resolveEnvironmentId } from "./environment-context.ts";
import { pathParam } from "../params.ts";

const connectionsRouter = new Hono();

connectionsRouter.use("*", requireFeature("connected-accounts"));
connectionsRouter.use("*", requireApiKey);
connectionsRouter.get("/integrations/find", rateLimitByWorkspace, validateQuery(findIntegrationRouteQuerySchema), async (c: Context) => {
  const { name } = c.get("validatedQuery") as { name: string };
  return c.json({ success: true, data: findIntegrationRoute(name, { consoleUrl: env.CONSOLE_URL }) });
});
connectionsRouter.use("*", requireApiKeyResourceScopes("secrets:read", "secrets:write"));
connectionsRouter.use("*", requirePermissionForWrites("connections.manage"));
connectionsRouter.use("*", rateLimitByWorkspace);
connectionsRouter.use("/sessions/*", async (_c, next) => {
  requireConnectionProvider();
  await next();
});
connectionsRouter.use("/sessions", async (_c, next) => {
  requireConnectionProvider();
  await next();
});

connectionsRouter.get("/integrations", async (c: Context) => {
  return c.json({ success: true, data: availableIntegrations() });
});

connectionsRouter.get("/overview", async (c: Context) => {
  const data = await integrationsOverview({ workspaceId: c.get("workspaceId"), environmentId: await resolveEnvironmentId(c) });
  return c.json({ success: true, data });
});

connectionsRouter.get("/", async (c: Context) => {
  const data = await listConnections(c.get("workspaceId"), await resolveEnvironmentId(c));
  return c.json({ success: true, data });
});

connectionsRouter.post("/keys", validateBody(connectWithKeySchema), async (c: Context) => {
  const body = c.get("validatedBody");
  const secret = await connectWithKey({ workspaceId: c.get("workspaceId"), environmentId: await resolveEnvironmentId(c) }, body);
  return c.json({ success: true, data: secret }, 201);
});

connectionsRouter.post("/sessions", validateBody(createConnectSessionSchema), async (c: Context) => {
  const body = c.get("validatedBody");
  const session = await startSession({
    workspaceId: c.get("workspaceId"),
    environmentId: await resolveEnvironmentId(c),
    userId: c.get("userId") ?? null,
    apiKeyId: c.get("apiKeyId") ?? null,
  }, body);
  return c.json({ success: true, data: session }, 201);
});

function requireSecretName(c: Context): string {
  const parsed = secretNameSchema.safeParse(pathParam(c, "secretName"));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid secret name");
  return parsed.data;
}

connectionsRouter.post("/:secretName/check", async (c: Context) => {
  const secret = await checkConnection({ workspaceId: c.get("workspaceId"), environmentId: await resolveEnvironmentId(c) }, requireSecretName(c));
  return c.json({ success: true, data: secret });
});

connectionsRouter.post("/:secretName/reconnect", validateBody(reconnectConnectionSchema), async (c: Context) => {
  const body = c.get("validatedBody") as { apiKey?: string; fields?: Record<string, string> };
  const result = await reconnect({
    workspaceId: c.get("workspaceId"),
    environmentId: await resolveEnvironmentId(c),
    userId: c.get("userId") ?? null,
    apiKeyId: c.get("apiKeyId") ?? null,
  }, requireSecretName(c), body);
  return c.json({ success: true, data: result });
});

connectionsRouter.post("/sessions/:sessionId/complete", validateBody(completeConnectSessionSchema), async (c: Context) => {
  const body = c.get("validatedBody") as { reference?: string };
  const result = await completeSession(
    { workspaceId: c.get("workspaceId"), environmentId: await resolveEnvironmentId(c) },
    c.req.param("sessionId") ?? "",
    body.reference,
  );
  return c.json({ success: true, data: result });
});

export default connectionsRouter;
