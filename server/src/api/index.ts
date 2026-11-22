import { Hono } from "hono";
import { auth } from "../utils/auth.ts";

import { errorHandler, buildErrorResponse } from "./middleware/error.ts";
import { requestLogger } from "./middleware/logger.ts";
import { requestId } from "./middleware/request-id.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { enforceHttps, bodySizeLimit } from "./middleware/security.ts";
import { rateLimitByIp, rateLimitByIpAllowing, rateLimitFailedAuthByIp } from "./middleware/rateLimit.ts";
import { env } from "../config/env.ts";

import health from "./routes/health.ts";
import workspaces from "./routes/workspaces.ts";
import dlq from "./routes/dlq.ts";
import analytics from "./routes/analytics.ts";
import members from "./routes/members.ts";
import publicSandboxRouter, { rateLimitPublic } from "./routes/public-sandbox.ts";
import mcpVendorsRouter from "./routes/mcp-vendors.ts";
import sandboxRouter from "./routes/sandbox.ts";
import notificationsRouter from "./routes/notifications.ts";
import integrationsRouter from "./routes/integrations.ts";
import invitationsRouter, { publicInvitationsRouter } from "./routes/invitations.ts";
import logsRouter from "./routes/logs.ts";
import metricsRouter from "./routes/metrics.ts";
import eventsRouter from "./routes/events.ts";
import runsRouter from "./routes/runs.ts";
import streamRouter from "./routes/stream.ts";
import secretsRouter from "./routes/secrets.ts";
import secretStoresRouter, { secretStoreSettingsRouter } from "./routes/secret-stores.ts";
import connectionsRouter from "./routes/connections.ts";
import endUsersRouter from "./routes/end-users.ts";
import endUserSessionRouter from "./routes/end-user-session.ts";
import functionsRouter, { functionRunsRouter, internalFunctionRunsRouter } from "./routes/functions.ts";
import environmentOAuthAppsRouter from "./routes/environment-oauth-apps.ts";
import connectionConsentRouter, { connectPagesRouter } from "./routes/connection-consent.ts";
import { connectPagesHostGate } from "./connect-host.ts";
import actionsRouter from "./routes/actions.ts";
import mcpUpstreamsRouter from "./routes/mcp-upstreams.ts";
import approvalsRouter from "./routes/approvals.ts";
import approvalPoliciesRouter from "./routes/approval-policies.ts";
import authIdentityRouter from "./routes/auth-identity.ts";
import budgetsRouter from "./routes/budgets.ts";
import agentApiKeysRouter from "./routes/agent-api-keys.ts";
import impactLimitsRouter from "./routes/impact-limits.ts";
import environmentRouter from "./routes/environment.ts";
import oauthMetadataRouter from "./routes/oauth-metadata.ts";
import mcpRouter from "./routes/mcp.ts";
import oauthWorkspaceRouter from "./routes/oauth-workspace.ts";
import selfHostedPlanRouter from "./routes/self-hosted-plan.ts";
import editionRouter from "./routes/edition.ts";
import instanceRouter from "./routes/instance.ts";
import setupRouter from "./routes/setup.ts";
import { mountModule } from "./mount-module.ts";
import { bindExtensionRoutes } from "../core/extensions/registry.ts";
import identityRouter from "./routes/sso.ts";
import scimRouter from "./routes/scim.ts";
import { auditConsoleRouter, auditRouter } from "./routes/audit.ts";
import { slackApprovalsRouter, slackPublicRouter } from "./routes/slack-approvals.ts";
import { signOffLinksRouter, signOffsConsoleRouter, signOffsRouter } from "./routes/sign-offs.ts";
import { serveStatic } from "@hono/node-server/serve-static";

const app = new Hono<{ Variables: { requestId: string } }>({ strict: false });

app.use("*", corsMiddleware);
app.use("*", requestId);
app.use("*", requestLogger);
app.use("*", errorHandler);
app.onError((err, c) => buildErrorResponse(err, c));
app.use("*", enforceHttps);
app.use("*", async (c, next) => {
  await next();
  c.header("X-Robots-Tag", "noindex");
});
app.use("*", async (c, next) => {
  if (c.req.path === "/mcp" || c.req.path.startsWith("/mcp/")) {
    return bodySizeLimit(10 * 1024 * 1024)(c, next);
  }
  return bodySizeLimit(Number(env.MAX_MESSAGE_SIZE ?? 1048576))(c, next);
});

app.use("*", connectPagesHostGate);

app.route("/", oauthMetadataRouter);

app.use("/api/v2/*", rateLimitFailedAuthByIp);
app.use("/mcp", rateLimitFailedAuthByIp);
app.use("/mcp/*", rateLimitFailedAuthByIp);

app.route("/mcp", mcpRouter);

