import { Hono, type Context, type Next } from "hono";
import { requireApiKey, requireApiKeyResourceScopes, requirePermissionForWrites } from "../middleware/auth.ts";
import { requireFeature } from "../middleware/feature-gate.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody } from "../middleware/validation.ts";
import { putEnvironmentOAuthAppSchema } from "../../utils/validation.ts";
import {
  deleteEnvironmentOAuthApp,
  getEnvironmentOAuthApp,
  listEnvironmentOAuthApps,
  putEnvironmentOAuthApp,
} from "../../core/end-users/oauth-apps.ts";
import { getEnvironment } from "../../core/environments/service.ts";
import { NotFoundError } from "../../utils/errors.ts";
import { validateUUID } from "../../utils/uuid-validator.ts";
import { auditRequest } from "../audit-caller.ts";
import { pathParam } from "../params.ts";
import { signOffIfLoosening } from "../governance-gate.ts";

const environmentOAuthAppsRouter = new Hono();

environmentOAuthAppsRouter.use("*", requireFeature("connected-accounts"));
environmentOAuthAppsRouter.use("*", requireApiKey);

async function pathEnvironment(c: Context, next: Next) {
  const environmentId = validateUUID(pathParam(c, "environmentId"), "Environment ID");
  if (c.get("authType") === "session") {
    await getEnvironment(c.get("workspaceId") as string, environmentId);
    c.set("environmentId", environmentId);
  } else if (c.get("environmentId") !== environmentId) {
    throw new NotFoundError("Environment");
  }
  await next();
}

environmentOAuthAppsRouter.use("/:environmentId/*", pathEnvironment);
environmentOAuthAppsRouter.use("/:environmentId/*", requireApiKeyResourceScopes("secrets:read", "secrets:write"));
environmentOAuthAppsRouter.use("/:environmentId/*", requirePermissionForWrites("oauth-apps.manage"));
environmentOAuthAppsRouter.use("/:environmentId/*", rateLimitByWorkspace);

const scopeOf = (c: Context) => ({ workspaceId: c.get("workspaceId") as string, environmentId: c.get("environmentId") as string });

environmentOAuthAppsRouter.get("/:environmentId/oauth-apps", async (c: Context) => {
  return c.json({ success: true, data: await listEnvironmentOAuthApps(scopeOf(c)) });
});

environmentOAuthAppsRouter.get("/:environmentId/oauth-apps/:integration", async (c: Context) => {
  return c.json({ success: true, data: await getEnvironmentOAuthApp(scopeOf(c), pathParam(c, "integration")) });
});

environmentOAuthAppsRouter.put(
  "/:environmentId/oauth-apps/:integration",
  validateBody(putEnvironmentOAuthAppSchema),
  async (c: Context) => {
    const body = c.get("validatedBody") as { clientId: string; clientSecret: string };
    const pending = await signOffIfLoosening(c, "oauth_app.put", { integration: pathParam(c, "integration") }, body);
    if (pending) return pending;
    const app = await putEnvironmentOAuthApp(scopeOf(c), pathParam(c, "integration"), body);
    auditRequest(c, {
      workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") as string, type: "secret.oauth_app_set",
      resource: { type: "oauth_app", id: app.integration }, data: { integration: app.integration, clientId: app.clientId },
    });
    return c.json({ success: true, data: app });
  },
);

environmentOAuthAppsRouter.delete("/:environmentId/oauth-apps/:integration", async (c: Context) => {
  const result = await deleteEnvironmentOAuthApp(scopeOf(c), pathParam(c, "integration"));
  if (result.deleted) {
    auditRequest(c, {
      workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") as string, type: "secret.oauth_app_removed",
      resource: { type: "oauth_app", id: pathParam(c, "integration") }, data: { integration: pathParam(c, "integration"), affectedConnections: result.affectedConnections },
    });
  }
  return c.json({ success: true, data: result });
});

export default environmentOAuthAppsRouter;
