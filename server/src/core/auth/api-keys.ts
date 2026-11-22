import { type AuditRecordInput, writeAuditEvents } from "../audit/outbox.ts";
import type { AuditActor, StoredAuditContext } from "../audit/event-schema.ts";
import { db } from "../../db/index.ts";
import { resolveEnvironmentForKey } from "../environments/service.ts";
import { apiKeys, apiKeyHistory } from "../../db/schema/workspaces.ts";
import { eq, and, desc } from "drizzle-orm";
import { generateApiKey, hashApiKey, encryptSecret, decryptSecret } from "../../utils/crypto.ts";
import { NotFoundError, AuthenticationError, ConflictError, ValidationError } from "../../utils/errors.ts";
import { redis, RedisKeys } from "../../lib/redis.ts";
import { createLogger } from "../../lib/logger.ts";
import { env } from "../../config/env.ts";
import { DEFAULT_API_KEY_SCOPES, liveApiKeyScopes, type ApiKeyScope } from "./api-key-scopes.ts";
import { toPublicApiKey } from "./public-api-key.ts";
import { captureMilestoneOnce } from "../../lib/product-events.ts";
import { TtlCache } from "../../lib/ttl-cache.ts";

const API_KEY_CACHE_TTL_SECONDS = 15 * 60;

const logger = createLogger({ module: "api-keys" });

const ROLLBACK_EXPIRY_HOURS = 24;
const ROLLBACK_EXPIRY_MS = ROLLBACK_EXPIRY_HOURS * 60 * 60 * 1000;

const PREVIOUS_KEY_CACHE_TTL_SECONDS = 24 * 60 * 60;

const ROLLBACK_LOCK_TTL_SECONDS = 30;

export { DEFAULT_API_KEY_SCOPES, type ApiKeyScope } from "./api-key-scopes.ts";

const unknownKeyHashes = new TtlCache<true>({ ttlMs: 60_000, maxEntries: 10_000 });

const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;
const lastUsedWritten = new TtlCache<true>({ ttlMs: LAST_USED_WRITE_INTERVAL_MS, maxEntries: 50_000 });

export function resetApiKeyCachesForTests(): void {
  unknownKeyHashes.clear();
  lastUsedWritten.clear();
}

export interface KeyAuditContext {
  actor?: AuditActor;
  context?: StoredAuditContext;
}

function keyRecord(
  type: string,
  key: typeof apiKeys.$inferSelect,
  actor: AuditActor | undefined,
  audit: KeyAuditContext,
  extra: Record<string, unknown> = {},
): AuditRecordInput {
  return {
    workspaceId: key.workspaceId,
    environmentId: key.environmentId,
    type,
    actor: audit.actor ?? actor ?? { type: "system", id: null },
    context: audit.context,
    resource: { type: "api_key", id: key.id },
    data: {
      keyId: key.id, name: key.name, keyPrefix: key.keyPrefix, scopes: key.scopes ?? null,
      expiresAt: key.expiresAt?.toISOString() ?? null, version: key.version, ...extra,
    },
  };
}

export async function createApiKey(
  workspaceId: string,
  userId: string,
  name: string,
  expiresAt?: Date,
  scopes: ApiKeyScope[] = [...DEFAULT_API_KEY_SCOPES],
  environmentId?: string,
  audit: KeyAuditContext = {},
  options: { endUserRequired?: boolean } = {},
) {
  const { key, hash, prefix } = generateApiKey("live");

  const resolvedEnvironmentId = await resolveEnvironmentForKey(workspaceId, environmentId);

  logger.info({ workspaceId, userId, name, environmentId: resolvedEnvironmentId }, "Creating API key");
  captureMilestoneOnce(workspaceId, "first_api_key_created");

  const apiKey = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(apiKeys)
      .values({
        workspaceId,
        environmentId: resolvedEnvironmentId,
        name,
        keyHash: hash,
        keyPrefix: prefix,
        scopes,
        createdBy: userId,
        expiresAt,
        endUserRequired: options.endUserRequired === true,
      })
      .returning();
    await writeAuditEvents(tx, [keyRecord("api_key.created", created, { type: "user", id: userId }, audit, { endUserRequired: created.endUserRequired })]);
    return created;
  });

  await redis.hset(RedisKeys.apiKey(hash), {
    workspaceId,
    keyId: apiKey.id,
    environmentId: resolvedEnvironmentId,
    isActive: "true",
    expiresAt: expiresAt ? expiresAt.toISOString() : "",
    scopes: JSON.stringify(scopes),
    endUserRequired: apiKey.endUserRequired ? "true" : "false",
  });
  await redis.expire(RedisKeys.apiKey(hash), API_KEY_CACHE_TTL_SECONDS);

  logger.info({ keyId: apiKey.id, workspaceId }, "API key created");

  return {
    apiKey: toPublicApiKey(apiKey),
    key,
  };
}

