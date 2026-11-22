import { and, eq, inArray, count, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaceSecrets, type SecretExternalRef, type SecretHealth, type SecretHealthReason } from "../../db/schema/actions.ts";
import type { SecretStoreType } from "../../db/schema/secret-stores.ts";
import { environments } from "../../db/schema/environments.ts";
import { env } from "../../config/env.ts";
import { createLogger } from "../../lib/logger.ts";
import { encryptSecret, decryptSecret, generateSecretId } from "../../utils/crypto.ts";
import {
  ConnectionNeedsReauthError,
  ConnectionProviderError,
  ConnectionRevokeFailedError,
  ConnectionsUnavailableError,
  ExternalSecretUnavailableError,
  SecretKindMismatchError,
  SecretNotFoundError,
  ValidationError,
} from "../../utils/errors.ts";
import {
  ACCOUNT_HOST_PLACEHOLDER,
  accountHostTemplate,
  assertAccountHost,
  composeCredential,
  findIntegration,
  isBareHostname,
  type ComposedCredential,
} from "../connections/catalogue.ts";
import { NO_END_USER, type EndUserContext } from "../end-users/identity.ts";
import { EndUserRequiredError } from "../end-users/errors.ts";

import { connectionRefIntegration, isConnectionRef } from "./template.ts";
import { ConnectionRevokedError, requireConnectionProvider } from "../connections/provider.ts";
import { checkSecretQuota } from "../billing/usage-enforcement.ts";
import { assertNotProtected } from "../environments/service.ts";
import { emitEvent } from "../events/emitter.ts";
import { notifyTeamIfEnabled } from "../notifications/team-alerts.ts";
import { readExternalValue, resolveReference } from "../secret-stores/service.ts";
import { StoreReadError } from "../secret-stores/http.ts";

const logger = createLogger({ module: "secrets" });

export interface SecretView {
  id: string;
  name: string;
  description: string | null;
  allowedHosts: string[] | null;
  allowedPlacements: string[] | null;
  kind: "static" | "connection" | "external";
  connection: { integrationId: string; status: "active" | "needs_reauth" } | null;
  integrationId: string | null;
  health: { status: "active" | "needs_reauth" | "unreachable"; checkedAt: Date | null; reason: SecretHealthReason | null } | null;
  external: { store: string; storeType: SecretStoreType; path: string; key: string | null; version: string | null } | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type SecretRow = typeof workspaceSecrets.$inferSelect;

async function getDefaultEnvironmentId(workspaceId: string): Promise<string> {
  const [row] = await db.select({ id: environments.id }).from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.isDefault, true)));
  if (!row) throw new SecretNotFoundError(
    `Workspace ${workspaceId} has no default environment, so secrets cannot be scoped. Create a default environment for this workspace.`
  );
  return row.id;
}

function unchecked(): SecretHealth {
  return { status: "active", checkedAt: null, reason: null };
}

function checkedNow(): SecretHealth {
  return { status: "active", checkedAt: new Date().toISOString(), reason: null };
}

function healthOf(row: SecretRow): SecretHealth | null {
  if (row.health) return row.health;
  if (row.kind === "external") return unchecked();
  const integrationId = row.integrationId ?? (row.kind === "connection" ? row.connection?.integrationId ?? null : null);
  if (!integrationId) return null;
  return row.connection?.status === "needs_reauth"
    ? { status: "needs_reauth", checkedAt: null, reason: "access_revoked" }
    : unchecked();
}

function toSecret(row: SecretRow): SecretView {
  const health = healthOf(row);
  return {
    id: row.secretId,
    name: row.name,
    description: row.description,
    allowedHosts: row.allowedHosts ?? null,
    allowedPlacements: row.allowedPlacements ?? null,
    kind: row.kind === "connection" || row.kind === "external" ? row.kind : "static",
    connection: row.kind === "connection" && row.connection
      ? { integrationId: row.connection.integrationId, status: health?.status === "needs_reauth" ? "needs_reauth" : "active" }
      : null,
    integrationId: row.integrationId ?? (row.kind === "connection" ? row.connection?.integrationId ?? null : null),
    health: health
      ? { status: health.status, checkedAt: health.checkedAt ? new Date(health.checkedAt) : null, reason: health.reason ?? null }
      : null,
    external: row.kind === "external" && row.external
      ? { store: row.external.store, storeType: row.external.storeType, path: row.external.path, key: row.external.key, version: row.external.version }
      : null,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function assertSecretWillBeBound(
  workspaceId: string, name: string, input: { allowedHosts?: string[] | null }, environmentId?: string,
): Promise<void> {
  if (input.allowedHosts !== undefined && input.allowedHosts !== null && input.allowedHosts.length > 0) return;
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const [existing] = input.allowedHosts === undefined
    ? await db.select({ allowedHosts: workspaceSecrets.allowedHosts }).from(workspaceSecrets)
      .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, scopedEnvironmentId), eq(workspaceSecrets.name, name)))
    : [];
  if (existing?.allowedHosts && existing.allowedHosts.length > 0) return;
  const refused = new ValidationError(
    existing
      ? `Secret ${name} has no allowed hosts, so it could be sent to any host. Name them with this write: "allowedHosts": ["api.example.com"]. Nothing was changed.`
      : `A secret needs the hosts it may be sent to: "allowedHosts": ["api.example.com"]. Without them it could be sent to any host. Nothing was stored.`,
  );
  refused.fix = {
    summary: "Send allowedHosts with the hosts this secret's actions call, for example [\"api.stripe.com\"]. A leading dot allows subdomains: \".stripe.com\".",
    docs: "https://docs.anlyon.com/execution/secrets",
  };
  throw refused;
}

