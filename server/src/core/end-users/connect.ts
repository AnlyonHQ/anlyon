import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { env } from "../../config/env.ts";
import { environments } from "../../db/schema/environments.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { oauthConnections } from "../../db/schema/oauth-connections.ts";
import { redis } from "../../lib/redis.ts";
import { createLogger } from "../../lib/logger.ts";
import { ApiError, ConnectionsUnavailableError, NotFoundError, RateLimitError } from "../../utils/errors.ts";
import { emitEvent } from "../events/emitter.ts";
import { recordAuditEvent } from "../audit/recorder.ts";
import type { AuditActor } from "../audit/event-schema.ts";
import { connectableIntegration, findIntegration, keyAuthOf, type CredentialInput, type IntegrationEntry } from "../connections/catalogue.ts";
import { connectionProvider, endUserIdFor, requireConnectionProvider, type ConsentSubjectResult } from "../connections/provider.ts";
import { consentUrl } from "../connections/consent-urls.ts";
import { EndUserMismatchError, OwnOAuthAppRequiredError, RedirectUrlRequiredError, type ConnectLinkView } from "./errors.ts";
import { environmentOAuthClient } from "./oauth-apps.ts";
import { redirectWithResult, resolveRedirect } from "./redirects.ts";

const logger = createLogger({ module: "end-users-connect" });

export const CONNECT_LINK_TTL_MS = 10 * 60_000;
export const LINKS_PER_MINUTE_PER_END_USER = 10;
export const LINKS_PER_MINUTE_PER_ENVIRONMENT = 300;
export const KEY_LINK_ATTEMPTS = 5;
export const KEY_LINK_PATH = "/api/v2/connection-consent/key";
const REUSE_MIN_REMAINING_MS = 3 * 60_000;

type Scope = { workspaceId: string; environmentId: string };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const alnum = (bytes: number) => randomBytes(bytes).toString("base64url").replace(/[-_]/g, "").slice(0, 32);
const flowKey = (flowId: string) => `end-users:flow:${sha256(flowId)}`;
const reusableLinkKey = (scope: Scope, integration: string, endUserId: string) =>
  `end-users:link:${scope.environmentId}:${integration}:${sha256(endUserId).slice(0, 32)}`;
const FLOW_ID = /^flw_[A-Za-z0-9]{24,40}$/;
const KEY_LINK_TOKEN = /^kln_[A-Za-z0-9]{32}$/;
const keyLinkKey = (token: string) => `end-users:key-link:${sha256(token)}`;
const keyLinkTriesKey = (token: string) => `end-users:key-link-tries:${sha256(token)}`;

interface KeyLinkRecord {
  workspaceId: string;
  environmentId: string;
  endUserId: string;
  integration: string;
  redirectUrl: string | null;
  confirm: boolean;
  flowId: string;
}

interface FlowRecord {
  workspaceId: string;
  environmentId: string;
  endUserId: string;
  integration: string;
  connectionId: string;
}

export interface ConnectSettings {
  workspaceId: string;
  environmentId: string;
  workspaceName: string;
  allowedRedirectUrls: string[];
  defaultRedirectUrl: string | null;
  connectConfirmation: "required" | "off";
}

export async function connectSettings(scope: Scope): Promise<ConnectSettings> {
  const [row] = await db
    .select({ environment: environments, workspaceName: workspaces.name })
    .from(environments)
    .innerJoin(workspaces, eq(workspaces.id, environments.workspaceId))
    .where(and(eq(environments.id, scope.environmentId), eq(environments.workspaceId, scope.workspaceId)));
  if (!row) throw new NotFoundError("Environment");
  return {
    workspaceId: scope.workspaceId,
    environmentId: scope.environmentId,
    workspaceName: row.workspaceName,
    allowedRedirectUrls: row.environment.allowedRedirectUrls ?? [],
    defaultRedirectUrl: row.environment.defaultRedirectUrl,
    connectConfirmation: row.environment.connectConfirmation === "off" ? "off" : "required",
  };
}

function needsOwnApp(entry: IntegrationEntry): boolean {
  if (entry.verificationStatus === "verified" && entry.exercised) return false;
  return !(env.CONNECTIONS_ALLOW_UNVERIFIED && entry.verificationStatus !== "paused");
}

