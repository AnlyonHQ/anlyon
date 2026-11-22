import { Hono, type Context } from "hono";
import { requireApiKey } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { resolveMemberRole } from "../../core/workspace/roles.ts";

const authIdentityRouter = new Hono();

authIdentityRouter.use("*", requireApiKey);
authIdentityRouter.use("*", rateLimitByWorkspace);

authIdentityRouter.get("/identity", async (c: Context) => {
  const authType = c.get("authType") as "apiKey" | "oauth" | "session";
  const expiresAt = c.get("credentialExpiresAt") as Date | null | undefined;

  const identity = {
    credentialType: authType === "apiKey" ? "api_key" : authType,
    apiKeyId: authType === "apiKey" ? ((c.get("apiKeyId") as string | undefined) ?? null) : null,
    workspaceId: c.get("workspaceId") as string,
    environmentId: c.get("environmentId") as string,
    scopes: authType === "session" ? null : ([...((c.get("apiKeyScopes") as string[] | undefined) ?? [])].sort()),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    role: authType === "apiKey" ? null : await personRole(c),
  };

  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: identity });
});

async function personRole(c: Context): Promise<string | null> {
  const userId = c.get("userId") as string | undefined;
  if (!userId) return null;
  const resolved = await resolveMemberRole(c.get("workspaceId") as string, userId, c.get("environmentId") as string | undefined);
  return resolved?.role ?? null;
}

export default authIdentityRouter;