export async function putSecret(
  workspaceId: string,
  name: string,
  input: {
    value: string;
    description?: string;
    allowedHosts?: string[] | null;
    allowedPlacements?: string[] | null;
    integrationId?: string;
    checked?: boolean;
  },
  environmentId?: string,
): Promise<SecretView> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const [existing] = await db
    .select()
    .from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, scopedEnvironmentId), eq(workspaceSecrets.name, name)));

  if (existing && (existing.kind === "connection" || existing.kind === "external")) throw new SecretKindMismatchError(name, existing.kind);

  const valueEncrypted = encryptSecret(input.value, env.DELIVERY_SECRET_MASTER_KEY, {
    store: "vault",
    workspaceId,
    environmentId: scopedEnvironmentId,
    name,
  });

  if (existing) {
    const [updated] = await db
      .update(workspaceSecrets)
      .set({
        valueEncrypted,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.allowedHosts !== undefined ? { allowedHosts: input.allowedHosts } : {}),
        ...(input.allowedPlacements !== undefined
          ? { allowedPlacements: input.allowedPlacements }
          : {}),
        ...(existing.integrationId ? { health: input.checked ? checkedNow() : unchecked() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(workspaceSecrets.id, existing.id))
      .returning();

    logger.info({ workspaceId, name }, "Secret rotated");
    return toSecret(updated);
  }

  await checkSecretQuota(workspaceId);

  const [created] = await db
    .insert(workspaceSecrets)
    .values({
      workspaceId,
      environmentId: scopedEnvironmentId,
      secretId: generateSecretId(),
      name,
      valueEncrypted,
      description: input.description ?? null,
      allowedHosts: input.allowedHosts ?? null,
      allowedPlacements: input.allowedPlacements ?? null,
      integrationId: input.integrationId ?? null,
      health: input.integrationId ? (input.checked ? checkedNow() : unchecked()) : null,
    })
    .returning();

  logger.info({ workspaceId, name }, "Secret created");
  return toSecret(created);
}

interface StoredConnection {
  provider: "anlyon" | "nango";
  integrationId: string;
  integrationKey: string;
  connectionId: string;
}

export async function putConnectionSecret(
  workspaceId: string,
  name: string,
  input: {
    integrationId: string;
    connectionId: string;
    allowedHosts: string[];
    description?: string;
  },
  environmentId: string,
): Promise<SecretView> {
  const entry = findIntegration(input.integrationId);
  if (!entry) throw new ValidationError(`Unknown integration: ${input.integrationId}`);
  if (input.allowedHosts.length === 0 || !input.allowedHosts.every(isBareHostname)) {
    throw new ValidationError(`A connected account must be bound to at least one bare hostname; ${name} was not created.`);
  }
  const [existing] = await db
    .select()
    .from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, environmentId), eq(workspaceSecrets.name, name)));
  if (existing) {
    if (existing.kind !== "connection") throw new SecretKindMismatchError(name, existing.kind);
    throw new ValidationError(`Secret ${name} already exists. Disconnect it first, or choose another name.`);
  }

  await checkSecretQuota(workspaceId);

  if (entry.auth.kind !== "oauth") throw new ValidationError(`${entry.displayName} is connected with an API key, not a consent flow.`);
  const stored: StoredConnection = {
    provider: "anlyon",
    integrationId: entry.id,
    integrationKey: entry.id,
    connectionId: input.connectionId,
  };
  const valueEncrypted = encryptSecret(JSON.stringify(stored), env.DELIVERY_SECRET_MASTER_KEY, {
    store: "vault",
    workspaceId,
    environmentId,
    name,
  });
  const [created] = await db
    .insert(workspaceSecrets)
    .values({
      workspaceId,
      environmentId,
      secretId: generateSecretId(),
      name,
      valueEncrypted,
      description: input.description ?? null,
      allowedHosts: [...input.allowedHosts],
      allowedPlacements: ["header"],
      kind: "connection",
      connection: { provider: "anlyon", integrationId: entry.id, connectionId: input.connectionId },
      integrationId: entry.id,
      health: checkedNow(),
    })
    .returning();

  logger.info({ workspaceId, name, integrationId: entry.id, connectionId: input.connectionId }, "Connection secret created");
  return toSecret(created);
}