function linkIntegration(integration: string): IntegrationEntry {
  const known = findIntegration(integration);
  if (known?.auth.kind === "oauth" && needsOwnApp(known)) return known;
  return connectableIntegration(integration, env.CONNECTIONS_ALLOW_UNVERIFIED);
}

export function sharedAppOffered(entry: IntegrationEntry): boolean {
  return entry.auth.kind === "oauth" && !needsOwnApp(entry);
}

function linkRedirect(requested: string | null | undefined, settings: ConnectSettings): string | null {
  const redirectUrl = resolveRedirect(requested, settings);
  if (!redirectUrl && settings.connectConfirmation === "required") throw new RedirectUrlRequiredError();
  return redirectUrl;
}

function keyLinkUrl(token: string): string {
  return `${consentUrl("key")}?token=${encodeURIComponent(token)}`;
}

async function countPerMinute(key: string, limit: number, message: string): Promise<void> {
  const window = Math.floor(Date.now() / 60_000);
  const windowKey = `${key}:${window}`;
  const count = await redis.incr(windowKey);
  if (count === 1) await redis.expire(windowKey, 60);
  if (count > limit) throw new RateLimitError(message);
}

async function limitLinkRate(scope: Scope, endUserId: string): Promise<void> {
  await countPerMinute(`ratelimit:end-user-links:env:${scope.environmentId}`, LINKS_PER_MINUTE_PER_ENVIRONMENT,
    `At most ${LINKS_PER_MINUTE_PER_ENVIRONMENT} connect links may be created per minute in an environment. Retry shortly.`);
  await countPerMinute(`ratelimit:end-user-links:user:${scope.environmentId}:${sha256(endUserId).slice(0, 32)}`, LINKS_PER_MINUTE_PER_END_USER,
    `At most ${LINKS_PER_MINUTE_PER_END_USER} connect links may be created per minute for one end user. Retry shortly.`);
}

async function signsInHere(scope: Scope, entry: IntegrationEntry): Promise<boolean> {
  if (entry.auth.kind !== "oauth") return false;
  const provider = connectionProvider();
  if (!provider) return false;
  if (await environmentOAuthClient(scope.environmentId, entry.id)) return provider.supportsIn(entry.id, scope.environmentId);
  return !needsOwnApp(entry) && provider.supports(entry.id);
}

async function mintLink(scope: Scope, entry: IntegrationEntry, endUserId: string, redirectUrl: string | null, settings: ConnectSettings): Promise<ConnectLinkView> {
  if (entry.auth.kind === "api_key") return mintKeyLink(scope, entry.id, endUserId, redirectUrl, settings);
  if (keyAuthOf(entry) && !(await signsInHere(scope, entry))) return mintKeyLink(scope, entry.id, endUserId, redirectUrl, settings);
  const ownApp = await environmentOAuthClient(scope.environmentId, entry.id);
  if (needsOwnApp(entry) && !ownApp) {
    throw new OwnOAuthAppRequiredError(entry.id, entry.displayName);
  }
  const provider = requireConnectionProvider();
  if (!ownApp && !provider.supports(entry.id)) {
    throw new OwnOAuthAppRequiredError(entry.id, entry.displayName);
  }
  if (!(await provider.supportsIn(entry.id, scope.environmentId))) {
    throw new ConnectionsUnavailableError(`Signing in to ${entry.displayName} is not set up on this deployment. Set this environment's own OAuth app for it.`);
  }
  return mintSignInLink(scope, entry.id, endUserId, redirectUrl, settings);
}

async function mintSignInLink(scope: Scope, integrationKey: string, endUserId: string, redirectUrl: string | null, settings: ConnectSettings): Promise<ConnectLinkView> {
  const provider = requireConnectionProvider();
  await limitLinkRate(scope, endUserId);
  const tag = endUserIdFor(scope.workspaceId, scope.environmentId, `eul_${alnum(24)}`);
  const minted = await provider.createConnectSession({
    endUserId: tag,
    integrationKey,
    subject: { endUserId, redirectUrl, confirm: settings.connectConfirmation === "required", flowId: `flw_${alnum(30)}` },
    ttlMs: CONNECT_LINK_TTL_MS,
  });
  logger.info({ workspaceId: scope.workspaceId, environmentId: scope.environmentId, integration: integrationKey }, "End-user connect link created");
  return { url: provider.consentPageUrl(minted.sessionToken), expiresAt: minted.expiresAt };
}

