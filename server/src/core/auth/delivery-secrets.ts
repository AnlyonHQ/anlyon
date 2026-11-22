import { db } from "../../db/index.ts";
import { deliverySecrets } from "../../db/schema/workspaces.ts";
import { eq, and, desc } from "drizzle-orm";
import {
  generateDeliverySecret,
  encryptSecret,
  decryptSecret,
  signDeliveryPayload,
  signDeliveryPayloadForEnvironment,
  appendDeliverySignature,
} from "../../utils/crypto.ts";
import {
  NotFoundError,
  ConflictError,
  DeliverySecretUnreadableError,
} from "../../utils/errors.ts";
import { redis, RedisKeys } from "../../lib/redis.ts";
import { env } from "../../config/env.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ module: "delivery-secrets" });

const ROTATION_GRACE_PERIOD_MS = 5 * 60 * 1000;

const CACHE_TTL_SECONDS = 3600;

const LAST_USED_THROTTLE_SECONDS = 300;

export async function createDeliverySecret(
  workspaceId: string,
  userId: string
): Promise<{ secret: DeliverySecretInfo; secretKey: string }> {
  const existing = await db
    .select()
    .from(deliverySecrets)
    .where(
      and(
        eq(deliverySecrets.workspaceId, workspaceId),
        eq(deliverySecrets.isActive, "true")
      )
    );

  if (existing.length > 0) {
    throw new ConflictError(
      "Workspace already has an active delivery secret. Use regenerate to create a new one."
    );
  }

  const { secret: secretKey, prefix } = generateDeliverySecret();

  const encrypted = encryptSecret(secretKey, env.DELIVERY_SECRET_MASTER_KEY, { store: "delivery", workspaceId });

  logger.info({ workspaceId, userId }, "Creating delivery secret");

  const [deliverySecret] = await db
    .insert(deliverySecrets)
    .values({
      workspaceId,
      secretEncrypted: encrypted,
      secretPrefix: prefix,
      version: 1,
      createdBy: userId,
    })
    .returning();

  await cacheDeliverySecret(workspaceId, encrypted);

  logger.info(
    { secretId: deliverySecret.id, workspaceId },
    "Delivery secret created"
  );

  return {
    secret: {
      id: deliverySecret.id,
      workspaceId: deliverySecret.workspaceId,
      secretPrefix: deliverySecret.secretPrefix,
      version: deliverySecret.version,
      isActive: deliverySecret.isActive === "true",
      createdAt: deliverySecret.createdAt,
      createdBy: deliverySecret.createdBy,
      lastUsedAt: deliverySecret.lastUsedAt,
    },
    secretKey,
  };
}

export async function getDeliverySecret(
  workspaceId: string
): Promise<string | null> {
  const encrypted = await getActiveSecretCiphertext(workspaceId);
  if (!encrypted) return null;

  try {
    return decryptSecret(encrypted, env.DELIVERY_SECRET_MASTER_KEY, {
      store: "delivery",
      workspaceId,
    });
  } catch (error) {
    logger.error(
      { workspaceId, error: error instanceof Error ? error.message : "Unknown error" },
      "Failed to decrypt delivery secret - master key may have changed or data is corrupted"
    );
    throw new DeliverySecretUnreadableError(workspaceId);
  }
}

async function getActiveSecretCiphertext(workspaceId: string): Promise<string | null> {
  const cached = await redis.get(RedisKeys.deliverySecret(workspaceId));
  if (cached !== null) {
    return cached === "" ? null : cached;
  }

  const [deliverySecret] = await db
    .select()
    .from(deliverySecrets)
    .where(
      and(
        eq(deliverySecrets.workspaceId, workspaceId),
        eq(deliverySecrets.isActive, "true")
      )
    )
    .orderBy(desc(deliverySecrets.version))
    .limit(1);

  await cacheDeliverySecret(workspaceId, deliverySecret?.secretEncrypted ?? "");
  return deliverySecret?.secretEncrypted ?? null;
}

export async function getDeliverySecretInfo(
  workspaceId: string
): Promise<DeliverySecretInfo | null> {
  const [deliverySecret] = await db
    .select({
      id: deliverySecrets.id,
      workspaceId: deliverySecrets.workspaceId,
      secretPrefix: deliverySecrets.secretPrefix,
      version: deliverySecrets.version,
      isActive: deliverySecrets.isActive,
      createdAt: deliverySecrets.createdAt,
      createdBy: deliverySecrets.createdBy,
      lastUsedAt: deliverySecrets.lastUsedAt,
    })
    .from(deliverySecrets)
    .where(
      and(
        eq(deliverySecrets.workspaceId, workspaceId),
        eq(deliverySecrets.isActive, "true")
      )
    )
    .orderBy(desc(deliverySecrets.version))
    .limit(1);

  if (!deliverySecret) {
    return null;
  }

  return {
    ...deliverySecret,
    isActive: deliverySecret.isActive === "true",
  };
}