export interface ExternalSecretWarning {
  code: "EXTERNAL_SECRET_UNREADABLE";
  reason: "store_unreachable" | "store_denied" | "reference_not_found";
  message: string;
}

const WARNING_TEXT: Record<ExternalSecretWarning["reason"], string> = {
  store_unreachable: "the store did not answer",
  store_denied: "the store refused Anlyon's credential for it",
  reference_not_found: "the store has no secret at that path, version or key",
};

export async function putExternalSecret(
  workspaceId: string,
  name: string,
  input: {
    external: { store: string; path: string; key?: string | null; version?: string | null };
    description?: string;
    allowedHosts?: string[] | null;
    allowedPlacements?: string[] | null;
  },
  environmentId?: string,
): Promise<{ secret: SecretView; warning: ExternalSecretWarning | null }> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const scope = { workspaceId, environmentId: scopedEnvironmentId };
  const [existing] = await db
    .select()
    .from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, scopedEnvironmentId), eq(workspaceSecrets.name, name)));
  if (existing && existing.kind !== "external") throw new SecretKindMismatchError(name, existing.kind === "connection" ? "connection" : "static");

  const hostsAfter = input.allowedHosts !== undefined ? input.allowedHosts : existing?.allowedHosts ?? null;
  if (!hostsAfter || hostsAfter.length === 0) {
    throw new ValidationError(
      `An external secret must name the hosts it may be sent to (allowedHosts); ${name} was not saved.`,
    );
  }
  const placementsAfter =
    input.allowedPlacements !== undefined ? input.allowedPlacements : existing ? existing.allowedPlacements : ["header"];

  const resolved = await resolveReference(scope, input.external);
  let warning: ExternalSecretWarning | null = null;
  try {
    await readExternalValue(scope, resolved.storeRowId, resolved.location, { bypassCache: true });
  } catch (error) {
    if (!(error instanceof StoreReadError)) throw error;
    logger.warn({ workspaceId, name, store: resolved.store, reason: error.reason, detail: error.message }, "External secret saved, and its store could not produce it");
    warning = {
      code: "EXTERNAL_SECRET_UNREADABLE",
      reason: error.reason,
      message: `Secret ${name} was saved, and secret store ${resolved.store} could not produce it just now: ${WARNING_TEXT[error.reason]}. Calls that use it fail before anything is sent until the store can.`,
    };
  }

  const ref: SecretExternalRef = {
    storeRowId: resolved.storeRowId, store: resolved.store, storeType: resolved.storeType,
    path: resolved.location.path, key: resolved.location.key, version: resolved.location.version,
  };
  const valueEncrypted = encryptSecret(JSON.stringify(ref), env.DELIVERY_SECRET_MASTER_KEY, {
    store: "vault", workspaceId, environmentId: scopedEnvironmentId, name,
  });
  const health: SecretHealth = warning
    ? { status: "unreachable", checkedAt: new Date().toISOString(), reason: warning.reason }
    : checkedNow();

  if (existing) {
    const [updated] = await db
      .update(workspaceSecrets)
      .set({
        valueEncrypted,
        secretStoreId: resolved.storeRowId,
        external: ref,
        health,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.allowedHosts !== undefined ? { allowedHosts: input.allowedHosts } : {}),
        ...(input.allowedPlacements !== undefined ? { allowedPlacements: input.allowedPlacements } : {}),
        updatedAt: new Date(),
      })
      .where(eq(workspaceSecrets.id, existing.id))
      .returning();
    logger.info({ workspaceId, name, store: resolved.store }, "External secret repointed");
    return { secret: toSecret(updated), warning };
  }

  await checkSecretQuota(workspaceId);
  const [created] = await db
    .insert(workspaceSecrets)
    .values({
      workspaceId,
      environmentId: scopedEnvironmentId,
      secretId: generateSecretId(),
      name,
      valueEncrypted,
      description: input.description ?? null,
      allowedHosts: hostsAfter,
      allowedPlacements: placementsAfter,
      kind: "external",
      secretStoreId: resolved.storeRowId,
      external: ref,
      health,
    })
    .returning();
  logger.info({ workspaceId, name, store: resolved.store }, "External secret created");
  return { secret: toSecret(created), warning };
}

export type SecretMatch = { workspaceId: string; environmentId: string; name: string } | { connectionId: string };

function whereMatch(match: SecretMatch) {
  return "connectionId" in match
    ? and(eq(workspaceSecrets.kind, "connection"), sql`${workspaceSecrets.connection}->>'connectionId' = ${match.connectionId}`)
    : and(eq(workspaceSecrets.workspaceId, match.workspaceId), eq(workspaceSecrets.environmentId, match.environmentId), eq(workspaceSecrets.name, match.name));
}

