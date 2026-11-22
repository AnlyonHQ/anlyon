import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { oauthConnections, type OAuthConnectionRow } from "../../db/schema/oauth-connections.ts";
import { readBodyLimited } from "../../lib/read-body.ts";
import { redis } from "../../lib/redis.ts";
import { createLogger } from "../../lib/logger.ts";
import { safeFetch } from "../../lib/safe-http.ts";
import { decryptSecret, encryptSecret } from "../../utils/crypto.ts";
import { findIntegration, keyAuthOf, rowHoldsKey, SIGNED_IN_MARK } from "./catalogue.ts";
import { OAUTH_APPS, oauthClientFromEnv, type OAuthAppSpec, type OAuthClient } from "./oauth-apps.ts";
import {
  ConnectionProviderFailure,
  ConnectionRevokedError,
  parseEndUserId,
  type ConnectionProvider,
  type ConnectionRef,
  type ConsentResult,
  type ConsentSubject,
  type ConsentSubjectResult,
} from "./types.ts";

const logger = createLogger({ module: "connections-native" });

export const CONSENT_TTL_MS = 15 * 60_000;
export const PROVIDER_TIMEOUT_MS = 10_000;
export const REFRESH_SKEW_MS = 60_000;
export const REFRESH_LEASE_MS = 3 * PROVIDER_TIMEOUT_MS;
const REFRESH_POLL_MS = 200;
const REFRESH_WAIT_ATTEMPTS = Math.ceil(REFRESH_LEASE_MS / REFRESH_POLL_MS) + 1;

export const CONSENT_START_PATH = "/api/v2/connection-consent/start";
export const CONSENT_CALLBACK_PATH = "/api/v2/connection-consent/callback";
export const CLIENT_METADATA_PATH = "/api/v2/connection-consent/mcp-client.json";
export const CONSENT_LINK_PATH = "/api/v2/connection-consent/link";
export const CONFIRMATION_TTL_MS = 10 * 60_000;

const SLACK_DEAD_GRANT = new Set(["invalid_refresh_token", "invalid_grant", "invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);

export type OAuthFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: "error" },
) => Promise<Response>;

export interface NativeProviderOptions {
  origin: string;
  pagesOrigin?: string | null;
  encryptionKey: string;
  fetch?: OAuthFetch;
  clientFor?: (spec: OAuthAppSpec) => OAuthClient | null;
  environmentClient?: (environmentId: string, integrationKey: string) => Promise<OAuthClient | null>;
  upstreamApp?: (integrationKey: string, environmentId: string) => Promise<{ spec: OAuthAppSpec; scopes: string[]; client: OAuthClient; namesDeveloper?: boolean } | null>;
  now?: () => Date;
}

export const isUpstreamKey = (integrationKey: string) => integrationKey.startsWith("mcp-");

interface ConsentRecord {
  endUserId: string;
  integrationKey: string;
  reconnects: string | null;
  subject?: ConsentSubject;
}

interface StateRecord {
  tokenHash: string;
  codeVerifier: string | null;
  clientId?: string;
  redirectUri?: string;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number | null;
  scopes: string | null;
  config: Record<string, unknown>;
}

