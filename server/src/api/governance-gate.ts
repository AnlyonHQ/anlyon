import type { Context } from "hono";
import { auditCaller } from "./audit-caller.ts";
import type { GovernanceOperation } from "../core/governance/classify.ts";
import { requestSignOffIfLoosening, type SignOffRequester } from "../core/governance/sign-offs.ts";

const HUMAN_PRESENT_AUTH_TYPES = new Set(["session"]);

export function isHumanPresent(c: Context): boolean {
  const authType = c.get("authType") as string | undefined;
  return Boolean(authType && HUMAN_PRESENT_AUTH_TYPES.has(authType));
}

export function signOffRequester(c: Context): SignOffRequester {
  const authType = c.get("authType") as string | undefined;
  const scopes = (c.get("apiKeyScopes") as string[] | undefined) ?? null;
  const context = auditCaller(c).context;
  if (authType === "apiKey") {
    return { type: "api_key", keyId: (c.get("apiKeyId") as string | undefined) ?? null, oauthClientId: null, userId: null, scopes, context };
  }
  if (authType === "oauth") {
    return {
      type: "oauth_client", keyId: null,
      oauthClientId: (c.get("oauthClientId") as string | undefined) ?? null,
      userId: (c.get("userId") as string | undefined) ?? null, scopes, context,
    };
  }
  return { type: "other", keyId: null, oauthClientId: null, userId: (c.get("userId") as string | undefined) ?? null, scopes: scopes ?? [], context };
}

export async function signOffIfLoosening(
  c: Context,
  operation: GovernanceOperation,
  target: Record<string, string | undefined>,
  input: object,
): Promise<Response | null> {
  if (isHumanPresent(c)) return null;
  const cleanTarget = Object.fromEntries(Object.entries(target).filter((e): e is [string, string] => typeof e[1] === "string"));
  const requested = await requestSignOffIfLoosening(
    { workspaceId: c.get("workspaceId") as string, environmentId: c.get("environmentId") as string },
    { operation, target: cleanTarget, input: input as Record<string, unknown> },
    signOffRequester(c),
  );
  if (!requested) return null;
  c.header("Location", requested.signOff.pollUrl);
  return c.json({ success: true, signOffRequired: true, data: requested.signOff }, 202);
}