export async function markSecretNeedsReauth(match: SecretMatch, reason: SecretHealthReason): Promise<number> {
  const rows = await db.select().from(workspaceSecrets).where(whereMatch(match));
  let marked = 0;
  for (const row of rows) {
    const current = healthOf(row);
    if (!current || current.status === "needs_reauth") continue;
    const health: SecretHealth = { status: "needs_reauth", checkedAt: new Date().toISOString(), reason };
    await db.update(workspaceSecrets).set({ health, updatedAt: new Date() }).where(eq(workspaceSecrets.id, row.id));
    logger.warn({ workspaceId: row.workspaceId, name: row.name, integrationId: row.integrationId, reason }, "Connected account needs reauthorisation");
    const integrationId = row.integrationId ?? row.connection?.integrationId ?? null;
    emitEvent(row.workspaceId, "secret.needs_reauth", {
      environmentId: row.environmentId, secretName: row.name, integrationId, reason,
    });
    void notifyTeamIfEnabled({
      workspaceId: row.workspaceId,
      type: "connection_broken",
      priority: "high",
      title: `Reconnect ${row.name}`,
      message: "This connected account stopped working. Calls that use it are refused before anything is sent, until it is reconnected.",
      metadata: { environmentId: row.environmentId, secretName: row.name, integrationId, reason },
      actionUrl: `${env.CONSOLE_URL}/integrations${integrationId ? `?integration=${encodeURIComponent(integrationId)}` : ""}`,
      actionLabel: "Reconnect",
    });
    marked++;
  }
  return marked;
}

export async function markSecretHealthy(match: SecretMatch): Promise<SecretView | null> {
  const rows = await db.select().from(workspaceSecrets).where(whereMatch(match));
  let last: SecretView | null = null;
  for (const row of rows) {
    if (!healthOf(row)) continue;
    const [updated] = await db.update(workspaceSecrets).set({ health: checkedNow(), updatedAt: new Date() })
      .where(eq(workspaceSecrets.id, row.id)).returning();
    last = toSecret(updated);
  }
  return last;
}

export async function listSecretsDueHealthCheck(checkedBefore: Date, limit: number): Promise<Array<{
  workspaceId: string; environmentId: string; name: string; kind: "static" | "connection" | "external"; integrationId: string | null;
}>> {
  const rows = await db.select({
    workspaceId: workspaceSecrets.workspaceId, environmentId: workspaceSecrets.environmentId,
    name: workspaceSecrets.name, kind: workspaceSecrets.kind, integrationId: workspaceSecrets.integrationId,
  }).from(workspaceSecrets)
    .where(and(
      or(
        and(isNotNull(workspaceSecrets.integrationId), sql`coalesce(${workspaceSecrets.health}->>'status', 'active') = 'active'`),
        eq(workspaceSecrets.kind, "external"),
      ),
      sql`((${workspaceSecrets.health}->>'checkedAt') is null or (${workspaceSecrets.health}->>'checkedAt')::timestamptz < ${checkedBefore.toISOString()}::timestamptz)`,
    ))
    .orderBy(sql`(${workspaceSecrets.health}->>'checkedAt') nulls first`)
    .limit(limit);
  return rows.map((row) => ({ ...row, kind: row.kind === "connection" || row.kind === "external" ? row.kind : "static" }));
}

export async function withStaticSecretValue<T>(
  workspaceId: string,
  environmentId: string,
  name: string,
  check: (value: string) => Promise<T>,
): Promise<T> {
  const [row] = await db.select().from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, environmentId), eq(workspaceSecrets.name, name)));
  if (!row) throw new SecretNotFoundError(`Secret not found: ${name}`);
  if (row.kind !== "static") throw new SecretKindMismatchError(name, row.kind);
  const value = decryptSecret(row.valueEncrypted, env.DELIVERY_SECRET_MASTER_KEY, {
    store: "vault", workspaceId, environmentId: row.environmentId, name: row.name,
  });
  return check(value);
}

export async function connectionRefOfSecret(
  workspaceId: string,
  environmentId: string,
  name: string,
): Promise<{ integrationId: string; integrationKey: string; connectionId: string }> {
  const [row] = await db.select().from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, environmentId), eq(workspaceSecrets.name, name)));
  if (!row) throw new SecretNotFoundError(`Secret not found: ${name}`);
  if (row.kind !== "connection") throw new SecretKindMismatchError(name, row.kind);
  return readStoredConnection(row);
}

export async function secretsBoundToConnection(connectionId: string): Promise<Array<{ workspaceId: string; environmentId: string; name: string; integrationId: string | null }>> {
  return db.select({
    workspaceId: workspaceSecrets.workspaceId, environmentId: workspaceSecrets.environmentId, name: workspaceSecrets.name, integrationId: workspaceSecrets.integrationId,
  }).from(workspaceSecrets).where(whereMatch({ connectionId }));
}

