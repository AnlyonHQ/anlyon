import { createLogger } from "../../lib/logger.ts";
import { safeFetch } from "../../lib/safe-http.ts";
import { env } from "../../config/env.ts";
import {
  ConnectionKeyCheckFailedError,
  ConnectionKeyRejectedError,
  ConnectionProviderError,
  ConnectionsUnavailableError,
  ValidationError,
} from "../../utils/errors.ts";
import {
  checkExternalSecret,
  connectionRefOfSecret,
  getSecretMetadata,
  listSecretsDueHealthCheck,
  markSecretHealthy,
  markSecretNeedsReauth,
  withStaticSecretValue,
  type SecretView,
} from "../actions/secrets.ts";
import { accountHostTemplate, assertAccountHost, composeCredential, findIntegration, keyAuthOf, type ApiKeyAuth, type IntegrationEntry } from "./catalogue.ts";
import { applyAccountHost, usesAccountHost } from "../actions/template.ts";
import { assertReadOnlyGraphqlQuery } from "../effects/graphql.ts";
import { ConnectionRevokedError, connectionProvider, requireConnectionProvider } from "./provider.ts";

const logger = createLogger({ module: "connections-health" });

export const KEY_CHECK_TIMEOUT_MS = 10_000;

export const HEALTH_SWEEP_BATCH = 100;

