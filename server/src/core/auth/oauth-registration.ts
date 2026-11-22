import { createAuthMiddleware } from "better-auth/api";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { oauthClient } from "../../db/schema/oauth.ts";
import { ALL_OAUTH_SCOPES, DEFAULT_OAUTH_SCOPES } from "./oauth-scopes.ts";
import { screenOAuthScopes } from "./oauth-unknown-scopes.ts";

export const REGISTER_PATH = "/oauth2/register";

const KNOWN_SCOPES = new Set(ALL_OAUTH_SCOPES);

export function registrationScopes(requested: unknown): string[] {
  const asked = typeof requested === "string" ? requested.split(/\s+/).filter((scope) => KNOWN_SCOPES.has(scope)) : [];
  return asked.length > 0 ? [...new Set(asked)] : [...DEFAULT_OAUTH_SCOPES];
}

export function publicRegistrationBody(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return { ...(body as Record<string, unknown>), token_endpoint_auth_method: "none" };
}

function registeredClientId(returned: unknown): string | undefined {
  if (!returned || typeof returned !== "object" || returned instanceof Error) return undefined;
  const clientId = (returned as { client_id?: unknown }).client_id;
  return typeof clientId === "string" && clientId.length > 0 ? clientId : undefined;
}

export const registrationBeforeHook = createAuthMiddleware(async (ctx) => {
  const screened = screenOAuthScopes(ctx);
  if (ctx.path !== REGISTER_PATH) return screened ? { context: screened } : undefined;
  const body = publicRegistrationBody(ctx.body);
  if (!body) return;
  return { context: { body } };
});

export const registrationAfterHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== REGISTER_PATH) return;
  const returned = ctx.context.returned;
  const clientId = registeredClientId(returned);
  if (!clientId) return;
  const scopes = registrationScopes((ctx.body as { scope?: unknown } | undefined)?.scope);
  await db.update(oauthClient).set({ scopes, public: true }).where(eq(oauthClient.clientId, clientId));
  return ctx.json({ ...(returned as Record<string, unknown>), scope: scopes.join(" ") });
});