export async function verifyApiKeyAndGetWorkspace(key: string): Promise<{
  workspaceId: string;
  keyId: string;
  environmentId: string;
  scopes: ApiKeyScope[];
  expiresAt: Date | null;
  endUserRequired: boolean;
}> {
  const hash = hashApiKey(key);

  if (unknownKeyHashes.has(hash)) {
    throw new AuthenticationError("Authentication failed");
  }

  const cached = await redis.hgetall(RedisKeys.apiKey(hash));

  if (cached && Object.keys(cached).length > 0) {
    if (cached.isActive !== "true") {
      throw new AuthenticationError("Authentication failed");
    }

    if (cached.expiresAt && new Date(cached.expiresAt) < new Date()) {
      throw new AuthenticationError("Authentication failed");
    }

    await updateLastUsed(hash);

    if (cached.keyId && cached.environmentId && (cached.endUserRequired === "true" || cached.endUserRequired === "false")) {
      return {
        workspaceId: cached.workspaceId,
        keyId: cached.keyId,
        environmentId: cached.environmentId,
        scopes: cached.scopes ? liveApiKeyScopes(JSON.parse(cached.scopes)) : [...DEFAULT_API_KEY_SCOPES],
        expiresAt: cached.expiresAt ? new Date(cached.expiresAt) : null,
        endUserRequired: cached.endUserRequired === "true",
      };
    }
  }

  const [apiKey] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash));

  if (!apiKey) {
    unknownKeyHashes.set(hash, true);
    throw new AuthenticationError("Authentication failed");
  }

  if (apiKey.isActive !== "true") {
    throw new AuthenticationError("Authentication failed");
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    throw new AuthenticationError("Authentication failed");
  }

  await redis.hset(RedisKeys.apiKey(hash), {
    workspaceId: apiKey.workspaceId,
    keyId: apiKey.id,
    environmentId: apiKey.environmentId,
    isActive: apiKey.isActive,
    expiresAt: apiKey.expiresAt ? apiKey.expiresAt.toISOString() : "",
    scopes: JSON.stringify(apiKey.scopes || DEFAULT_API_KEY_SCOPES),
    endUserRequired: apiKey.endUserRequired ? "true" : "false",
  });
  await redis.expire(RedisKeys.apiKey(hash), API_KEY_CACHE_TTL_SECONDS);

  await updateLastUsed(hash);

  return {
    workspaceId: apiKey.workspaceId,
    keyId: apiKey.id,
    environmentId: apiKey.environmentId,
    scopes: apiKey.scopes ? liveApiKeyScopes(apiKey.scopes) : [...DEFAULT_API_KEY_SCOPES],
    expiresAt: apiKey.expiresAt ?? null,
    endUserRequired: apiKey.endUserRequired === true,
  };
}

async function updateLastUsed(keyHash: string) {
  if (lastUsedWritten.has(keyHash)) return;
  lastUsedWritten.set(keyHash, true);
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.keyHash, keyHash))
    .catch((error) => {
      logger.error({ error }, "Failed to update lastUsedAt");
    });
}

export async function listApiKeys(workspaceId: string): Promise<ApiKeyInfo[]> {
  const keys = await db
    .select({
      id: apiKeys.id,
      workspaceId: apiKeys.workspaceId,
      environmentId: apiKeys.environmentId,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      version: apiKeys.version,
      isActive: apiKeys.isActive,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
      expiresAt: apiKeys.expiresAt,
      scopes: apiKeys.scopes,
      endUserRequired: apiKeys.endUserRequired,
    })
    .from(apiKeys)
    .where(eq(apiKeys.workspaceId, workspaceId));

  return keys.map((key) => ({
    ...toPublicApiKey(key),
  }));
}

export async function revokeApiKey(keyId: string, workspaceId: string, audit: KeyAuditContext = {}) {
  const [apiKey] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspaceId)));

  if (!apiKey) {
    throw new NotFoundError("API key");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(apiKeys)
      .set({ isActive: "false" })
      .where(eq(apiKeys.id, keyId));
    await writeAuditEvents(tx, [keyRecord("api_key.revoked", apiKey, audit.actor, audit)]);
  });

  await redis.del(RedisKeys.apiKey(apiKey.keyHash));

  logger.info({ keyId, workspaceId }, "API key revoked");
}