export const keyCheck = {
  fetch: safeFetch as (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<Response>,
};

function checkUrlFor(entry: IntegrationEntry, auth: ApiKeyAuth, accountHost: string | null): string {
  if (accountHostTemplate(entry)) {
    const host = assertAccountHost(entry, accountHost);
    if (!usesAccountHost(auth.check.url)) throw new ValidationError(`${entry.displayName} cannot be connected: its key check is not on the account's own host.`);
    return applyAccountHost(auth.check.url, host);
  }
  const host = new URL(auth.check.url).hostname;
  if (!Array.isArray(entry.hosts) || !entry.hosts.includes(host)) {
    throw new ValidationError(`${entry.displayName} cannot be connected: its key check is not on one of its own hosts.`);
  }
  return auth.check.url;
}

export async function keyVerdict(
  entry: IntegrationEntry, auth: ApiKeyAuth, stored: string, accountHost: string | null = null,
): Promise<"accepted" | "rejected"> {
  const url = checkUrlFor(entry, auth, accountHost);
  if (auth.check.graphql !== undefined) assertReadOnlyGraphqlQuery(auth.check.graphql, `${entry.displayName}'s key check`);
  const { value } = composeCredential(entry, stored);
  let status: number;
  try {
    const response = await keyCheck.fetch(url, auth.check.graphql !== undefined
      ? {
          method: "POST",
          headers: { ...(auth.check.headers ?? {}), "Content-Type": "application/json", [auth.header]: `${auth.prefix}${value}` },
          body: JSON.stringify({ query: auth.check.graphql }),
          signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
        }
      : {
          method: "GET",
          headers: { ...(auth.check.headers ?? {}), [auth.header]: `${auth.prefix}${value}` },
          signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
        });
    status = response.status;
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    logger.warn({ integrationId: entry.id, error: error instanceof Error ? error.name : "unknown" }, "API key check could not be made");
    throw new ConnectionKeyCheckFailedError(entry.displayName);
  }
  if (status >= 200 && status < 300) return "accepted";
  if (status === 401 || status === 403) return "rejected";
  logger.warn({ integrationId: entry.id, status }, "API key check answered an unexpected status");
  throw new ConnectionKeyCheckFailedError(entry.displayName);
}

export async function checkKey(entry: IntegrationEntry, auth: ApiKeyAuth, stored: string, accountHost: string | null = null): Promise<void> {
  if ((await keyVerdict(entry, auth, stored, accountHost)) === "rejected") throw new ConnectionKeyRejectedError(entry.displayName);
}

export interface Scope {
  workspaceId: string;
  environmentId: string;
}

export function integrationOf(secret: SecretView): IntegrationEntry {
  if (!secret.integrationId) {
    throw new ValidationError(
      `Secret ${secret.name} is a stored value, not a connected account, so Anlyon has no way to check it or reconnect it. Rotate it with PUT /api/v2/secrets/${secret.name}.`,
    );
  }
  const entry = findIntegration(secret.integrationId);
  if (!entry) throw new ValidationError(`The integration ${secret.name} was connected for is no longer offered.`);
  return entry;
}

export async function checkSecretHealth(scope: Scope, name: string, options: { thorough: boolean } = { thorough: true }): Promise<SecretView> {
  const secret = await getSecretMetadata(scope.workspaceId, name, scope.environmentId);
  if (secret.kind === "external") return checkExternalSecret(scope.workspaceId, scope.environmentId, name);
  const entry = integrationOf(secret);

  const keyAuth = keyAuthOf(entry);
  if (keyAuth && secret.kind !== "connection") {
    const auth = keyAuth;
    const accountHost = accountHostTemplate(entry) ? secret.allowedHosts?.[0] ?? null : null;
    const verdict = await withStaticSecretValue(scope.workspaceId, scope.environmentId, name, (value) => keyVerdict(entry, auth, value, accountHost));
    if (verdict === "accepted") await markSecretHealthy({ ...scope, name });
    else await markSecretNeedsReauth({ ...scope, name }, "key_rejected");
  } else {
    const ref = await connectionRefOfSecret(scope.workspaceId, scope.environmentId, name);
    try {
      await requireConnectionProvider().getAccessToken({ integrationKey: ref.integrationKey, connectionId: ref.connectionId }, { forceRefresh: options.thorough });
      await markSecretHealthy({ ...scope, name });
    } catch (error) {
      if (error instanceof ConnectionRevokedError) {
        await markSecretNeedsReauth({ ...scope, name }, "access_revoked");
      } else if (error instanceof ConnectionsUnavailableError) {
        throw error;
      } else {
        logger.error({ ...scope, name, error: error instanceof Error ? error.message : String(error) }, "Checking a connected account failed");
        throw new ConnectionProviderError(`Whether ${name} still works could not be checked just now. Its status is unchanged. Try again shortly.`);
      }
    }
  }
  logger.info({ ...scope, name, integrationId: entry.id }, "Connected account checked");
  return getSecretMetadata(scope.workspaceId, name, scope.environmentId);
}

export function probeRejectedCredentials(scope: Scope, secretNames: readonly string[]): void {
  for (const name of secretNames) {
    void (async () => {
      try {
        const secret = await getSecretMetadata(scope.workspaceId, name, scope.environmentId);
        if (!secret.integrationId || secret.health?.status === "needs_reauth") return;
        await checkSecretHealth(scope, name, { thorough: true });
      } catch (error) {
        logger.warn({ ...scope, name, error: error instanceof Error ? error.message : String(error) }, "Probing a credential after a 401 failed");
      }
    })();
  }
}

export async function sweepConnectionHealth(now = new Date()): Promise<{ checked: number; marked: number; skipped: number }> {
  const due = await listSecretsDueHealthCheck(new Date(now.getTime() - env.CONNECTION_HEALTH_CHECK_INTERVAL_MS), HEALTH_SWEEP_BATCH);
  const hasProvider = connectionProvider() !== null;
  let checked = 0;
  let marked = 0;
  let skipped = 0;
  for (const row of due) {
    if (row.kind === "connection" && !hasProvider) { skipped++; continue; }
    try {
      const secret = await checkSecretHealth({ workspaceId: row.workspaceId, environmentId: row.environmentId }, row.name, { thorough: false });
      checked++;
      if (secret.health && secret.health.status !== "active") marked++;
    } catch (error) {
      skipped++;
      logger.warn({ workspaceId: row.workspaceId, name: row.name, error: error instanceof Error ? error.message : String(error) }, "Health sweep could not check a connected account");
    }
  }
  if (checked > 0 || skipped > 0) logger.info({ checked, marked, skipped }, "Connected account health sweep completed");
  return { checked, marked, skipped };
}
