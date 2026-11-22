import { createHash, randomBytes } from "node:crypto";
import { env } from "../../config/env.ts";
import { redis } from "../../lib/redis.ts";
import { createLogger } from "../../lib/logger.ts";
import {
  ConflictError,
  ConnectionProviderError,
  ConnectionSessionExpiredError,
  RateLimitError,
  ValidationError,
} from "../../utils/errors.ts";
import { secretNameSchema } from "../../utils/validation.ts";
import { checkSecretQuota } from "../billing/usage-enforcement.ts";
import { emitEvent } from "../events/emitter.ts";
import {
  connectionIdOfSecret,
  getSecretMetadata,
  listSecrets,
  markSecretHealthy,
  markSecretNeedsReauth,
  putConnectionSecret,
  putSecret,
  secretsBoundToConnection,
  type SecretView,
} from "../actions/secrets.ts";
import { connectableIntegration, findIntegration, integrationView, keyAuthOf, listedIntegrations, readCredentialInput, resolveHosts, usesFields, CATALOGUE, type IntegrationEntry } from "./catalogue.ts";
import { checkKey, checkSecretHealth, integrationOf } from "./health.ts";
import { environmentOAuthClient } from "../end-users/oauth-apps.ts";
import { OwnOAuthAppRequiredError } from "../end-users/errors.ts";
import {
  connectionProvider,
  endUserIdFor,
  parseEndUserId,
  requireConnectionProvider,
  ConnectionRevokedError,
  ConnectionProviderFailure,
  type ConsentOutcome,
} from "./provider.ts";

export { keyCheck, KEY_CHECK_TIMEOUT_MS } from "./health.ts";
export { endUserIdFor, parseEndUserId };

const logger = createLogger({ module: "connections" });

export const SESSION_TTL_SECONDS = 15 * 60;
export const SESSIONS_PER_MINUTE = 10;

interface PendingSession {
  sessionId: string;
  workspaceId: string;
  environmentId: string;
  integrationId: string;
  secretName: string;
  description: string | null;
  startedBy: { userId: string | null; apiKeyId: string | null };
  tokenHash: string;
  endUserId: string;
  expiresAt: string;
  status: "pending" | "completed";
  connectionId: string | null;
  mode?: "connect" | "reconnect";
  failure?: { message: string };
}

const sessionKey = (sessionId: string) => `connections:session:${sessionId}`;

function allowUnverified(): boolean {
  return env.CONNECTIONS_ALLOW_UNVERIFIED;
}

async function loadSession(sessionId: string): Promise<PendingSession | null> {
  if (!/^csn_[A-Za-z0-9]{8,64}$/.test(sessionId)) return null;
  const raw = await redis.get(sessionKey(sessionId));
  return raw ? (JSON.parse(raw) as PendingSession) : null;
}

async function saveSession(session: PendingSession): Promise<void> {
  const ttl = await redis.pttl(sessionKey(session.sessionId));
  if (ttl > 0) await redis.set(sessionKey(session.sessionId), JSON.stringify(session), "PX", ttl);
}

export function availableIntegrations() {
  const entries = allowUnverified() ? CATALOGUE.filter((e) => e.verificationStatus !== "paused") : listedIntegrations();
  const provider = connectionProvider();
  return entries.flatMap((e) => {
    const signIn = e.auth.kind === "oauth" && provider?.supports(e.id) === true;
    if (e.auth.kind === "api_key" || signIn || keyAuthOf(e)) return [integrationView(e, { signIn })];
    return provider ? [{ ...integrationView(e), ownOAuthAppRequired: true as const }] : [];
  });
}

export async function listConnections(workspaceId: string, environmentId: string): Promise<SecretView[]> {
  return (await listSecrets(workspaceId, environmentId)).filter((secret) => secret.integrationId !== null);
}

