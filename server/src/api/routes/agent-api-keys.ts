import { Hono, type Context } from "hono";
import { z } from "zod";
import { auditCaller } from "../audit-caller.ts";
import { requireApiKey, requirePermission } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody } from "../middleware/validation.ts";
import { createApiKey } from "../../core/auth/api-keys.ts";
import type { ApiKeyScope } from "../../core/auth/api-key-scopes.ts";
import { API_KEY_CREATE_SCOPE, DEFAULT_OAUTH_SCOPES, expandOAuthScopes } from "../../core/auth/oauth-scopes.ts";
import { ApiError } from "../../utils/errors.ts";

export const STANDARD_AGENT_KEY_SCOPES: readonly ApiKeyScope[] = expandOAuthScopes(DEFAULT_OAUTH_SCOPES);

export function agentKeyScopes(loginScopes: readonly string[]): ApiKeyScope[] {
  const held = new Set(loginScopes);
  return STANDARD_AGENT_KEY_SCOPES.filter((scope) => held.has(scope));
}

const createAgentKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
}).strict();

const agentApiKeysRouter = new Hono();

agentApiKeysRouter.use("*", requireApiKey);
agentApiKeysRouter.use("*", rateLimitByWorkspace);

agentApiKeysRouter.post("/", async (c: Context, next) => {
  if (c.get("authType") !== "oauth") {
    throw new ApiError(403, "OAUTH_LOGIN_REQUIRED",
      "Only a person's OAuth login (such as `anlyon init`) creates keys here. Create other keys in the console under Settings, API keys.");
  }
  const groups = (c.get("oauthGrantedGroups") as string[] | undefined) ?? [];
  if (!groups.includes(API_KEY_CREATE_SCOPE)) {
    throw new ApiError(403, "AUTHORIZATION_ERROR",
      `This authorization is missing required scope: ${API_KEY_CREATE_SCOPE}. Log in again and allow "Create API keys".`);
  }
  await next();
}, requirePermission("keys.manage"), validateBody(createAgentKeySchema), async (c: Context) => {
  const scopes = agentKeyScopes((c.get("apiKeyScopes") as string[] | undefined) ?? []);
  if (!scopes.includes("actions:invoke")) {
    throw new ApiError(403, "AUTHORIZATION_ERROR",
      "This authorization is missing required scope: actions:invoke. Log in again and allow Actions, so the key can invoke them.");
  }
  const { name } = c.get("validatedBody") as z.infer<typeof createAgentKeySchema>;
  const created = await createApiKey(
    c.get("workspaceId"),
    c.get("userId"),
    name,
    undefined,
    scopes,
    c.get("environmentId") as string,
    { context: auditCaller(c).context },
  );
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: created }, 201);
});

export default agentApiKeysRouter;