export async function createUpstreamConnectLink(
  scope: Scope, endUserId: string, integrationKey: string, input: { redirectUrl?: string | null },
): Promise<ConnectLinkView> {
  const settings = await connectSettings(scope);
  const redirectUrl = linkRedirect(input.redirectUrl, settings);
  const { liveEndUserUpstream } = await import("../mcp-upstreams/end-user-key.ts");
  if ((await liveEndUserUpstream(scope, integrationKey))?.connect === "key") {
    return mintKeyLink(scope, integrationKey, endUserId, redirectUrl, settings);
  }
  if (!(await requireConnectionProvider().supportsIn(integrationKey, scope.environmentId))) {
    throw new ConnectionsUnavailableError("This upstream's OAuth client cannot be used: check that its client secret exists and may be sent to the token endpoint.");
  }
  return mintSignInLink(scope, integrationKey, endUserId, redirectUrl, settings);
}

async function mintKeyLink(scope: Scope, integration: string, endUserId: string, redirectUrl: string | null, settings: ConnectSettings): Promise<ConnectLinkView> {
  await limitLinkRate(scope, endUserId);
  const token = `kln_${alnum(32)}`;
  const record: KeyLinkRecord = {
    workspaceId: scope.workspaceId,
    environmentId: scope.environmentId,
    endUserId,
    integration,
    redirectUrl,
    confirm: settings.connectConfirmation === "required",
    flowId: `flw_${alnum(30)}`,
  };
  await redis.set(keyLinkKey(token), JSON.stringify(record), "PX", CONNECT_LINK_TTL_MS);
  logger.info({ workspaceId: scope.workspaceId, environmentId: scope.environmentId, integration }, "End-user key link created");
  return { url: keyLinkUrl(token), expiresAt: new Date(Date.now() + CONNECT_LINK_TTL_MS) };
}

export async function createConnectLink(
  scope: Scope,
  endUserId: string,
  input: { integration: string; redirectUrl?: string | null },
  options: { mcpServers?: boolean } = {},
): Promise<ConnectLinkView & { integration: string }> {
  if (options.mcpServers) {
    const { liveEndUserUpstream } = await import("../mcp-upstreams/end-user-key.ts");
    if (await liveEndUserUpstream(scope, input.integration)) {
      const link = await createUpstreamConnectLink(scope, endUserId, input.integration, { redirectUrl: input.redirectUrl ?? null });
      return { ...link, integration: input.integration };
    }
  }
  const entry = linkIntegration(input.integration);
  const settings = await connectSettings(scope);
  const redirectUrl = linkRedirect(input.redirectUrl, settings);
  const link = await mintLink(scope, entry, endUserId, redirectUrl, settings);
  return { ...link, integration: entry.id };
}

export async function connectLinkForRetry(scope: Scope, endUserId: string, integration: string): Promise<ConnectLinkView | null> {
  const entry = findIntegration(integration);
  if (!entry) return null;
  if (entry.auth.kind === "oauth" && !keyAuthOf(entry) && needsOwnApp(entry) && !(await environmentOAuthClient(scope.environmentId, entry.id))) return null;
  const settings = await connectSettings(scope);
  const redirectUrl = resolveRedirect(undefined, settings);
  if (!redirectUrl && settings.connectConfirmation === "required") return null;

  const cacheKey = reusableLinkKey(scope, entry.id, endUserId);
  const reused = await reusableLink(cacheKey);
  if (reused) return reused;
  const link = await mintLink(scope, entry, endUserId, redirectUrl, settings);
  await rememberLink(cacheKey, link);
  return link;
}

export async function upstreamConnectLinkForRetry(scope: Scope, endUserId: string, integrationKey: string): Promise<ConnectLinkView | null> {
  const settings = await connectSettings(scope);
  if (!resolveRedirect(undefined, settings) && settings.connectConfirmation === "required") return null;
  const cacheKey = reusableLinkKey(scope, integrationKey, endUserId);
  const reused = await reusableLink(cacheKey);
  if (reused) return reused;
  const link = await createUpstreamConnectLink(scope, endUserId, integrationKey, { redirectUrl: null });
  await rememberLink(cacheKey, link);
  return link;
}

