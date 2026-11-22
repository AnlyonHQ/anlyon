import type { Context } from "hono";
import type { PolicyScopeContext } from "../core/approvals/policy.ts";

export function policyActor(c: Context): PolicyScopeContext["actor"] {
  if (c.get("authType") === "apiKey") {
    const id = c.get("apiKeyId") as string | undefined;
    return id ? { type: "api_key", id } : undefined;
  }
  const id = c.get("userId") as string | undefined;
  return id ? { type: "user", id } : undefined;
}

export function oauthPrincipal(c: Context): { userId: string; clientId: string } | undefined {
  if (c.get("authType") !== "oauth") return undefined;
  const userId = c.get("userId") as string | undefined;
  const clientId = c.get("oauthClientId") as string | undefined;
  return userId && clientId ? { userId, clientId } : undefined;
}

export function sessionRequester(c: Context): string | undefined {
  if (c.get("authType") !== "session") return undefined;
  return (c.get("userId") as string | undefined) || undefined;
}