export async function regenerateDeliverySecret(
  workspaceId: string,
  userId: string
): Promise<{ secret: DeliverySecretInfo; secretKey: string }> {
  const [currentSecret] = await db
    .select()
    .from(deliverySecrets)
    .where(
      and(
        eq(deliverySecrets.workspaceId, workspaceId),
        eq(deliverySecrets.isActive, "true")
      )
    )
    .orderBy(desc(deliverySecrets.version))
    .limit(1);

  if (!currentSecret) {
    throw new NotFoundError("No active delivery secret found");
  }

  const { secret: secretKey, prefix } = generateDeliverySecret();
  const encrypted = encryptSecret(secretKey, env.DELIVERY_SECRET_MASTER_KEY, { store: "delivery", workspaceId });

  logger.info(
    { workspaceId, userId, oldVersion: currentSecret.version },
    "Regenerating delivery secret"
  );

  await db
    .update(deliverySecrets)
    .set({
      isActive: "false",
      deactivatedAt: new Date(),
    })
    .where(eq(deliverySecrets.id, currentSecret.id));

  const [newSecret] = await db
    .insert(deliverySecrets)
    .values({
      workspaceId,
      secretEncrypted: encrypted,
      secretPrefix: prefix,
      version: currentSecret.version + 1,
      createdBy: userId,
    })
    .returning();

  await cacheDeliverySecret(workspaceId, encrypted);
  await cacheOldDeliverySecret(workspaceId, currentSecret.secretEncrypted);

  logger.info(
    {
      secretId: newSecret.id,
      workspaceId,
      newVersion: newSecret.version,
    },
    "Delivery secret regenerated"
  );

  return {
    secret: {
      id: newSecret.id,
      workspaceId: newSecret.workspaceId,
      secretPrefix: newSecret.secretPrefix,
      version: newSecret.version,
      isActive: newSecret.isActive === "true",
      createdAt: newSecret.createdAt,
      createdBy: newSecret.createdBy,
      lastUsedAt: newSecret.lastUsedAt,
    },
    secretKey,
  };
}

export async function signDeliveryForWorkspace(
  workspaceId: string,
  payload: string,
  environmentId?: string,
): Promise<{ signature: string; timestamp: number } | null> {
  const secret = await getDeliverySecret(workspaceId);

  if (!secret) {
    logger.warn({ workspaceId }, "No delivery secret found, skipping signature");
    return null;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const sign = (key: string) => environmentId
    ? signDeliveryPayloadForEnvironment(payload, key, environmentId, timestamp)
    : signDeliveryPayload(payload, key, timestamp);
  let signature = sign(secret);

  const previous = await getPreviousDeliverySecret(workspaceId);
  if (previous && previous !== secret) {
    signature = appendDeliverySignature(
      signature,
      sign(previous)
    );
  }

  queueLastUsedTouch(workspaceId);

  return { signature, timestamp };
}

export async function deleteDeliverySecret(
  workspaceId: string
): Promise<void> {
  await db
    .delete(deliverySecrets)
    .where(eq(deliverySecrets.workspaceId, workspaceId));

  await redis.del(RedisKeys.deliverySecret(workspaceId));
  await redis.del(RedisKeys.deliverySecretOld(workspaceId));

  logger.info({ workspaceId }, "Delivery secret deleted");
}

async function cacheDeliverySecret(
  workspaceId: string,
  encryptedSecret: string
): Promise<void> {
  await redis.set(
    RedisKeys.deliverySecret(workspaceId),
    encryptedSecret,
    "EX",
    CACHE_TTL_SECONDS
  );
}

async function cacheOldDeliverySecret(
  workspaceId: string,
  encryptedSecret: string
): Promise<void> {
  await redis.set(
    RedisKeys.deliverySecretOld(workspaceId),
    encryptedSecret,
    "EX",
    Math.floor(ROTATION_GRACE_PERIOD_MS / 1000)
  );
}

async function getPreviousDeliverySecret(workspaceId: string): Promise<string | null> {
  const encrypted = await redis.get(RedisKeys.deliverySecretOld(workspaceId));
  if (!encrypted) return null;
  try {
    return decryptSecret(encrypted, env.DELIVERY_SECRET_MASTER_KEY, {
      store: "delivery",
      workspaceId,
    });
  } catch (error) {
    logger.warn(
      { workspaceId, error: error instanceof Error ? error.message : "Unknown error" },
      "Could not read previous delivery secret; skipping the rotation overlap signature"
    );
    return null;
  }
}

function queueLastUsedTouch(workspaceId: string): void {
  void (async () => {
    try {
      const claimed = await redis.set(
        `delivery-secret:${workspaceId}:touched`,
        "1",
        "EX",
        LAST_USED_THROTTLE_SECONDS,
        "NX"
      );
      if (claimed !== "OK") return;

      await db
        .update(deliverySecrets)
        .set({ lastUsedAt: new Date() })
        .where(
          and(
            eq(deliverySecrets.workspaceId, workspaceId),
            eq(deliverySecrets.isActive, "true")
          )
        );
    } catch (error) {
      logger.error({ error, workspaceId }, "Failed to update lastUsedAt");
    }
  })();
}

export interface DeliverySecretInfo {
  id: string;
  workspaceId: string;
  secretPrefix: string;
  version: number;
  isActive: boolean;
  createdAt: Date;
  createdBy: string | null;
  lastUsedAt: Date | null;
}