export async function connectWithKey(
  scope: { workspaceId: string; environmentId: string },
  input: { integrationId: string; secretName: string; apiKey?: string; fields?: Record<string, string>; description?: string },
): Promise<SecretView> {
  const entry = connectableIntegration(input.integrationId, allowUnverified());
  const keyAuth = keyAuthOf(entry);
  if (!keyAuth) {
    throw new ValidationError(`${entry.displayName} is connected by signing in, not with a key. Start a session with POST /api/v2/connections/sessions.`);
  }
  const { stored, accountHost } = readCredentialInput(entry, { apiKey: input.apiKey, fields: input.fields });
  const hosts = accountHost ? [accountHost] : Array.isArray(entry.hosts) ? [...entry.hosts] : null;
  if (!hosts) throw new ValidationError(`${entry.displayName} cannot be connected with a key.`);
  await limitSessionRate(scope.workspaceId);
  if ((await connectionIdOfSecret(scope.workspaceId, scope.environmentId, input.secretName)) !== undefined) {
    throw new ConflictError(`Secret ${input.secretName} already exists in this environment. Choose another name, or delete it first.`);
  }
  await checkSecretQuota(scope.workspaceId);
  await checkKey(entry, keyAuth, stored, accountHost);

  const secret = await putSecret(scope.workspaceId, input.secretName, {
    value: stored,
    description: input.description,
    allowedHosts: hosts,
    allowedPlacements: ["header"],
    integrationId: entry.id,
    checked: true,
  }, scope.environmentId);
  logger.info({ workspaceId: scope.workspaceId, integrationId: entry.id, secretName: input.secretName }, "API-key integration connected");
  emitEvent(scope.workspaceId, "secret.connected", {
    environmentId: scope.environmentId, sessionId: null, integrationId: entry.id, secretName: input.secretName,
  });
  return secret;
}