export async function connectionIdOfSecret(workspaceId: string, environmentId: string, name: string): Promise<string | null | undefined> {
  const [row] = await db.select({ kind: workspaceSecrets.kind, connection: workspaceSecrets.connection })
    .from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, environmentId), eq(workspaceSecrets.name, name)));
  if (!row) return undefined;
  return row.kind === "connection" ? row.connection?.connectionId ?? null : null;
}

export async function listSecrets(workspaceId: string, environmentId?: string): Promise<SecretView[]> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const rows = await db
    .select()
    .from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, scopedEnvironmentId)));

  return rows.map(toSecret);
}

export async function getSecretMetadata(
  workspaceId: string,
  name: string,
  environmentId?: string,
): Promise<SecretView> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const [row] = await db
    .select()
    .from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, scopedEnvironmentId), eq(workspaceSecrets.name, name)));

  if (!row) throw new SecretNotFoundError(`Secret not found: ${name}`);
  return toSecret(row);
}

export async function deleteSecret(
  workspaceId: string,
  name: string,
  environmentId?: string,
  options: { confirmProtected?: boolean } = {},
): Promise<void> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  await assertNotProtected(
    workspaceId,
    scopedEnvironmentId,
    "deleting a secret",
    options.confirmProtected,
  );
  const [row] = await db
    .select()
    .from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, scopedEnvironmentId), eq(workspaceSecrets.name, name)));

  if (!row) throw new SecretNotFoundError(`Secret not found: ${name}`);

  if (row.kind === "connection") {
    const stored = readStoredConnection(row);
    try {
      await requireConnectionProvider().deleteConnection({ integrationKey: stored.integrationKey, connectionId: stored.connectionId });
    } catch (error) {
      logger.error(
        { workspaceId, name, connectionId: stored.connectionId, error: error instanceof Error ? error.message : String(error) },
        "Revoking a connection failed; the secret was kept",
      );
      throw new ConnectionRevokeFailedError(name);
    }
  }

  await db.delete(workspaceSecrets).where(eq(workspaceSecrets.id, row.id));
  logger.info({ workspaceId, name }, "Secret deleted");
  if (row.kind === "connection") {
    emitEvent(workspaceId, "secret.disconnected", {
      environmentId: scopedEnvironmentId, secretName: name, integrationId: row.connection?.integrationId ?? null,
    });
  }
}

export async function countSecrets(workspaceId: string): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(workspaceSecrets)
    .where(eq(workspaceSecrets.workspaceId, workspaceId));
  return total;
}

export interface SecretPolicy {
  name: string;
  kind: "static" | "connection" | "external";
  allowedHosts: string[] | null;
  allowedPlacements: string[] | null;
  accountIntegration?: string | null;
}

function hasAccountHost(integration: string | null): boolean {
  const entry = integration ? findIntegration(integration) : undefined;
  return entry !== undefined && accountHostTemplate(entry) !== null;
}

function fitsAccountHost(integration: string, host: string): boolean {
  try {
    assertAccountHost(findIntegration(integration)!, host);
    return true;
  } catch {
    return false;
  }
}

export async function loadSecretPolicies(
  workspaceId: string,
  names: string[],
  environmentId?: string,
  accountHost?: string | null,
): Promise<Map<string, SecretPolicy>> {
  const policies = new Map<string, SecretPolicy>();
  if (names.length === 0) return policies;
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);

  for (const name of names.filter(isConnectionRef)) {
    const entry = connectionRefEntry(name);
    if (accountHostTemplate(entry)) {
      policies.set(name, {
        name, kind: "connection", allowedPlacements: ["header"], accountIntegration: entry.id,
        allowedHosts: accountHost ? [accountHost] : [ACCOUNT_HOST_PLACEHOLDER],
      });
      continue;
    }
    policies.set(name, { name, kind: "connection", allowedHosts: [...(entry.hosts as string[])], allowedPlacements: ["header"] });
  }
  names = names.filter((name) => !isConnectionRef(name));
  if (names.length === 0) return policies;

  const rows = await db
    .select({
      name: workspaceSecrets.name,
      kind: workspaceSecrets.kind,
      allowedHosts: workspaceSecrets.allowedHosts,
      allowedPlacements: workspaceSecrets.allowedPlacements,
      integrationId: workspaceSecrets.integrationId,
      connection: workspaceSecrets.connection,
    })
    .from(workspaceSecrets)
    .where(
      and(
        eq(workspaceSecrets.workspaceId, workspaceId),
        eq(workspaceSecrets.environmentId, scopedEnvironmentId),
        inArray(workspaceSecrets.name, names)
      )
    );

  for (const row of rows) {
    const integration = row.integrationId ?? (row.kind === "connection" ? row.connection?.integrationId ?? null : null);
    if (hasAccountHost(integration)) {
      policies.set(row.name, {
        name: row.name, kind: row.kind, allowedPlacements: ["header"], accountIntegration: integration,
        allowedHosts: accountHost ? [accountHost] : [...(row.allowedHosts ?? []).filter((h) => fitsAccountHost(integration!, h)), ACCOUNT_HOST_PLACEHOLDER],
      });
      continue;
    }
    policies.set(row.name, {
      name: row.name,
      kind: row.kind,
      allowedHosts: row.allowedHosts ?? null,
      allowedPlacements: row.allowedPlacements ?? null,
    });
  }

  const missing = names.filter((n) => !policies.has(n));
  if (missing.length > 0) {
    throw new SecretNotFoundError(`Secret${missing.length > 1 ? "s" : ""} not found: ${missing.join(", ")}`);
  }

  return policies;
}

