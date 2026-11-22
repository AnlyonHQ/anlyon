import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { oauthClient } from "../../db/schema/oauth.ts";

export const FIRST_PARTY_METADATA_KEY = "anlyonFirstParty";

export interface FirstPartyClientConfig {
  key: string;
  displayName: string;
  startUrl: string;
}

export interface FirstPartyClient extends FirstPartyClientConfig {
  clientId: string;
}

function parseMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : undefined;
}

export function isAllowedStartUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function firstPartyConfigOf(row: { skipConsent: boolean | null; disabled?: boolean | null; metadata: unknown }): FirstPartyClientConfig | null {
  if (row.skipConsent !== true || row.disabled === true) return null;
  const entry = parseMetadata(row.metadata)?.[FIRST_PARTY_METADATA_KEY];
  if (!entry || typeof entry !== "object") return null;
  const { key, displayName, startUrl } = entry as Record<string, unknown>;
  if (typeof key !== "string" || !key) return null;
  if (typeof displayName !== "string" || !displayName) return null;
  if (typeof startUrl !== "string" || !isAllowedStartUrl(startUrl)) return null;
  return { key, displayName, startUrl };
}

export async function getFirstPartyClient(clientId: string): Promise<FirstPartyClient | null> {
  const [row] = await db
    .select({ skipConsent: oauthClient.skipConsent, disabled: oauthClient.disabled, metadata: oauthClient.metadata })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!row) return null;
  const config = firstPartyConfigOf(row);
  return config ? { clientId, ...config } : null;
}

export function scopesNeedWorkspace(scopes: readonly string[] | undefined): boolean {
  return (scopes ?? []).some((scope) => scope.startsWith("anlyon:"));
}

export function signUpProperties(path: string, firstPartyKey: string | undefined): { method: string; source?: string } {
  const method = path.includes("google")
    ? "google"
    : path.includes("github")
      ? "github"
      : path.includes("email")
        ? "email"
        : "unknown";
  return firstPartyKey ? { method, source: firstPartyKey } : { method };
}
