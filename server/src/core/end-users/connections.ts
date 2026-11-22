import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, like, lt, or, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { env } from "../../config/env.ts";
import { oauthConnections, type OAuthConnectionRow } from "../../db/schema/oauth-connections.ts";
import { actionInvocations } from "../../db/schema/actions.ts";
import { approvals } from "../../db/schema/approvals.ts";
import { actionEffects, effectPreviews, impactLimitPeriods, impactLimits } from "../../db/schema/effects.ts";
import { auditEvents } from "../../db/schema/audit.ts";
import { functionRuns } from "../../db/schema/functions.ts";
import { endUserErasures } from "../../db/schema/end-user-erasures.ts";
import { redis } from "../../lib/redis.ts";
import { createLogger } from "../../lib/logger.ts";
import { decryptSecret, encryptSecret } from "../../utils/crypto.ts";
import {
  ConnectionProviderError,
  ConnectionsUnavailableError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "../../utils/errors.ts";
import { emitEvent } from "../events/emitter.ts";
import { flushAuditEvents, recordAuditEvent } from "../audit/recorder.ts";
import type { AuditActor } from "../audit/event-schema.ts";
import {
  accountHostTemplate,
  assertAccountHost,
  CATALOGUE,
  composeCredential,
  connectableIntegration,
  findIntegration,
  keyAuthOf,
  readCredentialInput,
  rowHoldsKey,
  SIGNED_IN_MARK,
  type ComposedCredential,
  type CredentialInput,
} from "../connections/catalogue.ts";
import { checkKey, HEALTH_SWEEP_BATCH, keyVerdict } from "../connections/health.ts";
import { ConnectionRevokedError, endUserIdFor, requireConnectionProvider } from "../connections/provider.ts";
import { isUpstreamKey } from "../connections/native.ts";
import { rowHoldsUpstreamKey, UPSTREAM_KEY_MARK } from "../mcp-upstreams/end-user-key.ts";
import { connectLinkForRetry, upstreamConnectLinkForRetry } from "./connect.ts";
import { EndUserConnectionError, type ConnectLinkView, type EndUserConnectionCode } from "./errors.ts";
import { endUserCounterTag, erasedEndUserId, ERASED_PREFIX } from "./identity.ts";

const logger = createLogger({ module: "end-users" });

type Scope = { workspaceId: string; environmentId: string };

export const KEYS_PER_MINUTE_PER_END_USER = 10;

export interface EndUserConnectionView {
  integration: string;
  kind: "oauth" | "api_key";
  status: "active" | "needs_reconnect";
  scopes: string[];
  connectedAt: Date;
  updatedAt: Date;
}

function encryptionKey(): string {
  if (!env.CONNECTIONS_ENCRYPTION_KEY) throw new ConnectionsUnavailableError();
  return env.CONNECTIONS_ENCRYPTION_KEY;
}

const accessContext = (row: { id: string; workspaceId: string }) =>
  ({ store: "oauth-connection" as const, workspaceId: row.workspaceId, name: `${row.id}:access` });

function kindOf(row: Pick<OAuthConnectionRow, "integrationKey" | "connectionConfig">): "oauth" | "api_key" {
  return rowHoldsKey(row) || rowHoldsUpstreamKey(row) ? "api_key" : "oauth";
}

function toView(row: OAuthConnectionRow): EndUserConnectionView {
  const kind = kindOf(row);
  return {
    integration: row.integrationKey,
    kind,
    status: row.revokedAt ? "needs_reconnect" : "active",
    scopes: kind === "oauth" && row.scopes ? row.scopes.split(/[\s,]+/).filter(Boolean) : [],
    connectedAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function ownRows(scope: Scope, endUserId: string) {
  return and(
    eq(oauthConnections.workspaceId, scope.workspaceId),
    eq(oauthConnections.environmentId, scope.environmentId),
    eq(oauthConnections.subjectEndUserId, endUserId),
    isNull(oauthConnections.pendingConfirmationUntil),
  );
}

export async function listEndUserConnections(scope: Scope, endUserId: string): Promise<EndUserConnectionView[]> {
  const rows = await db.select().from(oauthConnections).where(ownRows(scope, endUserId)).orderBy(asc(oauthConnections.integrationKey));
  return rows.map(toView);
}

async function limitKeyRate(scope: Scope, endUserId: string): Promise<void> {
  const window = Math.floor(Date.now() / 60_000);
  const key = `ratelimit:end-user-keys:${scope.environmentId}:${endUserCounterTag(endUserId)}:${window}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 60);
  if (n > KEYS_PER_MINUTE_PER_END_USER) {
    throw new RateLimitError(`At most ${KEYS_PER_MINUTE_PER_END_USER} keys may be stored per minute for one end user. Retry shortly.`);
  }
}

export async function setEndUserApiKey(
  scope: Scope,
  endUserId: string,
  integration: string,
  given: string | CredentialInput,
  actor: AuditActor,
): Promise<EndUserConnectionView> {
  const { connectionId: _id, ...view } = await storeEndUserKey(scope, endUserId, integration, typeof given === "string" ? { apiKey: given } : given, actor, null);
  return view;
}

export async function storeEndUserKey(
  scope: Scope,
  endUserId: string,
  integration: string,
  given: CredentialInput,
  actor: AuditActor,
  pendingUntil: Date | null,
): Promise<EndUserConnectionView & { connectionId: string }> {
  if (isUpstreamKey(integration)) return storeEndUserUpstreamKey(scope, endUserId, integration, given, actor, pendingUntil);
  const entry = connectableIntegration(integration, env.CONNECTIONS_ALLOW_UNVERIFIED);
  const keyAuth = keyAuthOf(entry);
  if (!keyAuth) {
    throw new ValidationError(`${entry.displayName} is connected by signing in. Create a connect link with POST /api/v2/end-users/{endUserId}/connect-links.`);
  }
  const { stored: token, accountHost } = readCredentialInput(entry, given);
  const key = encryptionKey();
  await limitKeyRate(scope, endUserId);
  await checkKey(entry, keyAuth, token, accountHost);

  const id = `oc_${randomBytes(18).toString("base64url")}`;
  const row = await db.transaction(async (tx) => {
    if (!pendingUntil) await tx.delete(oauthConnections).where(and(ownRows(scope, endUserId), eq(oauthConnections.integrationKey, entry.id)));
    const [created] = await tx.insert(oauthConnections).values({
      id,
      workspaceId: scope.workspaceId,
      environmentId: scope.environmentId,
      integrationKey: entry.id,
      endUserId: endUserIdFor(scope.workspaceId, scope.environmentId, `eul_${randomBytes(18).toString("hex")}`),
      subjectEndUserId: endUserId,
      accessTokenEncrypted: encryptSecret(token, key, accessContext({ id, workspaceId: scope.workspaceId })),
      refreshTokenEncrypted: null,
      expiresAt: null,
      scopes: null,
      connectionConfig: accountHost ? { host: accountHost } : {},
      pendingConfirmationUntil: pendingUntil,
    }).returning();
    return created;
  });
  logger.info({ workspaceId: scope.workspaceId, environmentId: scope.environmentId, integration: entry.id, pending: Boolean(pendingUntil) }, "End user's API key stored");
  if (!pendingUntil) {
    emitEvent(scope.workspaceId, "end_user.connected", { environmentId: scope.environmentId, endUserId, integration: entry.id });
    recordAuditEvent({
      workspaceId: scope.workspaceId, environmentId: scope.environmentId, endUserId, type: "end_user.connected", actor,
      resource: { type: "end_user", id: endUserId }, data: { integration: entry.id, kind: "api_key" },
    });
  }
  return { ...toView(row), connectionId: row.id };
}

async function storeEndUserUpstreamKey(
  scope: Scope,
  endUserId: string,
  integrationKey: string,
  given: CredentialInput,
  actor: AuditActor,
  pendingUntil: Date | null,
): Promise<EndUserConnectionView & { connectionId: string }> {
  if (given.fields) throw new ValidationError("An MCP server's key is one value: send it as apiKey.");
  const sealWith = encryptionKey();
  await limitKeyRate(scope, endUserId);
  const { checkEndUserKey } = await import("../mcp-upstreams/service.ts");
  const { key } = await checkEndUserKey(scope, integrationKey, given.apiKey);

  const id = `oc_${randomBytes(18).toString("base64url")}`;
  const row = await db.transaction(async (tx) => {
    if (!pendingUntil) await tx.delete(oauthConnections).where(and(ownRows(scope, endUserId), eq(oauthConnections.integrationKey, integrationKey)));
    const [created] = await tx.insert(oauthConnections).values({
      id,
      workspaceId: scope.workspaceId,
      environmentId: scope.environmentId,
      integrationKey,
      endUserId: endUserIdFor(scope.workspaceId, scope.environmentId, `eul_${randomBytes(18).toString("hex")}`),
      subjectEndUserId: endUserId,
      accessTokenEncrypted: encryptSecret(key, sealWith, accessContext({ id, workspaceId: scope.workspaceId })),
      refreshTokenEncrypted: null,
      expiresAt: null,
      scopes: null,
      connectionConfig: { [UPSTREAM_KEY_MARK]: true },
      pendingConfirmationUntil: pendingUntil,
    }).returning();
    return created;
  });
  logger.info({ workspaceId: scope.workspaceId, environmentId: scope.environmentId, integration: integrationKey, pending: Boolean(pendingUntil) }, "End user's MCP server key stored");
  if (!pendingUntil) {
    emitEvent(scope.workspaceId, "end_user.connected", { environmentId: scope.environmentId, endUserId, integration: integrationKey });
    recordAuditEvent({
      workspaceId: scope.workspaceId, environmentId: scope.environmentId, endUserId, type: "end_user.connected", actor,
      resource: { type: "end_user", id: endUserId }, data: { integration: integrationKey, kind: "api_key" },
    });
  }
  return { ...toView(row), connectionId: row.id };
}

export async function endUserUpstreamKey(
  scope: Scope, integrationKey: string, endUserId: string,
): Promise<{ status: "active"; key: string } | { status: "missing" | "needs_reconnect" }> {
  const row = await liveRow(scope, integrationKey, endUserId);
  if (!row || !rowHoldsUpstreamKey(row)) return { status: "missing" };
  if (row.revokedAt) return { status: "needs_reconnect" };
  return { status: "active", key: decryptSecret(row.accessTokenEncrypted, encryptionKey(), accessContext(row)) };
}

async function disconnectRow(row: OAuthConnectionRow): Promise<void> {
  if (kindOf(row) === "oauth") {
    try {
      await requireConnectionProvider().deleteConnection({ integrationKey: row.integrationKey, connectionId: row.id });
      return;
    } catch (error) {
      logger.warn({ connectionId: row.id, error: error instanceof Error ? error.message : String(error) }, "Revoking an end user's grant failed; deleting it anyway");
    }
  }
  await db.delete(oauthConnections).where(eq(oauthConnections.id, row.id));
}

export async function deleteEndUserConnection(scope: Scope, endUserId: string, integration: string, actor: AuditActor): Promise<void> {
  const rows = await db.select().from(oauthConnections).where(and(ownRows(scope, endUserId), eq(oauthConnections.integrationKey, integration)));
  if (rows.length === 0) throw new NotFoundError("Connection");
  for (const row of rows) await disconnectRow(row);
  emitEvent(scope.workspaceId, "end_user.disconnected", { environmentId: scope.environmentId, endUserId, integration });
  recordAuditEvent({
    workspaceId: scope.workspaceId, environmentId: scope.environmentId, endUserId, type: "end_user.disconnected", actor,
    resource: { type: "end_user", id: endUserId }, data: { integration },
  });
}

async function linkFor409(integration: string, mint: () => Promise<ConnectLinkView | null>): Promise<ConnectLinkView | null> {
  try {
    return await mint();
  } catch (error) {
    logger.warn({ integration, error: error instanceof Error ? error.message : String(error) }, "No connect link for a 409");
    return null;
  }
}

function connectionWhat(code: EndUserConnectionCode, name: string): string {
  return code === "END_USER_NOT_CONNECTED"
    ? `This end user has not connected ${name}. Nothing was sent.`
    : `This end user's ${name} connection needs to be reconnected. Nothing was sent.`;
}

async function connectionError(scope: Scope, code: EndUserConnectionCode, integration: string, endUserId: string): Promise<EndUserConnectionError> {
  const entry = findIntegration(integration);
  const name = entry?.displayName ?? integration;
  const link = await linkFor409(integration, () => connectLinkForRetry(scope, endUserId, integration));
  const next = link
    ? " Send them to connectUrl."
    : entry && keyAuthOf(entry)
      ? ` Set a default redirect URL for this environment to get a connect link in this answer, or store their ${name} key with PUT /api/v2/end-users/{endUserId}/connections/${integration}.`
      : " Set a default redirect URL for this environment to get a connect link in this answer.";
  return new EndUserConnectionError(code, integration, endUserId, link, connectionWhat(code, name) + next, name);
}

async function liveRow(scope: Scope, integration: string, endUserId: string): Promise<OAuthConnectionRow | null> {
  const [row] = await db.select().from(oauthConnections)
    .where(and(ownRows(scope, endUserId), eq(oauthConnections.integrationKey, integration)))
    .orderBy(sql`${oauthConnections.revokedAt} IS NOT NULL`, desc(oauthConnections.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function assertEndUserConnected(scope: Scope, endUserId: string, integrations: readonly string[]): Promise<void> {
  for (const integration of new Set(integrations)) {
    const row = await liveRow(scope, integration, endUserId);
    if (!row) throw await connectionError(scope, "END_USER_NOT_CONNECTED", integration, endUserId);
    if (row.revokedAt) throw await connectionError(scope, "END_USER_RECONNECT_REQUIRED", integration, endUserId);
  }
}

export async function assertEndUserConnectedToUpstream(
  scope: Scope, endUserId: string, upstream: { integrationKey: string; name: string },
): Promise<void> {
  const row = await liveRow(scope, upstream.integrationKey, endUserId);
  if (row && !row.revokedAt) return;
  const code: EndUserConnectionCode = row ? "END_USER_RECONNECT_REQUIRED" : "END_USER_NOT_CONNECTED";
  const link = await linkFor409(upstream.integrationKey, () => upstreamConnectLinkForRetry(scope, endUserId, upstream.integrationKey));
  const next = link
    ? " Send them to connectUrl."
    : " Set a default redirect URL for this environment to get a connect link in this answer, or create one with POST /api/v2/mcp-upstreams/{id}/connect-links.";
  throw new EndUserConnectionError(code, upstream.integrationKey, endUserId, link, connectionWhat(code, upstream.name) + next, upstream.name);
}

export async function endUserCredential(scope: Scope, integration: string, endUserId: string): Promise<string> {
  return (await endUserCredentialParts(scope, integration, endUserId)).value;
}

export async function endUserAccountHost(scope: Scope, integration: string, endUserId: string): Promise<string> {
  const row = await liveRow(scope, integration, endUserId);
  if (!row) throw await connectionError(scope, "END_USER_NOT_CONNECTED", integration, endUserId);
  if (row.revokedAt) throw await connectionError(scope, "END_USER_RECONNECT_REQUIRED", integration, endUserId);
  const entry = findIntegration(integration);
  if (!entry) throw new ValidationError(`No integration named "${integration}".`);
  return assertAccountHost(entry, (row.connectionConfig as Record<string, unknown> | null)?.host);
}

export async function endUserCredentialParts(
  scope: Scope, integration: string, endUserId: string, expectedHost?: string | null,
): Promise<ComposedCredential> {
  const row = await liveRow(scope, integration, endUserId);
  if (!row) throw await connectionError(scope, "END_USER_NOT_CONNECTED", integration, endUserId);
  if (row.revokedAt) throw await connectionError(scope, "END_USER_RECONNECT_REQUIRED", integration, endUserId);
  if (kindOf(row) === "api_key") {
    const entry = findIntegration(integration)!;
    if (expectedHost !== undefined && accountHostTemplate(entry)) {
      const host = assertAccountHost(entry, (row.connectionConfig as Record<string, unknown> | null)?.host);
      if (host !== expectedHost) throw new ValidationError(`This end user's ${entry.displayName} account changed during the call. Nothing was sent. Try again.`);
    }
    return composeCredential(entry, decryptSecret(row.accessTokenEncrypted, encryptionKey(), accessContext(row)));
  }
  return { value: await endUserOAuthToken(scope, integration, endUserId, row), redact: [] };
}

async function endUserOAuthToken(scope: Scope, integration: string, endUserId: string, row: OAuthConnectionRow): Promise<string> {
  try {
    return await requireConnectionProvider().getAccessToken({ integrationKey: integration, connectionId: row.id });
  } catch (error) {
    if (error instanceof ConnectionRevokedError) {
      await db.update(oauthConnections).set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(oauthConnections.id, row.id), isNull(oauthConnections.revokedAt)));
      throw await connectionError(scope, "END_USER_RECONNECT_REQUIRED", integration, endUserId);
    }
    if (error instanceof ConnectionsUnavailableError) throw error;
    logger.error({ connectionId: row.id, integration, error: error instanceof Error ? error.message : String(error) }, "Fetching an end user's token failed");
    throw new ConnectionProviderError(`The end user's ${findIntegration(integration)?.displayName ?? integration} token could not be fetched. Nothing was sent. Try again shortly.`);
  }
}

export async function markEndUserConnectionRejected(scope: Scope, integration: string, endUserId: string): Promise<void> {
  await db.update(oauthConnections).set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(ownRows(scope, endUserId), eq(oauthConnections.integrationKey, integration), isNull(oauthConnections.revokedAt)));
}

export async function sweepEndUserKeyHealth(now = new Date()): Promise<{ checked: number; marked: number; skipped: number }> {
  const checkedBefore = new Date(now.getTime() - env.CONNECTION_HEALTH_CHECK_INTERVAL_MS);
  const keyIntegrations = CATALOGUE.filter((e) => keyAuthOf(e) !== null).map((e) => e.id);
  const due = await db.select().from(oauthConnections).where(and(
    isNotNull(oauthConnections.subjectEndUserId),
    isNull(oauthConnections.pendingConfirmationUntil),
    isNull(oauthConnections.revokedAt),
    inArray(oauthConnections.integrationKey, keyIntegrations),
    sql`(${oauthConnections.connectionConfig} ->> ${SIGNED_IN_MARK}) IS DISTINCT FROM 'true'`,
    or(isNull(oauthConnections.lastRefreshedAt), lt(oauthConnections.lastRefreshedAt, checkedBefore)),
  )).orderBy(sql`${oauthConnections.lastRefreshedAt} nulls first`).limit(HEALTH_SWEEP_BATCH);
  let checked = 0;
  let marked = 0;
  let skipped = 0;
  for (const row of due) {
    const entry = findIntegration(row.integrationKey);
    const keyAuth = entry ? keyAuthOf(entry) : null;
    if (!entry || !keyAuth || !rowHoldsKey(row)) { skipped++; continue; }
    let verdict: "accepted" | "rejected" | undefined;
    try {
      let accountHost: string | null = null;
      if (accountHostTemplate(entry)) {
        try {
          accountHost = assertAccountHost(entry, (row.connectionConfig as Record<string, unknown> | null)?.host);
        } catch {
          verdict = "rejected";
        }
      }
      verdict ??= await keyVerdict(entry, keyAuth,decryptSecret(row.accessTokenEncrypted, encryptionKey(), accessContext(row)), accountHost);
    } catch (error) {
      skipped++;
      logger.warn({ workspaceId: row.workspaceId, integration: row.integrationKey, error: error instanceof Error ? error.message : String(error) }, "Health sweep could not check an end user's key");
      continue;
    }
    checked++;
    const rejected = verdict === "rejected";
    if (rejected) marked++;
    await db.update(oauthConnections)
      .set({ lastRefreshedAt: now, ...(rejected ? { revokedAt: now, updatedAt: now } : {}) })
      .where(and(eq(oauthConnections.id, row.id), isNull(oauthConnections.revokedAt)));
  }
  if (checked > 0 || skipped > 0) logger.info({ checked, marked, skipped }, "End users' key health sweep completed");
  return { checked, marked, skipped };
}

export interface EndUserSummary {
  endUserId: string;
  connections: number;
  invocations: number;
  pendingApprovals: number;
}

export async function listEndUsers(
  scope: Scope,
  opts: { cursor?: string; limit?: number; prefix?: string; integration?: string } = {},
): Promise<{ endUsers: EndUserSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const after = opts.cursor ?? "";
  const prefix = opts.prefix ? `${opts.prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : "%";
  const ids = await db.execute<{ id: string }>(sql`
    SELECT id FROM (
      SELECT subject_end_user_id AS id FROM ${oauthConnections}
        WHERE environment_id = ${scope.environmentId} AND workspace_id = ${scope.workspaceId}
          AND subject_end_user_id IS NOT NULL AND pending_confirmation_until IS NULL
      UNION
      SELECT end_user_id AS id FROM ${actionInvocations}
        WHERE environment_id = ${scope.environmentId} AND workspace_id = ${scope.workspaceId} AND end_user_id IS NOT NULL
      UNION
      SELECT end_user_id AS id FROM ${approvals}
        WHERE environment_id = ${scope.environmentId} AND workspace_id = ${scope.workspaceId} AND end_user_id IS NOT NULL
    ) AS ids
    WHERE id > ${after} AND id NOT LIKE ${`${ERASED_PREFIX}%`} AND id LIKE ${prefix}
    ${opts.integration ? sql`AND id IN (
      SELECT subject_end_user_id FROM ${oauthConnections}
        WHERE environment_id = ${scope.environmentId} AND workspace_id = ${scope.workspaceId}
          AND integration_key = ${opts.integration} AND pending_confirmation_until IS NULL)` : sql``}
    ORDER BY id
    LIMIT ${limit + 1}`);
  const rows = (Array.isArray(ids) ? ids : (ids as { rows: { id: string }[] }).rows).map((r) => r.id);
  const page = rows.slice(0, limit);
  if (page.length === 0) return { endUsers: [], nextCursor: null };

  const envScope = (table: typeof actionInvocations | typeof approvals) =>
    and(eq(table.workspaceId, scope.workspaceId), eq(table.environmentId, scope.environmentId), inArray(table.endUserId, page));
  const [connections, invocations, pending] = await Promise.all([
    db.select({ id: oauthConnections.subjectEndUserId, n: count() }).from(oauthConnections)
      .where(and(eq(oauthConnections.workspaceId, scope.workspaceId), eq(oauthConnections.environmentId, scope.environmentId),
        inArray(oauthConnections.subjectEndUserId, page), isNull(oauthConnections.pendingConfirmationUntil)))
      .groupBy(oauthConnections.subjectEndUserId),
    db.select({ id: actionInvocations.endUserId, n: count() }).from(actionInvocations).where(envScope(actionInvocations)).groupBy(actionInvocations.endUserId),
    db.select({ id: approvals.endUserId, n: count() }).from(approvals)
      .where(and(envScope(approvals), eq(approvals.status, "pending"))).groupBy(approvals.endUserId),
  ]);
  const counted = (list: { id: string | null; n: number }[]) => new Map(list.map((r) => [r.id, Number(r.n)]));
  const c = counted(connections), i = counted(invocations), p = counted(pending);
  return {
    endUsers: page.map((id) => ({ endUserId: id, connections: c.get(id) ?? 0, invocations: i.get(id) ?? 0, pendingApprovals: p.get(id) ?? 0 })),
    nextCursor: rows.length > limit ? page[page.length - 1] : null,
  };
}

export interface ErasureResult {
  connectionsDeleted: number;
  approvalsCancelled: number;
  countersCleared: number;
  erasedAs: string;
}

export async function eraseEndUser(
  scope: Scope,
  endUserId: string,
  actor: AuditActor,
  cancelApprovals: (scope: Scope, endUserId: string) => Promise<number>,
): Promise<ErasureResult> {
  const erasedAs = erasedEndUserId(scope.workspaceId, endUserId);
  await flushAuditEvents();
  const accounts = await db.select().from(oauthConnections).where(and(
    eq(oauthConnections.workspaceId, scope.workspaceId),
    eq(oauthConnections.environmentId, scope.environmentId),
    eq(oauthConnections.subjectEndUserId, endUserId),
  ));
  for (const row of accounts) await disconnectRow(row);

  const approvalsCancelled = await cancelApprovals(scope, endUserId);

  const tag = endUserCounterTag(endUserId);
  const limitIds = (await db.select({ id: impactLimits.id }).from(impactLimits).where(and(
    eq(impactLimits.workspaceId, scope.workspaceId), eq(impactLimits.environmentId, scope.environmentId), eq(impactLimits.scope, "end_user"),
  ))).map((r) => r.id);
  const cleared = limitIds.length === 0 ? [] : await db.delete(impactLimitPeriods).where(and(
    inArray(impactLimitPeriods.limitId, limitIds),
    like(impactLimitPeriods.periodKey, `%|${tag}`),
    eq(impactLimitPeriods.reserved, 0),
  )).returning({ limitId: impactLimitPeriods.limitId });

  await db.transaction(async (tx) => {
    const kept = <T extends typeof actionInvocations | typeof approvals | typeof actionEffects | typeof effectPreviews>(table: T) =>
      and(eq(table.workspaceId, scope.workspaceId), eq(table.environmentId, scope.environmentId), eq(table.endUserId, endUserId));
    await tx.update(actionInvocations).set({ endUserId: erasedAs }).where(kept(actionInvocations));
    await tx.update(approvals).set({
      endUserId: erasedAs,
      payload: sql`case when jsonb_exists(${approvals.payload}, 'endUserId') then jsonb_set(${approvals.payload}, '{endUserId}', to_jsonb(${erasedAs}::text)) else ${approvals.payload} end`,
    }).where(kept(approvals));
    await tx.update(actionEffects).set({ endUserId: erasedAs }).where(kept(actionEffects));
    await tx.update(effectPreviews).set({ endUserId: erasedAs }).where(kept(effectPreviews));
    await tx.update(functionRuns).set({ endUserId: erasedAs }).where(and(
      eq(functionRuns.workspaceId, scope.workspaceId), eq(functionRuns.environmentId, scope.environmentId), eq(functionRuns.endUserId, endUserId),
    ));
    await tx.update(auditEvents).set({
      endUserId: erasedAs,
      resourceId: sql`case when ${auditEvents.resourceType} = 'end_user' and ${auditEvents.resourceId} = ${auditEvents.endUserId} then ${erasedAs}::text else ${auditEvents.resourceId} end`,
    }).where(and(
      eq(auditEvents.workspaceId, scope.workspaceId), eq(auditEvents.environmentId, scope.environmentId), eq(auditEvents.endUserId, endUserId),
    ));
    const erasedAt = new Date();
    await tx.insert(endUserErasures).values({ workspaceId: scope.workspaceId, environmentId: scope.environmentId, erasedAs, erasedAt })
      .onConflictDoUpdate({ target: [endUserErasures.environmentId, endUserErasures.erasedAs], set: { erasedAt } });
  });

  const result = { connectionsDeleted: accounts.length, approvalsCancelled, countersCleared: cleared.length, erasedAs };
  logger.info({ workspaceId: scope.workspaceId, environmentId: scope.environmentId, ...result }, "End user erased");
  recordAuditEvent({
    workspaceId: scope.workspaceId,
    environmentId: scope.environmentId,
    endUserId: erasedAs,
    type: "end_user.erased",
    actor,
    resource: { type: "end_user", id: erasedAs },
    data: { connectionsDeleted: result.connectionsDeleted, approvalsCancelled, countersCleared: result.countersCleared },
  });
  emitEvent(scope.workspaceId, "end_user.erased", { environmentId: scope.environmentId, endUserId: erasedAs });
  return result;
}