export async function assertSecretsMayReachHost(
  workspaceId: string,
  names: string[],
  url: string,
  environmentId?: string,
  accountHost?: string | null,
): Promise<void> {
  const policies = await loadSecretPolicies(workspaceId, names, environmentId, accountHost);

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new ValidationError(`Could not determine the destination host for: ${url}`);
  }

  for (const policy of policies.values()) {
    if (!policy.allowedHosts || policy.allowedHosts.length === 0) {
      if (policy.kind === "external") {
        throw new ValidationError(
          `Secret ${policy.name} is read from your secret store and has no allowed hosts, so it is not sent anywhere. ` +
            `Set allowed hosts on secret ${policy.name} (to send it here, include ${host}): in the console, Actions > Secrets > ` +
            `Add from a store with the same name, store and path; or PUT /secrets/${policy.name} with its "external" ` +
            `reference and "allowedHosts": ["${host}"].`,
        );
      }
      continue;
    }

    const allowed = policy.allowedHosts.some((entry) => {
      const want = entry.toLowerCase().trim();
      return want.startsWith(".") ? host.endsWith(want) : host === want;
    });

    if (!allowed) {
      throw new ValidationError(
        `Secret ${policy.name} may only be sent to ${policy.allowedHosts.join(", ")}, and this request addresses ${host}.`
      );
    }
  }
}

function connectionRefEntry(name: string) {
  const integration = connectionRefIntegration(name);
  const entry = findIntegration(integration);
  if (!entry) {
    throw new ValidationError(`{{${name}}} names no integration that can be connected.`);
  }
  if (!Array.isArray(entry.hosts) && !accountHostTemplate(entry)) {
    throw new ValidationError(`{{${name}}}: ${entry.displayName}'s API host differs per account. Reference a connected account's secret with {{secret:NAME}} instead.`);
  }
  return entry;
}

export async function resolveAccountHost(
  workspaceId: string,
  names: string[],
  environmentId: string,
  endUser: EndUserContext = NO_END_USER,
): Promise<string | null> {
  const refs = names.filter(isConnectionRef).filter((name) => hasAccountHost(connectionRefIntegration(name)));
  const stored = names.filter((name) => !isConnectionRef(name));
  const rows = stored.length === 0 ? [] : (await db.select().from(workspaceSecrets).where(and(
    eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, environmentId), inArray(workspaceSecrets.name, stored),
  ))).filter((row) => hasAccountHost(integrationOfRow(row)));
  const credentials = [
    ...refs.map((name) => ({ name, integration: connectionRefIntegration(name), row: null as SecretRow | null })),
    ...rows.map((row) => ({ name: row.name, integration: integrationOfRow(row)!, row })),
  ];
  if (credentials.length === 0) return null;
  if (credentials.length > 1) {
    throw new ValidationError(`An action may send one account whose host differs per account; this one sends ${credentials.map((c) => c.name).join(" and ")}.`);
  }
  const [only] = credentials as [typeof credentials[number]];
  const entry = findIntegration(only.integration)!;
  if (endUser.endUserId !== null || endUser.required) {
    if (!endUser.endUserId) throw new EndUserRequiredError();
    const { endUserAccountHost } = await import("../end-users/connections.ts");
    return endUserAccountHost({ workspaceId, environmentId }, only.integration, endUser.endUserId);
  }
  const row = only.row ?? await workspaceConnectionRow(workspaceId, environmentId, only.name);
  if (row.allowedHosts?.length !== 1) {
    throw new ValidationError(`Secret ${row.name} is a ${entry.displayName} account that is not bound to one host, so nothing was sent. Connect it again.`);
  }
  return assertAccountHost(entry, row.allowedHosts[0]);
}

function integrationOfRow(row: SecretRow): string | null {
  return row.integrationId ?? (row.kind === "connection" ? row.connection?.integrationId ?? null : null);
}