async function reusableLink(cacheKey: string): Promise<ConnectLinkView | null> {
  const cached = await redis.get(cacheKey);
  if (!cached) return null;
  const link = JSON.parse(cached) as { url: string; expiresAt: string };
  const token = new URL(link.url).searchParams.get("token") ?? "";
  const remaining = new Date(link.expiresAt).getTime() - Date.now();
  if (remaining <= REUSE_MIN_REMAINING_MS) return null;
  const live = token.startsWith("kln_") ? await peekKeyLink(token) : await requireConnectionProvider().peekConsent(token);
  return live ? { url: link.url, expiresAt: new Date(link.expiresAt) } : null;
}

async function rememberLink(cacheKey: string, link: ConnectLinkView): Promise<void> {
  await redis.set(cacheKey, JSON.stringify({ url: link.url, expiresAt: link.expiresAt.toISOString() }), "PX", CONNECT_LINK_TTL_MS);
}

export async function recordEndUserConsent(
  subject: ConsentSubjectResult,
  outcome: { status: "connected"; connectionId: string } | { status: "declined" | "error" },
): Promise<string | null> {
  const params: Record<string, string> = { integration: subject.integrationKey };
  if (outcome.status === "connected" && subject.pendingUntil) {
    const record: FlowRecord = {
      workspaceId: subject.workspaceId,
      environmentId: subject.environmentId,
      endUserId: subject.endUserId,
      integration: subject.integrationKey,
      connectionId: outcome.connectionId,
    };
    await redis.set(flowKey(subject.flowId), JSON.stringify(record), "PX", Math.max(1000, subject.pendingUntil.getTime() - Date.now()));
    params.anlyon_status = "pending_confirmation";
    params.anlyon_flow = subject.flowId;
  } else if (outcome.status === "connected") {
    connected(subject, subject.endUserId, { type: "system", id: null });
    params.anlyon_status = "connected";
  } else {
    params.anlyon_status = outcome.status;
  }
  return subject.redirectUrl ? redirectWithResult(subject.redirectUrl, params) : null;
}

function connected(scope: Scope & { integrationKey: string }, endUserId: string, actor: AuditActor): void {
  emitEvent(scope.workspaceId, "end_user.connected", { environmentId: scope.environmentId, endUserId, integration: scope.integrationKey });
  recordAuditEvent({
    workspaceId: scope.workspaceId,
    environmentId: scope.environmentId,
    endUserId,
    type: "end_user.connected",
    actor,
    resource: { type: "end_user", id: endUserId },
    data: { integration: scope.integrationKey },
  });
}

export async function confirmConnection(
  scope: Scope,
  endUserId: string,
  flowId: string,
  actor: AuditActor,
): Promise<{ integration: string; status: "active" }> {
  const notFound = new ApiError(404, "CONNECT_FLOW_NOT_FOUND", "No connection is waiting for this flow: it was already confirmed, it expired, or it belongs elsewhere.");
  if (!FLOW_ID.test(flowId)) throw notFound;
  const peek = await redis.get(flowKey(flowId));
  const record = peek ? (JSON.parse(peek) as FlowRecord) : null;
  if (!record || record.workspaceId !== scope.workspaceId || record.environmentId !== scope.environmentId) throw notFound;
  if (!(await redis.getdel(flowKey(flowId)))) throw notFound;

  if (record.endUserId !== endUserId) {
    await discardGrant(record.connectionId, record.integration);
    logger.warn({ workspaceId: scope.workspaceId, environmentId: scope.environmentId, integration: record.integration }, "A connect flow was confirmed for another end user; the grant was discarded");
    recordAuditEvent({
      workspaceId: scope.workspaceId,
      environmentId: scope.environmentId,
      endUserId,
      type: "end_user.connection_refused",
      actor,
      resource: { type: "end_user", id: endUserId },
      data: { integration: record.integration, reason: "end_user_mismatch" },
    });
    throw new EndUserMismatchError();
  }

  const activated = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(oauthConnections).where(and(
      eq(oauthConnections.id, record.connectionId),
      eq(oauthConnections.environmentId, scope.environmentId),
      eq(oauthConnections.subjectEndUserId, endUserId),
      isNotNull(oauthConnections.pendingConfirmationUntil),
    )).for("update");
    if (!row || (row.pendingConfirmationUntil && row.pendingConfirmationUntil.getTime() <= Date.now())) return null;
    await tx.delete(oauthConnections).where(and(
      eq(oauthConnections.environmentId, scope.environmentId),
      eq(oauthConnections.integrationKey, row.integrationKey),
      eq(oauthConnections.subjectEndUserId, endUserId),
      isNull(oauthConnections.pendingConfirmationUntil),
      ne(oauthConnections.id, row.id),
    ));
    await tx.update(oauthConnections).set({ pendingConfirmationUntil: null, updatedAt: new Date() }).where(eq(oauthConnections.id, row.id));
    return row;
  });
  if (!activated) {
    await discardGrant(record.connectionId, record.integration);
    throw notFound;
  }
  connected({ ...scope, integrationKey: record.integration }, endUserId, actor);
  return { integration: record.integration, status: "active" };
}