export async function deleteApiKey(keyId: string, workspaceId: string, audit: KeyAuditContext = {}) {
  const [apiKey] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspaceId)));

  if (!apiKey) {
    throw new NotFoundError("API key");
  }

  await db.transaction(async (tx) => {
    await tx.delete(apiKeys).where(eq(apiKeys.id, keyId));
    await writeAuditEvents(tx, [keyRecord("api_key.deleted", apiKey, audit.actor, audit)]);
  });

  await redis.del(RedisKeys.apiKey(apiKey.keyHash));

  await redis.del(RedisKeys.apiKeyPrevious(keyId));

  logger.info({ keyId, workspaceId }, "API key deleted");
}

export async function regenerateApiKey(
  keyId: string,
  workspaceId: string,
  userId: string,
  audit: KeyAuditContext = {},
): Promise<{
  apiKey: ApiKeyInfo;
  key: string;
  rollbackExpiresAt: Date;
}> {
  const [currentKey] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspaceId)));

  if (!currentKey) {
    throw new NotFoundError("API key");
  }

  if (currentKey.isActive !== "true") {
    throw new ValidationError("Cannot regenerate an inactive API key");
  }

  logger.info(
    { keyId, workspaceId, userId, currentVersion: currentKey.version },
    "Regenerating API key"
  );

  const { key: newKey, hash: newHash, prefix: newPrefix } = generateApiKey("live");

  const rollbackExpiresAt = new Date(Date.now() + ROLLBACK_EXPIRY_MS);

  const encryptedPreviousHash = encryptSecret(currentKey.keyHash, env.API_KEY_SECRET, {
    store: "api-key-history",
    workspaceId,
  });

  const updatedKey = await db.transaction(async (tx) => {
    await tx.insert(apiKeyHistory).values({
      apiKeyId: keyId,
      workspaceId,
      previousKeyHashEncrypted: encryptedPreviousHash,
      previousKeyPrefix: currentKey.keyPrefix,
      version: currentKey.version,
      rotatedBy: userId,
      rollbackExpiresAt,
    });

    const [updated] = await tx
      .update(apiKeys)
      .set({
        keyHash: newHash,
        keyPrefix: newPrefix,
        version: currentKey.version + 1,
      })
      .where(eq(apiKeys.id, keyId))
      .returning();
    await writeAuditEvents(tx, [keyRecord("api_key.regenerated", updated, { type: "user", id: userId }, audit,
      { rollbackExpiresAt: rollbackExpiresAt.toISOString() })]);
    return updated;
  });

  await redis.del(RedisKeys.apiKey(currentKey.keyHash));

  await redis.hset(RedisKeys.apiKey(newHash), {
        workspaceId,
        keyId,
        isActive: "true",
        expiresAt: currentKey.expiresAt ? currentKey.expiresAt.toISOString() : "",
        scopes: JSON.stringify(currentKey.scopes || DEFAULT_API_KEY_SCOPES),
      });
  await redis.expire(RedisKeys.apiKey(newHash), API_KEY_CACHE_TTL_SECONDS);

  await redis.set(
    RedisKeys.apiKeyPrevious(keyId),
    encryptedPreviousHash,
    "EX",
    PREVIOUS_KEY_CACHE_TTL_SECONDS
  );

  logger.info(
    {
      keyId,
      workspaceId,
      newVersion: updatedKey.version,
      rollbackExpiresAt: rollbackExpiresAt.toISOString(),
    },
    "API key regenerated successfully"
  );

  return {
    apiKey: toPublicApiKey(updatedKey),
    key: newKey,
    rollbackExpiresAt,
  };
}