export async function endUserIntegrationsFor(workspaceId: string, names: string[], environmentId: string): Promise<string[]> {
  const integrations = new Set(names.filter(isConnectionRef).map(connectionRefIntegration));
  const stored = names.filter((name) => !isConnectionRef(name));
  if (stored.length > 0) {
    const rows = await db.select().from(workspaceSecrets).where(and(
      eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, environmentId), inArray(workspaceSecrets.name, stored),
    ));
    for (const row of rows) {
      const integration = integrationOfRow(row);
      if (integration) integrations.add(integration);
    }
  }
  return [...integrations];
}

async function workspaceConnectionRow(workspaceId: string, environmentId: string, name: string): Promise<SecretRow> {
  const integration = connectionRefIntegration(name);
  const rows = (await db.select().from(workspaceSecrets).where(and(
    eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, environmentId),
  ))).filter((row) => integrationOfRow(row) === integration);
  if (rows.length === 0) {
    throw new SecretNotFoundError(`{{${name}}} needs a connected ${findIntegration(integration)?.displayName ?? integration} account in this environment, or a call made for an end user.`);
  }
  if (rows.length > 1) {
    throw new ValidationError(`{{${name}}} is ambiguous: this environment has ${rows.length} connected accounts for it (${rows.map((r) => r.name).join(", ")}). Reference one with {{secret:NAME}}.`);
  }
  return rows[0];
}

export async function resolveSecrets(
  workspaceId: string,
  names: string[],
  environmentId?: string,
  endUser: EndUserContext = NO_END_USER,
  accountHost?: string | null,
): Promise<Map<string, string>> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const resolved = new Map<string, string>();
  if (names.length === 0) return resolved;
  const scope = { workspaceId, environmentId: scopedEnvironmentId };
  const set = (name: string, credential: ComposedCredential) => {
    resolved.set(name, credential.value);
    credential.redact.forEach((value, i) => resolved.set(`${name}#${i}`, value));
  };
  const forEndUser = async (name: string, integration: string): Promise<void> => {
    if (!endUser.endUserId) throw new EndUserRequiredError();
    const { endUserCredentialParts } = await import("../end-users/connections.ts");
    set(name, await endUserCredentialParts(scope, integration, endUser.endUserId, accountHost));
  };
  const actsForEndUser = endUser.endUserId !== null || endUser.required;
  const storedKey = (row: SecretRow): ComposedCredential => {
    const value = decryptSecret(row.valueEncrypted, env.DELIVERY_SECRET_MASTER_KEY, {
      store: "vault", workspaceId, environmentId: row.environmentId, name: row.name,
    });
    const entry = findIntegration(integrationOfRow(row) ?? "");
    if (!entry) return { value, redact: [] };
    if (accountHostTemplate(entry) && accountHost !== undefined) {
      if (row.allowedHosts?.length !== 1 || row.allowedHosts[0] !== accountHost) {
        throw new ValidationError(`Secret ${row.name} is not bound to ${accountHost ?? "the host this request addresses"}, so nothing was sent.`);
      }
    }
    return composeCredential(entry, value);
  };

  for (const name of names.filter(isConnectionRef)) {
    connectionRefEntry(name);
    if (actsForEndUser) {
      await forEndUser(name, connectionRefIntegration(name));
      continue;
    }
    const row = await workspaceConnectionRow(workspaceId, scopedEnvironmentId, name);
    if (row.kind === "connection") resolved.set(name, await connectionToken(workspaceId, row));
    else set(name, storedKey(row));
  }
  names = names.filter((name) => !isConnectionRef(name));
  if (names.length === 0) return resolved;

  const rows = await db
    .select()
    .from(workspaceSecrets)
    .where(
      and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, scopedEnvironmentId), inArray(workspaceSecrets.name, names))
    );

  const found = new Set(rows.map((r) => r.name));
  const missing = names.filter((n) => !found.has(n));
  if (missing.length > 0) {
    throw new SecretNotFoundError(`Secret${missing.length > 1 ? "s" : ""} not found: ${missing.join(", ")}`);
  }

  for (const row of rows) {
    const integration = integrationOfRow(row);
    if (integration && actsForEndUser) {
      const entry = findIntegration(integration);
      if (entry && !Array.isArray(entry.hosts) && !accountHostTemplate(entry)) {
        throw new ValidationError(`Secret ${row.name} is a ${entry.displayName} account, whose API host differs per account, so it cannot be used for an end user.`);
      }
      await forEndUser(row.name, integration);
      continue;
    }
    if (row.kind === "connection") {
      resolved.set(row.name, await connectionToken(workspaceId, row));
      continue;
    }
    if (row.kind === "external") {
      resolved.set(row.name, await externalValue(row));
      continue;
    }
    if (integration) {
      set(row.name, storedKey(row));
      continue;
    }
    resolved.set(row.name, decryptSecret(row.valueEncrypted, env.DELIVERY_SECRET_MASTER_KEY, {
      store: "vault",
      workspaceId,
      environmentId: row.environmentId,
      name: row.name,
    }));
  }

  await db
    .update(workspaceSecrets)
    .set({ lastUsedAt: new Date() })
    .where(
      and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, scopedEnvironmentId), inArray(workspaceSecrets.name, names))
    );

  return resolved;
}