export async function peekKeyLink(token: string): Promise<(KeyLinkRecord & { workspaceName: string }) | null> {
  if (!KEY_LINK_TOKEN.test(token)) return null;
  const raw = await redis.get(keyLinkKey(token));
  if (!raw) return null;
  const record = JSON.parse(raw) as KeyLinkRecord;
  const settings = await connectSettings(record).catch(() => null);
  return settings ? { ...record, workspaceName: settings.workspaceName } : null;
}

export type KeyLinkResult =
  | { status: "connected"; redirectTo: string | null }
  | { status: "expired" }
  | { status: "refused"; message: string; attemptsLeft: number };

export async function submitKeyLink(token: string, given: CredentialInput): Promise<KeyLinkResult> {
  const record = await peekKeyLink(token);
  if (!record) return { status: "expired" };
  const scope = { workspaceId: record.workspaceId, environmentId: record.environmentId };
  const tries = await redis.incr(keyLinkTriesKey(token));
  if (tries === 1) await redis.pexpire(keyLinkTriesKey(token), CONNECT_LINK_TTL_MS);
  if (tries > KEY_LINK_ATTEMPTS) {
    await redis.del(keyLinkKey(token));
    return { status: "expired" };
  }

  const pendingUntil = record.confirm ? new Date(Date.now() + CONNECT_LINK_TTL_MS) : null;
  let stored: { connectionId: string };
  try {
    const { storeEndUserKey } = await import("./connections.ts");
    stored = await storeEndUserKey(scope, record.endUserId, record.integration, given, { type: "system", id: null }, pendingUntil);
  } catch (error) {
    if (error instanceof ApiError && (error.statusCode < 500 || error.code === "CONNECTION_KEY_CHECK_FAILED")) {
      return { status: "refused", message: error.message, attemptsLeft: KEY_LINK_ATTEMPTS - tries };
    }
    throw error;
  }
  if (!(await redis.getdel(keyLinkKey(token)))) {
    await discardGrant(stored.connectionId, record.integration);
    return { status: "expired" };
  }
  await redis.del(keyLinkTriesKey(token));
  const redirectTo = await recordEndUserConsent(
    { endUserId: record.endUserId, redirectUrl: record.redirectUrl, confirm: record.confirm, flowId: record.flowId, ...scope, integrationKey: record.integration, pendingUntil },
    { status: "connected", connectionId: stored.connectionId },
  );
  return { status: "connected", redirectTo };
}

async function discardGrant(connectionId: string, integration: string): Promise<void> {
  const upstreamKey = await db.delete(oauthConnections)
    .where(and(eq(oauthConnections.id, connectionId), sql`${oauthConnections.connectionConfig} ->> 'upstreamKey' = 'true'`))
    .returning({ id: oauthConnections.id });
  if (upstreamKey.length > 0) return;
  if (findIntegration(integration)?.auth.kind === "api_key") {
    await db.delete(oauthConnections).where(eq(oauthConnections.id, connectionId));
    return;
  }
  try {
    await requireConnectionProvider().deleteConnection({ integrationKey: integration, connectionId });
  } catch (error) {
    logger.error({ connectionId, error: error instanceof Error ? error.message : String(error) }, "Discarding an end user's grant failed at the provider; deleting it");
    await db.delete(oauthConnections).where(eq(oauthConnections.id, connectionId));
  }
}

export async function sweepUnconfirmedGrants(batchSize = 100): Promise<number> {
  const due = await db.select({ id: oauthConnections.id, integrationKey: oauthConnections.integrationKey })
    .from(oauthConnections)
    .where(and(isNotNull(oauthConnections.pendingConfirmationUntil), lt(oauthConnections.pendingConfirmationUntil, sql`now()`)))
    .limit(batchSize);
  for (const row of due) await discardGrant(row.id, row.integrationKey);
  if (due.length > 0) logger.info({ deleted: due.length }, "Deleted end-user grants nobody confirmed");
  return due.length;
}