interface App {
  spec: OAuthAppSpec;
  client: OAuthClient;
  scopes: string[];
  own: boolean;
  namesDeveloper?: boolean;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const consentKey = (tokenHash: string) => `connections:consent:${tokenHash}`;
const stateKey = (state: string) => `connections:oauth-state:${state}`;
const openStateKey = (tokenHash: string) => `connections:consent-open:${tokenHash}`;
const random = (bytes: number) => randomBytes(bytes).toString("base64url");
const CONSENT_TOKEN = /^cst_[A-Za-z0-9_-]{32,64}$/;

function readPath(source: unknown, path: string): unknown {
  let current = source;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

export async function readJson(response: Response): Promise<unknown> {
  try {
    const { text, truncated } = await readBodyLimited(response, MAX_PROVIDER_RESPONSE_BYTES);
    if (truncated) return null;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function issuerMatches(spec: OAuthAppSpec, iss: string | null | undefined): boolean {
  if (!iss) return !spec.requireIssuerInResponse;
  const norm = (value: string) => value.replace(/\/+$/, "");
  return norm(iss) === norm(spec.issuer ?? "");
}

function readTokens(spec: OAuthAppSpec, json: unknown): TokenSet | null {
  if (!json || typeof json !== "object") return null;
  const body = json as Record<string, unknown>;
  if (spec.response === "slack" && body.ok !== true) return null;
  if (typeof body.access_token !== "string" || body.access_token.length === 0) return null;
  const expiresIn = Number(body.expires_in);
  const config: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(spec.connectionConfig ?? {})) {
    const value = readPath(body, path);
    if (typeof value === "string" || typeof value === "number") config[name] = value;
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token.length > 0 ? body.refresh_token : null,
    expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
    scopes: typeof body.scope === "string"
      ? body.scope
      : Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string").join(" ") : null,
    config,
  };
}

function deadGrant(spec: OAuthAppSpec, status: number, json: unknown): boolean {
  const body = json as { error?: unknown; code?: unknown } | null;
  const error = body?.error ?? body?.code;
  if (spec.response === "slack") return typeof error === "string" && SLACK_DEAD_GRANT.has(error);
  if (typeof error === "string" && spec.deadGrantErrors?.includes(error)) return true;
  return (status === 400 || status === 401) && error === "invalid_grant";
}

export function createNativeProvider(options: NativeProviderOptions): ConnectionProvider {
  const origin = options.origin.replace(/\/+$/, "");
  const pagesOrigin = options.pagesOrigin ? options.pagesOrigin.replace(/\/+$/, "") : null;
  const pageUrl = (page: "start" | "link" | "callback", longPath: string) => pagesOrigin ? `${pagesOrigin}/${page}` : `${origin}${longPath}`;
  const redirectUri = pageUrl("callback", CONSENT_CALLBACK_PATH);
  const doFetch: OAuthFetch = options.fetch ?? ((url, init) => (safeFetch as unknown as OAuthFetch)(url, init));
  const clientFor = options.clientFor ?? oauthClientFromEnv;
  const environmentClient = options.environmentClient ?? (async () => null);
  const now = options.now ?? (() => new Date());

  function specOf(integrationKey: string): { spec: OAuthAppSpec; scopes: string[] } | null {
    const spec = OAUTH_APPS[integrationKey];
    const entry = findIntegration(integrationKey);
    if (!spec || !entry || entry.auth.kind !== "oauth") return null;
    return { spec, scopes: [...(spec.extraScopes ?? []), ...entry.scopes] };
  }

  async function upstreamAppOf(integrationKey: string, environmentId: string | null): Promise<App | null> {
    if (!environmentId || !options.upstreamApp) return null;
    const found = await options.upstreamApp(integrationKey, environmentId);
    return found ? { ...found, own: true } : null;
  }

  async function appFor(integrationKey: string, environmentId: string | null): Promise<App | null> {
    if (isUpstreamKey(integrationKey)) return upstreamAppOf(integrationKey, environmentId);
    const base = specOf(integrationKey);
    if (!base) return null;
    const own = environmentId ? await environmentClient(environmentId, integrationKey) : null;
    const client = own ?? clientFor(base.spec);
    return client ? { ...base, client, own: own !== null } : null;
  }

  async function requireAppFor(integrationKey: string, environmentId: string | null): Promise<App> {
    const found = await appFor(integrationKey, environmentId);
    if (!found) throw new ConnectionProviderFailure(`No OAuth app is configured for ${integrationKey}`);
    return found;
  }

  async function appOfRow(row: OAuthConnectionRow): Promise<App> {
    if (isUpstreamKey(row.integrationKey)) {
      const found = await upstreamAppOf(row.integrationKey, row.environmentId);
      if (!found || (row.oauthClientId && found.client.clientId !== row.oauthClientId)) throw new ConnectionRevokedError();
      return found;
    }
    const base = specOf(row.integrationKey);
    if (!base) throw new ConnectionProviderFailure(`No OAuth app is configured for ${row.integrationKey}`);
    if (row.oauthClientId) {
      const own = await environmentClient(row.environmentId, row.integrationKey);
      if (!own || own.clientId !== row.oauthClientId) throw new ConnectionRevokedError();
      return { ...base, client: own, own: true };
    }
    const client = clientFor(base.spec);
    if (!client) throw new ConnectionProviderFailure(`No OAuth app is configured for ${row.integrationKey}`);
    return { ...base, client, own: false };
  }

  function scopesFor(found: App, subject: ConsentSubject | undefined): string[] {
    if (subject && !found.own && found.spec.sharedAppEndUserScopes) {
      return [...(found.spec.extraScopes ?? []), ...found.spec.sharedAppEndUserScopes];
    }
    return found.scopes;
  }

  type Owner = Pick<OAuthConnectionRow, "id" | "workspaceId">;
  const seal = (value: string, row: Owner, which: "access" | "refresh") =>
    encryptSecret(value, options.encryptionKey, { store: "oauth-connection", workspaceId: row.workspaceId, name: `${row.id}:${which}` });
  const unseal = (cipher: string, row: Owner, which: "access" | "refresh") =>
    decryptSecret(cipher, options.encryptionKey, { store: "oauth-connection", workspaceId: row.workspaceId, name: `${row.id}:${which}` });

  async function post(
    found: App,
    url: string,
    params: Record<string, string>,
    auth: "client" | "basic" | { bearer: string } | "none",
    options: { json?: boolean; method?: "POST" | "DELETE"; headers?: Readonly<Record<string, string>> } = {},
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
      "Content-Type": options.json ? "application/json" : "application/x-www-form-urlencoded",
    };
    const fields: Record<string, string> = { ...params };
    if (auth === "basic" || (auth === "client" && found.spec.clientAuth === "basic")) {
      const pair = `${encodeURIComponent(found.client.clientId)}:${encodeURIComponent(found.client.clientSecret)}`;
      headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    } else if (auth === "client" && found.spec.clientAuth === "none") {
      fields.client_id = found.client.clientId;
    } else if (auth === "client") {
      fields.client_id = found.client.clientId;
      fields.client_secret = found.client.clientSecret;
    } else if (auth !== "none") {
      headers.Authorization = `Bearer ${auth.bearer}`;
    }
    let response: Response;
    try {
      response = await doFetch(url, {
        method: options.method ?? "POST",
        headers,
        body: options.json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        redirect: "error",
      });
    } catch (error) {
      throw new ConnectionProviderFailure(`OAuth request to ${new URL(url).host} failed: ${error instanceof Error ? error.name : "unknown error"}`);
    }
    return { status: response.status, json: await readJson(response) };
  }

  const tokenRequest = (found: App, params: Record<string, string>) =>
    post(found, found.spec.tokenUrl, { ...params, ...found.spec.tokenParams }, "client", { json: found.spec.tokenBody === "json", headers: found.spec.tokenHeaders });

  function expiryOf(spec: OAuthAppSpec, tokens: TokenSet, refreshable: boolean): Date | null {
    const seconds = tokens.expiresInSeconds ?? (refreshable ? spec.assumedLifetimeSeconds ?? null : null);
    return seconds ? new Date(now().getTime() + seconds * 1000) : null;
  }

  const expiringSoon = (row: OAuthConnectionRow) =>
    row.expiresAt !== null && row.expiresAt.getTime() - now().getTime() < REFRESH_SKEW_MS;

  const matchRef = (ref: ConnectionRef) =>
    and(eq(oauthConnections.id, ref.connectionId), eq(oauthConnections.integrationKey, ref.integrationKey));

  async function loadRow(ref: ConnectionRef): Promise<OAuthConnectionRow | null> {
    const [row] = await db.select().from(oauthConnections).where(matchRef(ref));
    return row ?? null;
  }

  async function markRevoked(id: string): Promise<void> {
    await db.update(oauthConnections).set({ revokedAt: now(), updatedAt: now() }).where(eq(oauthConnections.id, id));
  }

  async function mint(record: ConsentRecord, ttlMs = CONSENT_TTL_MS): Promise<{ sessionToken: string; expiresAt: Date }> {
    const sessionToken = `cst_${random(32)}`;
    await redis.set(consentKey(sha256(sessionToken)), JSON.stringify(record), "PX", ttlMs);
    return { sessionToken, expiresAt: new Date(now().getTime() + ttlMs) };
  }

  async function loadConsent(tokenHash: string): Promise<ConsentRecord | null> {
    const raw = await redis.get(consentKey(tokenHash));
    return raw ? (JSON.parse(raw) as ConsentRecord) : null;
  }

  async function probe(found: App, accessToken: string): Promise<"works" | "dead"> {
    const check = found.spec.check!;
    let status: number;
    let json: unknown;
    try {
      const response = await doFetch(check.url, {
        method: check.method,
        headers: { Accept: "application/json", ...found.spec.apiHeaders, Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        redirect: "error",
      });
      status = response.status;
      json = await readJson(response);
    } catch (error) {
      throw new ConnectionProviderFailure(`Token check failed: ${error instanceof Error ? error.name : "unknown error"}`);
    }
    if (status === 401 || status === 403) return "dead";
    if (status >= 200 && status < 300) {
      if (!check.okField || (json as Record<string, unknown> | null)?.[check.okField] === true) return "works";
      const error = (json as { error?: unknown } | null)?.error;
      if (typeof error === "string" && SLACK_DEAD_GRANT.has(error)) return "dead";
    }
    throw new ConnectionProviderFailure(`Token check answered ${status}`, status);
  }

  async function releaseLease(id: string, leaseUntil: Date, set: Partial<typeof oauthConnections.$inferInsert> = {}): Promise<boolean> {
    const released = await db.update(oauthConnections)
      .set({ ...set, refreshLeaseUntil: null })
      .where(and(eq(oauthConnections.id, id), eq(oauthConnections.refreshLeaseUntil, leaseUntil)))
      .returning({ id: oauthConnections.id });
    return released.length > 0;
  }

  function unchangedSince(row: OAuthConnectionRow) {
    return and(
      eq(oauthConnections.refreshTokenEncrypted, row.refreshTokenEncrypted as string),
      row.lastRefreshedAt ? eq(oauthConnections.lastRefreshedAt, row.lastRefreshedAt) : isNull(oauthConnections.lastRefreshedAt),
    );
  }

  async function storedByAnother(ref: ConnectionRef, row: OAuthConnectionRow): Promise<string | null> {
    const latest = await loadRow(ref);
    if (!latest || latest.revokedAt) throw new ConnectionRevokedError();
    const refreshedSince = latest.refreshTokenEncrypted !== row.refreshTokenEncrypted ||
      (latest.lastRefreshedAt?.getTime() ?? null) !== (row.lastRefreshedAt?.getTime() ?? null);
    return refreshedSince ? unseal(latest.accessTokenEncrypted, latest, "access") : null;
  }

  async function refresh(ref: ConnectionRef, force: boolean): Promise<string> {
    const first = await loadRow(ref);
    if (!first || first.revokedAt || !first.refreshTokenEncrypted) throw new ConnectionRevokedError();
    const found = await appOfRow(first);
    const requestedAt = now();
    const fresh = (row: OAuthConnectionRow) => force
      ? row.lastRefreshedAt !== null && row.lastRefreshedAt.getTime() >= requestedAt.getTime()
      : !expiringSoon(row);

    for (let attempt = 0; ; attempt++) {
      const row = await loadRow(ref);
      if (!row || row.revokedAt || !row.refreshTokenEncrypted) throw new ConnectionRevokedError();
      if (fresh(row)) return unseal(row.accessTokenEncrypted, row, "access");

      const leaseUntil = new Date(now().getTime() + REFRESH_LEASE_MS);
      const [claimed] = await db.update(oauthConnections)
        .set({ refreshLeaseUntil: leaseUntil })
        .where(and(
          matchRef(ref),
          isNull(oauthConnections.revokedAt),
          or(isNull(oauthConnections.refreshLeaseUntil), lt(oauthConnections.refreshLeaseUntil, now())),
        ))
        .returning();
      if (claimed) return refreshClaimed(found, ref, claimed, leaseUntil, fresh, row.refreshLeaseUntil !== null);

      if (attempt >= REFRESH_WAIT_ATTEMPTS) throw new ConnectionProviderFailure("Another refresh of this grant did not finish");
      await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
    }
  }

  async function refreshClaimed(
    found: App,
    ref: ConnectionRef,
    row: OAuthConnectionRow,
    leaseUntil: Date,
    fresh: (row: OAuthConnectionRow) => boolean,
    tookOver: boolean,
  ): Promise<string> {
    if (fresh(row) || !row.refreshTokenEncrypted) {
      await releaseLease(row.id, leaseUntil);
      if (!row.refreshTokenEncrypted) throw new ConnectionRevokedError();
      return unseal(row.accessTokenEncrypted, row, "access");
    }
    let answer: { status: number; json: unknown };
    try {
      answer = await tokenRequest(found, {
        grant_type: "refresh_token",
        refresh_token: unseal(row.refreshTokenEncrypted, row, "refresh"),
      });
    } catch (error) {
      await releaseLease(row.id, leaseUntil);
      throw error;
    }
    const { status, json } = answer;
    const tokens = readTokens(found.spec, json);
    if (!tokens) {
      if (deadGrant(found.spec, status, json)) {
        const [dead] = tookOver ? [] : await db.update(oauthConnections)
          .set({ revokedAt: now(), updatedAt: now(), refreshLeaseUntil: null })
          .where(and(eq(oauthConnections.id, row.id), eq(oauthConnections.refreshLeaseUntil, leaseUntil), unchangedSince(row)))
          .returning({ id: oauthConnections.id });
        if (dead) {
          logger.warn({ integrationKey: ref.integrationKey, connectionId: ref.connectionId, status }, "Provider refused a token refresh; the grant is dead");
          throw new ConnectionRevokedError();
        }
        await releaseLease(row.id, leaseUntil);
        const theirs = await storedByAnother(ref, row);
        if (theirs) return theirs;
        throw new ConnectionProviderFailure(`Token refresh answered ${status} while another refresh may have been running`, status);
      }
      await releaseLease(row.id, leaseUntil);
      throw new ConnectionProviderFailure(`Token refresh answered ${status}`, status);
    }
    const [written] = await db.update(oauthConnections)
      .set({
        accessTokenEncrypted: seal(tokens.accessToken, row, "access"),
        ...(tokens.refreshToken ? { refreshTokenEncrypted: seal(tokens.refreshToken, row, "refresh") } : {}),
        expiresAt: expiryOf(found.spec, tokens, true),
        ...(tokens.scopes ? { scopes: tokens.scopes } : {}),
        lastRefreshedAt: now(),
        updatedAt: now(),
        refreshLeaseUntil: sql`CASE WHEN ${oauthConnections.refreshLeaseUntil} = ${leaseUntil.toISOString()}::timestamptz THEN NULL ELSE ${oauthConnections.refreshLeaseUntil} END`,
      })
      .where(and(
        eq(oauthConnections.id, row.id),
        or(eq(oauthConnections.refreshLeaseUntil, leaseUntil), unchangedSince(row)),
      ))
      .returning({ id: oauthConnections.id });
    if (written) return tokens.accessToken;

    logger.warn({ integrationKey: ref.integrationKey, connectionId: ref.connectionId }, "Another refresh stored tokens first; this refresh's tokens were discarded");
    await releaseLease(row.id, leaseUntil);
    return (await storedByAnother(ref, row)) ?? tokens.accessToken;
  }

  async function revokeAtProvider(found: App, row: OAuthConnectionRow): Promise<void> {
    const revoke = found.spec.revoke!;
    const token = revoke.token === "refresh" && row.refreshTokenEncrypted
      ? unseal(row.refreshTokenEncrypted, row, "refresh")
      : unseal(row.accessTokenEncrypted, row, "access");
    const hint = revoke.token === "refresh" && row.refreshTokenEncrypted ? "refresh_token" : "access_token";
    const { status } = revoke.style === "bearer"
      ? await post(found, revoke.url, {}, { bearer: token })
      : revoke.style === "form_with_client"
        ? await post(found, revoke.url, { token, token_type_hint: hint }, "client")
        : revoke.style === "json_basic"
          ? await post(found, revoke.url.replace("{client_id}", encodeURIComponent(found.client.clientId)), { [revoke.field ?? "token"]: token }, "basic", {
              json: true, method: revoke.method, headers: found.spec.apiHeaders,
            })
          : await post(found, revoke.url, { token }, "none");
    if (status < 200 || status >= 300) {
      logger.warn({ integrationKey: row.integrationKey, connectionId: row.id, status }, "Provider did not confirm the revocation");
    }
  }

  return {
    id: "anlyon",

    supports(integrationKey) {
      const base = specOf(integrationKey);
      return base !== null && clientFor(base.spec) !== null;
    },

    async supportsIn(integrationKey, environmentId) {
      return (await appFor(integrationKey, environmentId)) !== null;
    },

    async createConnectSession({ endUserId, integrationKey, subject, ttlMs }) {
      await requireAppFor(integrationKey, parseEndUserId(endUserId)?.environmentId ?? null);
      return mint({ endUserId, integrationKey, reconnects: null, ...(subject ? { subject } : {}) }, ttlMs);
    },

    async createReconnectSession({ endUserId, integrationKey, connectionId }) {
      await requireAppFor(integrationKey, parseEndUserId(endUserId)?.environmentId ?? null);
      const [row] = await db.select({ integrationKey: oauthConnections.integrationKey }).from(oauthConnections).where(eq(oauthConnections.id, connectionId));
      if (row && row.integrationKey !== integrationKey) throw new ConnectionProviderFailure("Reconnect named a connection of another integration");
      return mint({ endUserId, integrationKey, reconnects: connectionId });
    },

    redirectUri() {
      return redirectUri;
    },

    clientMetadataUrl() {
      return `${origin}${CLIENT_METADATA_PATH}`;
    },

    connectUrl(sessionToken) {
      return `${pageUrl("start", CONSENT_START_PATH)}?token=${encodeURIComponent(sessionToken)}`;
    },

    consentPageUrl(sessionToken) {
      return `${pageUrl("link", CONSENT_LINK_PATH)}?token=${encodeURIComponent(sessionToken)}`;
    },

    async peekConsent(sessionToken) {
      if (!CONSENT_TOKEN.test(sessionToken)) return null;
      const tokenHash = sha256(sessionToken);
      const record = await loadConsent(tokenHash);
      const scope = record ? parseEndUserId(record.endUserId) : null;
      if (!record || !scope) return null;
      const ttl = await redis.pttl(consentKey(tokenHash));
      if (ttl <= 0) return null;
      const found = await appFor(record.integrationKey, scope.environmentId).catch(() => null);
      return {
        integrationKey: record.integrationKey,
        workspaceId: scope.workspaceId,
        environmentId: scope.environmentId,
        subject: record.subject ?? null,
        ownApp: found ? found.namesDeveloper ?? found.own : false,
        expiresAt: new Date(now().getTime() + ttl),
      };
    },

    async beginConsent(sessionToken) {
      if (!CONSENT_TOKEN.test(sessionToken)) return null;
      const tokenHash = sha256(sessionToken);
      const record = await loadConsent(tokenHash);
      if (!record) return null;
      const ttl = await redis.pttl(consentKey(tokenHash));
      if (ttl <= 0) return null;
      const found = await requireAppFor(record.integrationKey, parseEndUserId(record.endUserId)?.environmentId ?? null);
      const scopes = scopesFor(found, record.subject);

      let state: string | null = await redis.get(openStateKey(tokenHash));
      let codeVerifier: string | null = null;
      const live = state ? await redis.get(stateKey(state)) : null;
      const reused = live ? (JSON.parse(live) as StateRecord) : null;
      if (state && reused && reused.tokenHash === tokenHash && reused.clientId === found.client.clientId && (reused.redirectUri ?? redirectUri) === redirectUri) {
        codeVerifier = reused.codeVerifier;
      } else {
        state = random(32);
        codeVerifier = found.spec.pkce ? random(48) : null;
        await redis.set(stateKey(state), JSON.stringify({ tokenHash, codeVerifier, clientId: found.client.clientId, redirectUri } satisfies StateRecord), "PX", ttl);
        await redis.set(openStateKey(tokenHash), state, "PX", ttl);
      }

      const url = new URL(found.spec.authorizeUrl);
      url.searchParams.set("client_id", found.client.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      if (scopes.length > 0) url.searchParams.set("scope", scopes.join(found.spec.scopeSeparator));
      url.searchParams.set("state", state);
      if (codeVerifier) {
        url.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
        url.searchParams.set("code_challenge_method", "S256");
      }
      for (const [key, value] of Object.entries(found.spec.authorizeParams ?? {})) url.searchParams.set(key, value);
      return url.toString();
    },

    async finishConsent({ state, code, error, iss }): Promise<ConsentResult> {
      const expired = { ok: false, reason: "expired", endUserId: null } as const;
      if (!state || state.length > 128) return expired;
      const rawState = await redis.getdel(stateKey(state));
      if (!rawState) return expired;
      const { tokenHash, codeVerifier, clientId, redirectUri: sentRedirectUri } = JSON.parse(rawState) as StateRecord;
      const record = await loadConsent(tokenHash);
      if (!record) return expired;
      const { endUserId, integrationKey } = record;
      const scope = parseEndUserId(endUserId);
      const subjectOf = (pendingUntil: Date | null): ConsentSubjectResult | undefined => record.subject && scope
        ? { ...record.subject, workspaceId: scope.workspaceId, environmentId: scope.environmentId, integrationKey, pendingUntil }
        : undefined;
      const failed = (reason: "declined" | "provider_error") => {
        const subject = subjectOf(null);
        return { ok: false as const, reason, endUserId, ...(subject ? { subject } : {}) };
      };

      if (error || !code) {
        logger.info({ integrationKey, error: typeof error === "string" ? error.slice(0, 64) : null }, "Consent ended without a grant");
        if (record.subject) await redis.del(consentKey(tokenHash));
        return failed(error === "access_denied" ? "declined" : "provider_error");
      }
      const found = scope ? await appFor(integrationKey, scope.environmentId) : null;
      if (!scope || !found || (clientId && found.client.clientId !== clientId)) {
        if (record.subject) await redis.del(consentKey(tokenHash));
        return failed("provider_error");
      }

      if (found.spec.issuer && !issuerMatches(found.spec, iss)) {
        logger.warn({ integrationKey, sent: Boolean(iss) }, "Consent refused: the redirect did not come from this upstream's authorization server");
        if (record.subject) await redis.del(consentKey(tokenHash));
        return failed("provider_error");
      }

      if (!(await redis.getdel(consentKey(tokenHash)))) return expired;

      let tokens: TokenSet | null = null;
      try {
        const { status, json } = await tokenRequest(found, {
          grant_type: "authorization_code",
          code,
          redirect_uri: sentRedirectUri ?? redirectUri,
          ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        });
        tokens = readTokens(found.spec, json);
        if (!tokens) logger.warn({ integrationKey, status }, "Provider refused the code exchange");
      } catch (failure) {
        logger.warn({ integrationKey, error: failure instanceof Error ? failure.message : String(failure) }, "Code exchange failed");
      }
      if (!tokens) return failed("provider_error");

      const id = record.reconnects ?? `oc_${random(18)}`;
      const owner = { id, workspaceId: scope.workspaceId };
      const refreshable = tokens.refreshToken !== null;
      const fields = {
        endUserId,
        accessTokenEncrypted: seal(tokens.accessToken, owner, "access"),
        ...(tokens.refreshToken ? { refreshTokenEncrypted: seal(tokens.refreshToken, owner, "refresh") } : {}),
        expiresAt: expiryOf(found.spec, tokens, refreshable),
        scopes: tokens.scopes,
        connectionConfig: (() => {
          const entry = findIntegration(integrationKey);
          return entry && keyAuthOf(entry) ? { ...tokens.config, [SIGNED_IN_MARK]: true } : tokens.config;
        })(),
        oauthClientId: found.own ? found.client.clientId : null,
        revokedAt: null,
        updatedAt: now(),
      };

      if (record.subject) {
        const pendingUntil = record.subject.confirm ? new Date(now().getTime() + CONFIRMATION_TTL_MS) : null;
        const row = {
          id,
          workspaceId: scope.workspaceId,
          environmentId: scope.environmentId,
          integrationKey,
          refreshTokenEncrypted: null,
          ...fields,
          subjectEndUserId: record.subject.endUserId,
          pendingConfirmationUntil: pendingUntil,
        };
        if (pendingUntil) {
          await db.insert(oauthConnections).values(row);
        } else {
          await db.transaction(async (tx) => {
            await tx.delete(oauthConnections).where(and(
              eq(oauthConnections.environmentId, scope.environmentId),
              eq(oauthConnections.integrationKey, integrationKey),
              eq(oauthConnections.subjectEndUserId, record.subject!.endUserId),
              isNull(oauthConnections.pendingConfirmationUntil),
            ));
            await tx.insert(oauthConnections).values(row);
          });
        }
        return { ok: true, outcome: { operation: "creation", integrationKey, connectionId: id, endUserId, subject: subjectOf(pendingUntil) } };
      }

      if (record.reconnects) {
        const updated = await db.update(oauthConnections).set(fields).where(and(
          matchRef({ integrationKey, connectionId: id }),
          eq(oauthConnections.workspaceId, scope.workspaceId),
          eq(oauthConnections.environmentId, scope.environmentId),
        )).returning({ id: oauthConnections.id });
        if (updated.length > 0) return { ok: true, outcome: { operation: "override", integrationKey, connectionId: id, endUserId } };
      }
      const inserted = await db.insert(oauthConnections).values({
        id,
        workspaceId: scope.workspaceId,
        environmentId: scope.environmentId,
        integrationKey,
        refreshTokenEncrypted: null,
        ...fields,
      }).onConflictDoNothing().returning({ id: oauthConnections.id });
      if (inserted.length === 0) {
        logger.warn({ integrationKey, connectionId: id }, "Reconnect named a connection held by another scope");
        return failed("provider_error");
      }
      return { ok: true, outcome: { operation: record.reconnects ? "override" : "creation", integrationKey, connectionId: id, endUserId } };
    },

    async getConnection(ref) {
      const row = await loadRow(ref);
      if (!row || row.revokedAt) throw new ConnectionRevokedError();
      return {
        integrationKey: row.integrationKey,
        connectionId: row.id,
        tags: { end_user_id: row.endUserId },
        connectionConfig: row.connectionConfig ?? {},
      };
    },

    async getAccessToken(ref, options = {}) {
      const row = await loadRow(ref);
      if (!row || row.revokedAt) throw new ConnectionRevokedError();
      if (row.pendingConfirmationUntil) throw new ConnectionProviderFailure("This grant has not been confirmed");
      if (!row.refreshTokenEncrypted) {
        if (row.expiresAt && row.expiresAt.getTime() <= now().getTime()) {
          await markRevoked(row.id);
          throw new ConnectionRevokedError();
        }
        const token = unseal(row.accessTokenEncrypted, row, "access");
        if (options.forceRefresh) {
          const found = await appOfRow(row);
          if (found.spec.check && (await probe(found, token)) === "dead") {
            await markRevoked(row.id);
            throw new ConnectionRevokedError();
          }
        }
        return token;
      }
      if (!options.forceRefresh && !expiringSoon(row)) return unseal(row.accessTokenEncrypted, row, "access");
      return refresh(ref, Boolean(options.forceRefresh));
    },

    async deleteConnection(ref) {
      const row = await loadRow(ref);
      if (!row) return;
      const found = rowHoldsKey(row) ? null : await appOfRow(row).catch(() => null);
      if (found?.spec.revoke && !row.revokedAt) {
        try {
          await revokeAtProvider(found, row);
        } catch (error) {
          logger.warn({ integrationKey: ref.integrationKey, connectionId: ref.connectionId, error: error instanceof Error ? error.message : String(error) }, "Revoking at the provider failed; the token is deleted anyway");
        }
      }
      await db.delete(oauthConnections).where(eq(oauthConnections.id, row.id));
    },
  };
}
