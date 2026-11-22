import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { oauthClient } from "../../db/schema/oauth.ts";
import { FIRST_PARTY_METADATA_KEY, isAllowedStartUrl, type FirstPartyClientConfig } from "./first-party-clients.ts";

export interface FirstPartyClientDefinition extends FirstPartyClientConfig {
  name: string;
  uri: string;
  redirectUris: string[];
}

export function anlyonDevDefinition(options: { staging: boolean }): FirstPartyClientDefinition {
  return {
    key: "anlyon.dev",
    name: "anlyon.dev",
    displayName: "anlyon.dev",
    uri: "https://anlyon.dev",
    startUrl: "https://anlyon.dev/auth/login",
    redirectUris: options.staging
      ? ["https://anlyon.dev/auth/callback", "http://localhost:3000/auth/callback"]
      : ["https://anlyon.dev/auth/callback"],
  };
}

export const FIRST_PARTY_SCOPES = ["openid", "profile", "email"];

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function randomLetters(length: number): string {
  const bytes = randomBytes(length * 2);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    if (bytes[i] < 208) out += LETTERS[bytes[i] % 52];
  }
  return out.length === length ? out : randomLetters(length);
}

export function hashClientSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

export type SeedOutcome =
  | { action: "created"; clientId: string; clientSecret: string }
  | { action: "updated"; clientId: string; clientSecret?: undefined }
  | { action: "rotated"; clientId: string; clientSecret: string };

export async function seedFirstPartyClient(definition: FirstPartyClientDefinition, options: { rotate: boolean }): Promise<SeedOutcome> {
  if (!isAllowedStartUrl(definition.startUrl)) {
    throw new Error(`Start URL must be https (or http on localhost): ${definition.startUrl}`);
  }
  for (const uri of definition.redirectUris) {
    if (!isAllowedStartUrl(uri)) throw new Error(`Redirect URI must be https (or http on localhost): ${uri}`);
  }

  const now = new Date();
  const fields = {
    name: definition.name,
    uri: definition.uri,
    redirectUris: definition.redirectUris,
    scopes: FIRST_PARTY_SCOPES,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "client_secret_basic",
    applicationType: "web",
    public: false,
    type: "web",
    skipConsent: true,
    requirePKCE: true,
    enableEndSession: false,
    disabled: false,
    userId: null,
    metadata: {
      [FIRST_PARTY_METADATA_KEY]: { key: definition.key, displayName: definition.displayName, startUrl: definition.startUrl },
    },
    updatedAt: now,
  };

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ clientId: oauthClient.clientId })
      .from(oauthClient)
      .where(
        and(
          eq(oauthClient.skipConsent, true),
          sql`${oauthClient.metadata} -> ${FIRST_PARTY_METADATA_KEY} ->> 'key' = ${definition.key}`,
        ),
      )
      .limit(1)
      .for("update");

    if (!existing) {
      const clientId = randomLetters(32);
      const clientSecret = randomLetters(32);
      await tx.insert(oauthClient).values({
        id: randomUUID(),
        clientId,
        clientSecret: hashClientSecret(clientSecret),
        createdAt: now,
        ...fields,
      });
      return { action: "created", clientId, clientSecret };
    }

    if (options.rotate) {
      const clientSecret = randomLetters(32);
      await tx
        .update(oauthClient)
        .set({ ...fields, clientSecret: hashClientSecret(clientSecret) })
        .where(eq(oauthClient.clientId, existing.clientId));
      return { action: "rotated", clientId: existing.clientId, clientSecret };
    }

    await tx.update(oauthClient).set(fields).where(eq(oauthClient.clientId, existing.clientId));
    return { action: "updated", clientId: existing.clientId };
  });
}