export async function limitSessionRate(workspaceId: string): Promise<void> {
  const window = Math.floor(Date.now() / 60_000);
  const key = `ratelimit:connect-sessions:${workspaceId}:${window}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  if (count > SESSIONS_PER_MINUTE) {
    throw new RateLimitError(`At most ${SESSIONS_PER_MINUTE} connect sessions may be started per minute. Retry shortly.`);
  }
}

async function signInEntry(integrationId: string, environmentId: string): Promise<IntegrationEntry> {
  const known = findIntegration(integrationId);
  if (known?.auth.kind === "oauth" && (await environmentOAuthClient(environmentId, known.id))) return known;
  return connectableIntegration(integrationId, allowUnverified());
}

export interface StartedSession {
  sessionId: string;
  sessionToken: string;
  expiresAt: Date;
  connectUrl: string;
  integration: ReturnType<typeof integrationView>;
}

export async function startSession(
  scope: { workspaceId: string; environmentId: string; userId: string | null; apiKeyId: string | null },
  input: { integrationId: string; secretName: string; description?: string },
): Promise<StartedSession> {
  const provider = requireConnectionProvider();
  const parsedName = secretNameSchema.safeParse(input.secretName);
  if (!parsedName.success) throw new ValidationError(parsedName.error.issues[0]?.message ?? "Invalid secret name");
  const entry = await signInEntry(input.integrationId, scope.environmentId);
  const integrationKey = entry.id;
  if (entry.auth.kind !== "oauth") {
    throw new ValidationError(`${entry.displayName} is connected with an API key, not by signing in. Send the key to POST /api/v2/connections/keys.`);
  }
  if (!(await provider.supportsIn(integrationKey, scope.environmentId))) {
    throw new OwnOAuthAppRequiredError(entry.id, entry.displayName);
  }
  await limitSessionRate(scope.workspaceId);
  if ((await connectionIdOfSecret(scope.workspaceId, scope.environmentId, input.secretName)) !== undefined) {
    throw new ConflictError(`Secret ${input.secretName} already exists in this environment. Choose another name, or delete it first.`);
  }
  await checkSecretQuota(scope.workspaceId);

  return openSession(scope, entry, {
    secretName: input.secretName,
    description: input.description ?? null,
    mode: "connect",
    mint: (endUserId) => provider.createConnectSession({ endUserId, integrationKey }),
  });
}

async function openSession(
  scope: { workspaceId: string; environmentId: string; userId: string | null; apiKeyId: string | null },
  entry: IntegrationEntry,
  input: {
    secretName: string;
    description: string | null;
    mode: "connect" | "reconnect";
    mint: (endUserId: string) => Promise<{ sessionToken: string; expiresAt: Date }>;
  },
): Promise<StartedSession> {
  const sessionId = `csn_${randomBytes(18).toString("base64url").replace(/[-_]/g, "")}`;
  const endUserId = endUserIdFor(scope.workspaceId, scope.environmentId, sessionId);
  let minted: { sessionToken: string; expiresAt: Date };
  try {
    minted = await input.mint(endUserId);
  } catch (error) {
    logger.error({ workspaceId: scope.workspaceId, mode: input.mode, error: error instanceof Error ? error.message : String(error) }, "Starting a connect session failed");
    throw new ConnectionProviderError("The connected-account service could not start a session. Try again shortly.");
  }
  const expiresAt = new Date(Math.min(minted.expiresAt.getTime(), Date.now() + SESSION_TTL_SECONDS * 1000));
  const session: PendingSession = {
    sessionId,
    workspaceId: scope.workspaceId,
    environmentId: scope.environmentId,
    integrationId: entry.id,
    secretName: input.secretName,
    description: input.description,
    startedBy: { userId: scope.userId, apiKeyId: scope.apiKeyId },
    tokenHash: createHash("sha256").update(minted.sessionToken).digest("hex"),
    endUserId,
    expiresAt: expiresAt.toISOString(),
    status: "pending",
    connectionId: null,
    mode: input.mode,
  };
  await redis.set(sessionKey(sessionId), JSON.stringify(session), "PX", Math.max(1000, expiresAt.getTime() - Date.now()));
  logger.info({ workspaceId: scope.workspaceId, sessionId, integrationId: entry.id, secretName: input.secretName, mode: input.mode }, "Connect session started");
  emitEvent(scope.workspaceId, input.mode === "reconnect" ? "secret.reconnect_started" : "secret.connect_started", {
    environmentId: scope.environmentId, sessionId, integrationId: entry.id, secretName: input.secretName,
  });

  return {
    sessionId,
    sessionToken: minted.sessionToken,
    expiresAt,
    connectUrl: requireConnectionProvider().connectUrl(minted.sessionToken),
    integration: integrationView(entry),
  };
}

export async function checkConnection(scope: { workspaceId: string; environmentId: string }, secretName: string): Promise<SecretView> {
  await limitSessionRate(scope.workspaceId);
  return checkSecretHealth(scope, secretName, { thorough: true });
}

export type ReconnectResult =
  | { status: "completed"; secret: SecretView; session: null }
  | { status: "pending"; secret: null; session: StartedSession };

export async function reconnect(
  scope: { workspaceId: string; environmentId: string; userId: string | null; apiKeyId: string | null },
  secretName: string,
  input: { apiKey?: string; fields?: Record<string, string> },
): Promise<ReconnectResult> {
  const secret = await getSecretMetadata(scope.workspaceId, secretName, scope.environmentId);
  const entry = integrationOf(secret);
  if (entry.verificationStatus === "paused") throw new ValidationError(`${entry.displayName} is no longer offered, so ${secretName} cannot be reconnected.`);
  await limitSessionRate(scope.workspaceId);

  const keyAuth = keyAuthOf(entry);
  if (keyAuth && secret.kind !== "connection") {
    if (!input.apiKey && !input.fields) {
      throw new ValidationError(usesFields(keyAuth)
        ? `${secretName} is connected with ${entry.displayName} fields. Send them again in fields.`
        : `${secretName} is connected with a ${entry.displayName} key. Create a new key at the provider and send it as apiKey.`);
    }
    if (secret.kind !== "static") throw new ValidationError(`${secretName} cannot be reconnected with a key.`);
    const { stored, accountHost } = readCredentialInput(entry, { apiKey: input.apiKey, fields: input.fields });
    const hosts = accountHost ? [accountHost] : Array.isArray(entry.hosts) ? [...entry.hosts] : null;
    if (!hosts) throw new ValidationError(`${secretName} cannot be reconnected with a key.`);
    if (accountHost && (secret.allowedHosts?.length !== 1 || secret.allowedHosts[0] !== accountHost)) {
      throw new ValidationError(`${secretName} is bound to another ${entry.displayName} account. Connect ${accountHost} as a new connection instead.`);
    }
    await checkKey(entry, keyAuth, stored, accountHost);
    const updated = await putSecret(scope.workspaceId, secretName, {
      value: stored, allowedHosts: hosts, allowedPlacements: ["header"], checked: true,
    }, scope.environmentId);
    logger.info({ workspaceId: scope.workspaceId, integrationId: entry.id, secretName }, "API-key connected account reconnected");
    emitEvent(scope.workspaceId, "secret.reconnected", {
      environmentId: scope.environmentId, sessionId: null, integrationId: entry.id, secretName,
    });
    return { status: "completed", secret: updated, session: null };
  }

  if (input.apiKey !== undefined) {
    throw new ValidationError(`${secretName} is connected by signing in at ${entry.displayName}, so no key is needed. Send an empty body to start the sign-in.`);
  }
  const provider = requireConnectionProvider();
  const integrationKey = entry.id;
  if (secret.kind !== "connection") throw new ValidationError(`${secretName} cannot be reconnected by signing in.`);
  if (!(await provider.supportsIn(integrationKey, scope.environmentId))) {
    throw new OwnOAuthAppRequiredError(entry.id, entry.displayName);
  }
  const connectionId = await connectionIdOfSecret(scope.workspaceId, scope.environmentId, secretName);
  if (!connectionId) throw new ValidationError(`${secretName} is not bound to an account that can be reconnected.`);
  const session = await openSession(scope, entry, {
    secretName,
    description: null,
    mode: "reconnect",
    mint: (endUserId) => provider.createReconnectSession({ endUserId, integrationKey, connectionId }),
  });
  return { status: "pending", secret: null, session };
}

export type CompletionResult = { status: "pending"; secret: null } | { status: "completed"; secret: SecretView };

async function finish(session: PendingSession, connectionId: string): Promise<SecretView> {
  const entry = findIntegration(session.integrationId);
  if (!entry || entry.auth.kind !== "oauth") throw new ValidationError("This integration is no longer offered.");
  const integrationKey = entry.id;
  const provider = requireConnectionProvider();

  const existing = await connectionIdOfSecret(session.workspaceId, session.environmentId, session.secretName);
  if (session.mode === "reconnect") return finishReconnect(session, connectionId, existing, integrationKey);
  if (existing === connectionId) return getSecretMetadata(session.workspaceId, session.secretName, session.environmentId);
  if (existing !== undefined) {
    throw new ConflictError(`Secret ${session.secretName} was created by something else while this account was being connected. Start again with another name.`);
  }

  let details;
  try {
    details = await provider.getConnection({ integrationKey, connectionId });
  } catch (error) {
    if (error instanceof ConnectionRevokedError) {
      throw new ValidationError("The account was not connected: the consent did not finish, or access was withdrawn. Start again.");
    }
    logger.error({ sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) }, "Reading a connection failed");
    throw new ConnectionProviderError();
  }
  if (details.tags.end_user_id !== session.endUserId) {
    logger.warn({ sessionId: session.sessionId, connectionId }, "Connection does not belong to this connect session");
    throw new ValidationError("That account was not connected through this session.");
  }
  const hosts = resolveHosts(entry, details.connectionConfig);

  let secret: SecretView;
  try {
    secret = await putConnectionSecret(session.workspaceId, session.secretName, {
      integrationId: entry.id, connectionId, allowedHosts: hosts, description: session.description ?? undefined,
    }, session.environmentId);
  } catch (error) {
    if ((await connectionIdOfSecret(session.workspaceId, session.environmentId, session.secretName)) === connectionId) {
      return getSecretMetadata(session.workspaceId, session.secretName, session.environmentId);
    }
    throw error;
  }
  logger.info({ workspaceId: session.workspaceId, sessionId: session.sessionId, connectionId, secretName: session.secretName }, "Connect session completed");
  emitEvent(session.workspaceId, "secret.connected", {
    environmentId: session.environmentId, sessionId: session.sessionId, integrationId: entry.id, secretName: session.secretName,
  });
  return secret;
}

async function finishReconnect(
  session: PendingSession,
  connectionId: string,
  bound: string | null | undefined,
  integrationKey: string,
): Promise<SecretView> {
  if (bound === undefined) throw new ValidationError(`Secret ${session.secretName} was deleted while it was being reconnected. Connect the account again instead.`);
  if (bound !== connectionId) {
    logger.warn({ sessionId: session.sessionId, connectionId }, "Reconnect consent reported a connection the secret is not bound to");
    throw new ValidationError("That account was not reconnected through this session.");
  }
  try {
    await requireConnectionProvider().getConnection({ integrationKey, connectionId });
  } catch (error) {
    if (error instanceof ConnectionRevokedError) {
      throw new ValidationError("The account was not reconnected: the consent did not finish, or access was withdrawn. Start again.");
    }
    logger.error({ sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) }, "Reading a reconnected connection failed");
    throw new ConnectionProviderError();
  }
  const secret = await markSecretHealthy({ workspaceId: session.workspaceId, environmentId: session.environmentId, name: session.secretName });
  if (!secret) throw new ValidationError(`Secret ${session.secretName} was deleted while it was being reconnected. Connect the account again instead.`);
  logger.info({ workspaceId: session.workspaceId, sessionId: session.sessionId, connectionId, secretName: session.secretName }, "Reconnect session completed");
  emitEvent(session.workspaceId, "secret.reconnected", {
    environmentId: session.environmentId, sessionId: session.sessionId, integrationId: session.integrationId, secretName: session.secretName,
  });
  return secret;
}

export async function completeSession(
  scope: { workspaceId: string; environmentId: string },
  sessionId: string,
  reference?: string,
): Promise<CompletionResult> {
  requireConnectionProvider();
  const session = await loadSession(sessionId);
  if (!session || session.workspaceId !== scope.workspaceId || session.environmentId !== scope.environmentId) {
    throw new ConnectionSessionExpiredError();
  }
  if (session.status === "completed" && session.connectionId) {
    return { status: "completed", secret: await getSecretMetadata(session.workspaceId, session.secretName, session.environmentId) };
  }
  if (session.failure) throw new ValidationError(session.failure.message);
  if (reference && reference !== session.connectionId) {
    throw new ValidationError("That account was not connected through this session.");
  }
  const connectionId = session.connectionId;
  if (!connectionId) return { status: "pending", secret: null };
  const secret = await finish(session, connectionId);
  await saveSession({ ...session, status: "completed", connectionId });
  return { status: "completed", secret };
}

const FAILURE_MESSAGES = {
  declined: "The account was not connected: access was not approved at the provider. Start again to retry.",
  provider_error: "The account was not connected: the provider did not complete the sign-in. Start again shortly.",
} as const;

export async function recordConsentFailure(endUserId: string, reason: keyof typeof FAILURE_MESSAGES): Promise<void> {
  const tagged = parseEndUserId(endUserId);
  const session = tagged ? await loadSession(tagged.sessionId) : null;
  if (!session || session.endUserId !== endUserId || session.status === "completed") return;
  await saveSession({ ...session, failure: { message: FAILURE_MESSAGES[reason] } });
  logger.info({ sessionId: session.sessionId, reason }, "Consent ended without an account");
}

export async function recordConsent(outcome: ConsentOutcome): Promise<string> {
  const { connectionId, integrationKey, endUserId } = outcome;
  const tagged = parseEndUserId(endUserId);
  const session = tagged ? await loadSession(tagged.sessionId) : null;

  const bound = await secretsBoundToConnection(connectionId);
  if (bound.length > 0) {
    if (outcome.operation !== "override" && session?.mode !== "reconnect") return "duplicate: already connected";
    for (const secret of bound) await markSecretHealthy(secret);
    if (session && session.mode === "reconnect" && session.status !== "completed") {
      await saveSession({ ...session, status: "completed", connectionId });
      emitEvent(session.workspaceId, "secret.reconnected", {
        environmentId: session.environmentId, sessionId: session.sessionId, integrationId: session.integrationId, secretName: session.secretName,
      });
    } else {
      for (const secret of bound) {
        emitEvent(secret.workspaceId, "secret.reconnected", { environmentId: secret.environmentId, sessionId: null, integrationId: secret.integrationId, secretName: secret.name });
      }
    }
    logger.info({ connectionId, secrets: bound.length }, "Connection re-authorised; bound secrets marked working");
    return `reconnected: ${bound.length} secret(s)`;
  }

  const revoke = async (why: string) => {
    try {
      await requireConnectionProvider().deleteConnection({ integrationKey, connectionId });
    } catch (error) {
      logger.error({ connectionId, error: error instanceof Error ? error.message : String(error) }, "Revoking an unbound connection failed");
    }
    logger.warn({ connectionId, sessionId: tagged?.sessionId ?? null }, why);
  };

  if (!tagged || !session || session.endUserId !== endUserId) {
    await revoke("Connection with no live connect session was revoked");
    return "stray: revoked";
  }
  if (session.workspaceId !== tagged.workspaceId || session.environmentId !== tagged.environmentId) return "ignored: scope mismatch";
  if (session.status === "completed") return "duplicate: already completed";

  await saveSession({ ...session, connectionId });
  try {
    await finish(session, connectionId);
    await saveSession({ ...session, status: "completed", connectionId });
    return "completed";
  } catch (error) {
    const message = error instanceof ValidationError || error instanceof ConflictError
      ? error.message
      : "The account was not connected: it could not be recorded. Start again shortly.";
    logger.warn({ sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) }, "A finished consent could not complete its session");
    if (session.mode === "reconnect") {
      await saveSession({ ...session, failure: { message } });
    } else {
      await revoke("Connection whose session refused it was revoked");
      await saveSession({ ...session, connectionId: null, failure: { message } });
    }
    return "refused: completion refused";
  }
}

export { ConnectionProviderFailure };