function readStoredConnection(row: SecretRow): StoredConnection {
  const plain = decryptSecret(row.valueEncrypted, env.DELIVERY_SECRET_MASTER_KEY, {
    store: "vault",
    workspaceId: row.workspaceId,
    environmentId: row.environmentId,
    name: row.name,
  });
  const parsed = JSON.parse(plain) as StoredConnection;
  if (!parsed?.integrationKey || !parsed.connectionId) throw new ValidationError(`Secret ${row.name} has an unreadable connection reference.`);
  return parsed.provider === "anlyon" ? parsed : { ...parsed, integrationKey: parsed.integrationId };
}

async function connectionToken(workspaceId: string, row: SecretRow): Promise<string> {
  const stored = readStoredConnection(row);
  try {
    return await requireConnectionProvider().getAccessToken({ integrationKey: stored.integrationKey, connectionId: stored.connectionId });
  } catch (error) {
    if (error instanceof ConnectionRevokedError) {
      await markSecretNeedsReauth({ workspaceId, environmentId: row.environmentId, name: row.name }, "access_revoked");
      throw new ConnectionNeedsReauthError(row.name);
    }
    if (error instanceof ConnectionsUnavailableError) throw error;
    logger.error(
      { workspaceId, name: row.name, connectionId: stored.connectionId, error: error instanceof Error ? error.message : String(error) },
      "Fetching a connection token failed",
    );
    throw new ConnectionProviderError(
      `The token for connected account ${row.name} could not be fetched. Nothing was sent. Try again shortly.`,
    );
  }
}

function readStoredExternal(row: SecretRow): SecretExternalRef {
  const plain = decryptSecret(row.valueEncrypted, env.DELIVERY_SECRET_MASTER_KEY, {
    store: "vault",
    workspaceId: row.workspaceId,
    environmentId: row.environmentId,
    name: row.name,
  });
  const parsed = JSON.parse(plain) as SecretExternalRef;
  if (!parsed?.storeRowId || !parsed.path) throw new ValidationError(`Secret ${row.name} has an unreadable store reference.`);
  return parsed;
}

async function recordExternalHealth(row: SecretRow, reason: SecretHealthReason | null): Promise<SecretHealth> {
  const health: SecretHealth = { status: reason ? "unreachable" : "active", checkedAt: new Date().toISOString(), reason };
  await db.update(workspaceSecrets).set({ health }).where(eq(workspaceSecrets.id, row.id));
  return health;
}

async function externalValue(row: SecretRow): Promise<string> {
  const ref = readStoredExternal(row);
  try {
    const { value } = await readExternalValue(
      { workspaceId: row.workspaceId, environmentId: row.environmentId },
      ref.storeRowId,
      { path: ref.path, key: ref.key, version: ref.version },
    );
    if (row.health && row.health.status !== "active") await recordExternalHealth(row, null);
    return value;
  } catch (error) {
    if (!(error instanceof StoreReadError)) throw error;
    logger.warn({ workspaceId: row.workspaceId, name: row.name, store: ref.store, reason: error.reason, detail: error.message }, "Reading an external secret failed; nothing was sent");
    if (row.health?.status !== "unreachable" || row.health.reason !== error.reason) await recordExternalHealth(row, error.reason);
    throw new ExternalSecretUnavailableError(row.name, ref.store, error.reason);
  }
}

export async function checkExternalSecret(workspaceId: string, environmentId: string, name: string): Promise<SecretView> {
  const [row] = await db.select().from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.environmentId, environmentId), eq(workspaceSecrets.name, name)));
  if (!row) throw new SecretNotFoundError(`Secret not found: ${name}`);
  if (row.kind !== "external") {
    throw new ValidationError(
      `Secret ${name} is not read from a secret store. A connected account is checked with POST /api/v2/connections/${name}/check, and a stored value cannot be checked.`,
    );
  }
  const ref = readStoredExternal(row);
  let reason: SecretHealthReason | null = null;
  try {
    await readExternalValue({ workspaceId, environmentId }, ref.storeRowId, { path: ref.path, key: ref.key, version: ref.version }, { bypassCache: true });
  } catch (error) {
    if (!(error instanceof StoreReadError)) throw error;
    reason = error.reason;
    logger.warn({ workspaceId, name, store: ref.store, reason, detail: error.message }, "External secret check failed");
  }
  const health = await recordExternalHealth(row, reason);
  return toSecret({ ...row, health });
}