app.use("/api/oauth/*", rateLimitByIp);
app.route("/api/oauth", oauthWorkspaceRouter);

app.use("/api/auth/*", rateLimitByIp);
app.on(["POST", "GET"], "/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

app.route("/health", health);

app.use("/assets/*", async (c, next) => {
  await next();
  if (c.res.ok) {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
  }
});
app.use(
  "/assets/*",
  serveStatic({
    root: "./public",
    rewriteRequestPath: (path) => path.replace(/^\/assets/, ""),
  })
);

app.use("/api/v2/connection-consent/*", rateLimitByIp);
app.route("/api/v2/connection-consent", connectionConsentRouter);
app.route("/", connectPagesRouter);
app.use("/api/slack/identity/*", rateLimitByIp);
mountModule(app, "slack-approvals", "/api/slack", slackPublicRouter);

app.route("/api/v2/workspaces", workspaces);
mountModule(app, "dlq", "/api/v2/dlq", dlq);
app.route("/api/v2/analytics", analytics);
mountModule(app, "self-hosted-plan", "/api/v2/billing", selfHostedPlanRouter);
app.use("/api/v2/public/*", rateLimitPublic);
mountModule(app, "public-sandbox", "/api/v2/public/sandbox", publicSandboxRouter);
app.use("/api/v2/mcp-vendors", rateLimitByIp);
app.route("/api/v2/mcp-vendors", mcpVendorsRouter);
mountModule(app, "sandbox", "/api/v2/sandbox", sandboxRouter);
app.route("/api/v2/notifications", notificationsRouter);
app.use("/api/v2/integrations/slack/callback", rateLimitByIp);
app.route("/api/v2/integrations", integrationsRouter);
mountModule(app, "slack-approvals", "/api/v2/slack-approvals", slackApprovalsRouter);
app.route("/api/v2/logs", logsRouter);
app.route("/api/v2/events", eventsRouter);
app.route("/api/v2/runs", runsRouter);
app.route("/api/v2/stream", streamRouter);
app.route("/api/v2/secrets", secretsRouter);
mountModule(app, "secret-stores", "/api/v2/secret-stores", secretStoresRouter);
mountModule(app, "secret-stores", "/api/v2/secret-store-settings", secretStoreSettingsRouter);
app.route("/api/v2/connections", connectionsRouter);
app.route("/api/v2/end-users", endUsersRouter);
app.route("/api/v2/end-user-session", endUserSessionRouter);
app.route("/api/v2/environments", environmentOAuthAppsRouter);
app.route("/api/v2/actions", actionsRouter);
app.route("/api/v2/mcp-upstreams", mcpUpstreamsRouter);
mountModule(app, "functions", "/api/v2/functions", functionsRouter);
mountModule(app, "functions", "/api/v2/function-runs", functionRunsRouter);
mountModule(app, "functions", "/api/internal/function-runs", internalFunctionRunsRouter);
app.route("/api/v2/approvals", approvalsRouter);
app.route("/api/v2/approval-policies", approvalPoliciesRouter);
app.route("/api/v2/sign-offs", signOffsRouter);
app.route("/api/v2/workspaces", signOffsConsoleRouter);
app.use("/api/v2/sign-off-links/*", rateLimitByIp);
app.route("/api/v2/sign-off-links", signOffLinksRouter);
app.route("/api/v2/auth", authIdentityRouter);
app.route("/api/v2/api-keys", agentApiKeysRouter);
app.route("/api/v2/budgets", budgetsRouter);
app.route("/api/v2/impact-limits", impactLimitsRouter);
app.route("/api/v2/environment", environmentRouter);
app.route("/api/v2/edition", editionRouter);
mountModule(app, "instance", "/api/v2/setup", setupRouter);
mountModule(app, "instance", "/api/v2/instance", instanceRouter);
app.route("/api/internal/metrics", metricsRouter);
app.route("/api/v2/workspaces", members);
app.route("/api/v2/workspaces", invitationsRouter);
mountModule(app, "sso", "/api/v2/workspaces", identityRouter);
app.use("/api/v2/scim/*", rateLimitByIpAllowing(600));
mountModule(app, "scim", "/api/v2/scim", scimRouter);
app.use("/api/v2/invitations/*", rateLimitByIp);
app.route("/api/v2", publicInvitationsRouter);
mountModule(app, "audit-streaming", "/api/v2/workspaces", auditConsoleRouter);
mountModule(app, "audit-streaming", "/api/v2/audit", auditRouter);

app.get("/", (c) => {
  return c.json({
    name: "Anlyon API",
    version: "2.0.0",
    status: "running",
    docs: "/docs",
  });
});

bindExtensionRoutes(app);

app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        path: c.req.path,
      },
      requestId: c.get("requestId"),
    },
    404
  );
});

export default app;