export async function rollbackApiKey(
  keyId: string,
  workspaceId: string,
  userId: string,
  audit: KeyAuditContext = {},
): Promise<ApiKeyInfo> {
  const lockKey = RedisKeys.apiKeyRollbackLock(keyId);
  const lockAcquired = await redis.set(lockKey, "1", "EX", ROLLBACK_LOCK_TTL_SECONDS, "NX");

  if (!lockAcquired) {
    throw new ConflictError("A rollback operation is already in progress for this API key");
  }

  try {
    const [currentKey] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspaceId)));

    if (!currentKey) {
      throw new NotFoundError("API key");
    }

    if (currentKey.isActive !== "true") {
      throw new ValidationError("Cannot rollback an inactive API key");
    }

    const [latestHistory] = await db
      .select()
      .from(apiKeyHistory)
      .where(eq(apiKeyHistory.apiKeyId, keyId))
      .orderBy(desc(apiKeyHistory.rotatedAt))
      .limit(1);

    if (!latestHistory) {
      throw new NotFoundError("No previous version available for rollback");
    }

    if (new Date() > latestHistory.rollbackExpiresAt) {
      throw new ValidationError(
        `Rollback period has expired. Rollback was available until ${latestHistory.rollbackExpiresAt.toISOString()}`
      );
    }

    logger.info(
      {
        keyId,
        workspaceId,
        userId,
        currentVersion: currentKey.version,
        rollbackToVersion: latestHistory.version,
      },
      "Rolling back API key"
    );

    const previousKeyHash = decryptSecret(
      latestHistory.previousKeyHashEncrypted,
      env.API_KEY_SECRET,
      { store: "api-key-history", workspaceId }
    );

    const restoredKey = await db.transaction(async (tx) => {
      const [restored] = await tx
        .update(apiKeys)
        .set({
          keyHash: previousKeyHash,
          keyPrefix: latestHistory.previousKeyPrefix,
          version: latestHistory.version,
        })
        .where(eq(apiKeys.id, keyId))
        .returning();
      await writeAuditEvents(tx, [keyRecord("api_key.rolled_back", restored, { type: "user", id: userId }, audit)]);
      return restored;
    });

    await redis.del(RedisKeys.apiKey(currentKey.keyHash));

    unknownKeyHashes.delete(previousKeyHash);
    await redis.hset(RedisKeys.apiKey(previousKeyHash), {
      workspaceId,
      keyId,
      isActive: "true",
      expiresAt: currentKey.expiresAt ? currentKey.expiresAt.toISOString() : "",
      scopes: JSON.stringify(currentKey.scopes || DEFAULT_API_KEY_SCOPES),
    });
    await redis.expire(RedisKeys.apiKey(previousKeyHash), API_KEY_CACHE_TTL_SECONDS);

    await redis.del(RedisKeys.apiKeyPrevious(keyId));

    await db.delete(apiKeyHistory).where(eq(apiKeyHistory.id, latestHistory.id));

    logger.info(
      {
        keyId,
        workspaceId,
        restoredVersion: restoredKey.version,
      },
      "API key rolled back successfully"
    );

    return toPublicApiKey(restoredKey);
  } finally {
    await redis.del(lockKey);
  }
}

export async function getApiKeyHistory(
  keyId: string,
  workspaceId: string
): Promise<ApiKeyHistoryEntry[]> {
  const [apiKey] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspaceId)));

  if (!apiKey) {
    throw new NotFoundError("API key");
  }

  const history = await db
    .select({
      id: apiKeyHistory.id,
      version: apiKeyHistory.version,
      previousKeyPrefix: apiKeyHistory.previousKeyPrefix,
      rotatedAt: apiKeyHistory.rotatedAt,
      rollbackExpiresAt: apiKeyHistory.rollbackExpiresAt,
      rotatedBy: apiKeyHistory.rotatedBy,
    })
    .from(apiKeyHistory)
    .where(eq(apiKeyHistory.apiKeyId, keyId))
    .orderBy(desc(apiKeyHistory.rotatedAt));

  return history.map((entry) => ({
    id: entry.id,
    version: entry.version,
    keyPrefix: entry.previousKeyPrefix,
    rotatedAt: entry.rotatedAt,
    rollbackExpiresAt: entry.rollbackExpiresAt,
    canRollback: new Date() < entry.rollbackExpiresAt,
    rotatedBy: entry.rotatedBy,
  }));
}

export async function getApiKey(
  keyId: string,
  workspaceId: string
): Promise<ApiKeyInfo | null> {
  const [apiKey] = await db
    .select({
      id: apiKeys.id,
      workspaceId: apiKeys.workspaceId,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      version: apiKeys.version,
      isActive: apiKeys.isActive,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
      expiresAt: apiKeys.expiresAt,
      scopes: apiKeys.scopes,
      endUserRequired: apiKeys.endUserRequired,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspaceId)));

  if (!apiKey) {
    return null;
  }

  return toPublicApiKey(apiKey);
}

export interface ApiKeyInfo {
  id: string;
  workspaceId: string;
  name: string;
  keyPrefix: string;
  version: number;
  isActive: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  expiresAt: Date | null;
  scopes?: string[] | null;
  endUserRequired: boolean;
}

export interface ApiKeyHistoryEntry {
  id: string;
  version: number;
  keyPrefix: string;
  rotatedAt: Date;
  rollbackExpiresAt: Date;
  canRollback: boolean;
  rotatedBy: string | null;
}
