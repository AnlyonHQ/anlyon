import { and, count, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { env } from "../../config/env.ts";
import { environmentOauthApps } from "../../db/schema/environment-oauth-apps.ts";
import { oauthConnections } from "../../db/schema/oauth-connections.ts";
import { decryptSecret, encryptSecret } from "../../utils/crypto.ts";
import { ConnectionsUnavailableError, NotFoundError, ValidationError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";
import { findIntegration } from "../connections/catalogue.ts";
import { OAUTH_APPS, type OAuthClient } from "../connections/oauth-apps.ts";
import { consentUrl } from "../connections/consent-urls.ts";

const logger = createLogger({ module: "end-users-oauth-apps" });

type Scope = { workspaceId: string; environmentId: string };

export interface EnvironmentOAuthAppView {
  integration: string;
  configured: boolean;
  clientId: string | null;
  redirectUri: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export function consentRedirectUri(): string {
  return consentUrl("callback");
}

function encryptionKey(): string {
  if (!env.CONNECTIONS_ENCRYPTION_KEY) throw new ConnectionsUnavailableError();
  return env.CONNECTIONS_ENCRYPTION_KEY;
}

const secretContext = (row: { workspaceId: string; environmentId: string; integrationKey: string }) =>
  ({ store: "oauth-app" as const, workspaceId: row.workspaceId, environmentId: row.environmentId, name: row.integrationKey });

function oauthIntegration(integrationKey: string): string {
  const entry = findIntegration(integrationKey);
  if (!entry || entry.auth.kind !== "oauth" || !OAUTH_APPS[entry.id]) {
    throw new ValidationError(`${integrationKey} is not an integration that signs in with OAuth.`);
  }
  return entry.id;
}

export async function environmentOAuthClient(environmentId: string, integrationKey: string): Promise<OAuthClient | null> {
  const [row] = await db.select().from(environmentOauthApps)
    .where(and(eq(environmentOauthApps.environmentId, environmentId), eq(environmentOauthApps.integrationKey, integrationKey)));
  if (!row || !env.CONNECTIONS_ENCRYPTION_KEY) return null;
  return { clientId: row.clientId, clientSecret: decryptSecret(row.clientSecretEncrypted, env.CONNECTIONS_ENCRYPTION_KEY, secretContext(row)) };
}

function toView(integration: string, row: typeof environmentOauthApps.$inferSelect | undefined): EnvironmentOAuthAppView {
  return {
    integration,
    configured: Boolean(row),
    clientId: row?.clientId ?? null,
    redirectUri: consentRedirectUri(),
    createdAt: row?.createdAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function getEnvironmentOAuthApp(scope: Scope, integrationKey: string): Promise<EnvironmentOAuthAppView> {
  const integration = oauthIntegration(integrationKey);
  const [row] = await db.select().from(environmentOauthApps).where(and(
    eq(environmentOauthApps.workspaceId, scope.workspaceId),
    eq(environmentOauthApps.environmentId, scope.environmentId),
    eq(environmentOauthApps.integrationKey, integration),
  ));
  return toView(integration, row);
}

export async function listEnvironmentOAuthApps(scope: Scope): Promise<EnvironmentOAuthAppView[]> {
  const rows = await db.select().from(environmentOauthApps).where(and(
    eq(environmentOauthApps.workspaceId, scope.workspaceId),
    eq(environmentOauthApps.environmentId, scope.environmentId),
  ));
  const byKey = new Map(rows.map((row) => [row.integrationKey, row]));
  return Object.keys(OAUTH_APPS)
    .filter((key) => findIntegration(key)?.auth.kind === "oauth")
    .map((key) => toView(key, byKey.get(key)));
}

export async function putEnvironmentOAuthApp(
  scope: Scope,
  integrationKey: string,
  input: { clientId: string; clientSecret: string },
): Promise<EnvironmentOAuthAppView> {
  const integration = oauthIntegration(integrationKey);
  const key = encryptionKey();
  const now = new Date();
  const sealed = encryptSecret(input.clientSecret, key, secretContext({ ...scope, integrationKey: integration }));
  const [row] = await db.insert(environmentOauthApps).values({
    workspaceId: scope.workspaceId,
    environmentId: scope.environmentId,
    integrationKey: integration,
    clientId: input.clientId,
    clientSecretEncrypted: sealed,
  }).onConflictDoUpdate({
    target: [environmentOauthApps.environmentId, environmentOauthApps.integrationKey],
    set: { clientId: input.clientId, clientSecretEncrypted: sealed, updatedAt: now },
    setWhere: eq(environmentOauthApps.workspaceId, scope.workspaceId),
  }).returning();
  if (!row) throw new NotFoundError("Environment");
  logger.info({ workspaceId: scope.workspaceId, environmentId: scope.environmentId, integration }, "Environment OAuth app set");
  return toView(integration, row);
}

export async function deleteEnvironmentOAuthApp(scope: Scope, integrationKey: string): Promise<{ deleted: boolean; affectedConnections: number }> {
  const integration = oauthIntegration(integrationKey);
  const [row] = await db.delete(environmentOauthApps).where(and(
    eq(environmentOauthApps.workspaceId, scope.workspaceId),
    eq(environmentOauthApps.environmentId, scope.environmentId),
    eq(environmentOauthApps.integrationKey, integration),
  )).returning();
  if (!row) return { deleted: false, affectedConnections: 0 };
  const [{ total }] = await db.select({ total: count() }).from(oauthConnections).where(and(
    eq(oauthConnections.environmentId, scope.environmentId),
    eq(oauthConnections.integrationKey, integration),
    eq(oauthConnections.oauthClientId, row.clientId),
  ));
  logger.info({ workspaceId: scope.workspaceId, environmentId: scope.environmentId, integration, affected: total }, "Environment OAuth app removed");
  return { deleted: true, affectedConnections: Number(total) };
}
