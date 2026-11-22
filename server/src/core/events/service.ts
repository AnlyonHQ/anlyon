import { limitAdvice } from "../billing/limit-advice.ts";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { events, eventSubscriptions, eventTopics } from "../../db/schema/events.ts";
import { messages } from "../../db/schema/messages.ts";
import { queues } from "../../db/schema/queues.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { environments } from "../../db/schema/environments.ts";
import { redis, RedisKeys } from "../../lib/redis.ts";
import { env } from "../../config/env.ts";
import { redactLogHeaders } from "../logging/public-log.ts";
import {
  generateEventId,
  generateSubscriptionId,
  generateTopicId,
  generateDeliverySecret,
  encryptSecret,
  decryptSecret,
  generateQueueId,
} from "../../utils/crypto.ts";
import {
  ConflictError,
  EventNotFoundError,
  ReservedTopicError,
  SubscriptionNotFoundError,
  TopicNotFoundError,
  ValidationError,
} from "../../utils/errors.ts";
import {
  QuotaExceededError,
  checkEventPublishQuota,
} from "../billing/usage-enforcement.ts";
import { incrementEventPublishesFast } from "../../lib/workspace-cache.ts";
import { getPlanLimits, type PlanType } from "../plans/limits.ts";
import { validateUrl } from "../../utils/url-validation.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ module: "events" });

export const RESERVED_TOPIC_NAME = "anlyon";
export const SYSTEM_QUEUE_NAME = "__events__";
const SUB_SECRET_CACHE_TTL = 3600;

async function getDefaultEnvironmentId(workspaceId: string): Promise<string> {
  const [row] = await db.select({ id: environments.id }).from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.isDefault, true)));
  if (!row) throw new ValidationError("Workspace environment not found");
  return row.id;
}

type TopicRow = typeof eventTopics.$inferSelect;
type SubscriptionRow = typeof eventSubscriptions.$inferSelect;
type EventRow = typeof events.$inferSelect;

function toTopic(row: TopicRow) {
  return {
    id: row.topicId,
    name: row.name,
    description: row.description,
    isReserved: row.isReserved,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSubscription(row: SubscriptionRow) {
  return {
    id: row.subscriptionId,
    url: row.url,
    eventTypes: row.eventTypes,
    enabled: row.enabled,
    hasCustomSecret: row.secretEncrypted !== null,
    headers: (redactLogHeaders(row.headers) as Record<string, string> | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEvent(row: EventRow, topicName?: string) {
  return {
    id: row.eventId,
    topic: topicName,
    type: row.type,
    data: (row.data as Record<string, unknown>) ?? {},
    status: row.status,
    subscriptionCount: row.subscriptionCount,
    createdAt: row.createdAt,
  };
}

const topicNamePattern = /^[a-zA-Z0-9_-]+$/;

export async function resolveTopicRow(
  workspaceId: string,
  ref: string,
  environmentId?: string
): Promise<TopicRow> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const byId = ref.startsWith("top_");
  const [row] = await db
    .select()
    .from(eventTopics)
    .where(
      and(
        eq(eventTopics.workspaceId, workspaceId),
        eq(eventTopics.environmentId, scopedEnvironmentId),
        byId ? eq(eventTopics.topicId, ref) : eq(eventTopics.name, ref)
      )
    );
  if (!row) {
    throw new TopicNotFoundError(`Topic "${ref}" not found`);
  }
  return row;
}

export async function createTopic(
  workspaceId: string,
  input: { name: string; description?: string },
  environmentId?: string
) {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  if (!topicNamePattern.test(input.name)) {
    throw new ValidationError("Topic name must be alphanumeric with hyphens and underscores only");
  }
  if (input.name === RESERVED_TOPIC_NAME) {
    throw new ReservedTopicError(`"${RESERVED_TOPIC_NAME}" is the reserved platform topic`);
  }

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const limits = getPlanLimits((workspace?.plan ?? "free") as PlanType, workspace);
  if (limits.maxTopics !== "unlimited") {
    const [{ total }] = await db
      .select({ total: count() })
      .from(eventTopics)
      .where(and(eq(eventTopics.workspaceId, workspaceId), eq(eventTopics.environmentId, scopedEnvironmentId), eq(eventTopics.isReserved, false)));
    if (Number(total) >= limits.maxTopics) {
      throw new QuotaExceededError(
        `Free plan allows up to ${limits.maxTopics} topics. ${limitAdvice("resource", "topics")}`,
        0
      );
    }
  }

  try {
    const [row] = await db
      .insert(eventTopics)
      .values({
        workspaceId,
        environmentId: scopedEnvironmentId,
        topicId: generateTopicId(),
        name: input.name,
        description: input.description,
      })
      .returning();
    return toTopic(row);
  } catch (error) {
    if (error instanceof Error && error.message.includes("event_topics_ws_name_unique")) {
      throw new ConflictError(`Topic "${input.name}" already exists`);
    }
    throw error;
  }
}

export async function listTopics(workspaceId: string, environmentId?: string) {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const rows = await db
    .select()
    .from(eventTopics)
    .where(and(eq(eventTopics.workspaceId, workspaceId), eq(eventTopics.environmentId, scopedEnvironmentId)))
    .orderBy(desc(eventTopics.createdAt));
  return rows.map(toTopic);
}

export async function getTopic(workspaceId: string, ref: string, environmentId?: string) {
  return toTopic(await resolveTopicRow(workspaceId, ref, environmentId));
}

export async function updateTopic(
  workspaceId: string,
  ref: string,
  updates: { name?: string; description?: string },
  environmentId?: string
) {
  const row = await resolveTopicRow(workspaceId, ref, environmentId);
  if (row.isReserved && updates.name !== undefined) {
    throw new ReservedTopicError("The platform topic cannot be renamed");
  }
  if (updates.name !== undefined) {
    if (!topicNamePattern.test(updates.name)) {
      throw new ValidationError("Topic name must be alphanumeric with hyphens and underscores only");
    }
    if (updates.name === RESERVED_TOPIC_NAME) {
      throw new ReservedTopicError(`"${RESERVED_TOPIC_NAME}" is the reserved platform topic`);
    }
  }

  const [updated] = await db
    .update(eventTopics)
    .set({
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.description !== undefined ? { description: updates.description } : {}),
      updatedAt: new Date(),
    })
    .where(eq(eventTopics.id, row.id))
    .returning();
  return toTopic(updated);
}

export async function deleteTopic(workspaceId: string, ref: string, environmentId?: string): Promise<void> {
  const row = await resolveTopicRow(workspaceId, ref, environmentId);
  if (row.isReserved) {
    throw new ReservedTopicError("The platform topic cannot be deleted");
  }
  await db.delete(eventTopics).where(eq(eventTopics.id, row.id));
  await refreshHasSubsFlag(workspaceId);
}

export async function ensureReservedTopic(workspaceId: string, environmentId?: string): Promise<TopicRow> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const [existing] = await db
    .select()
    .from(eventTopics)
    .where(and(eq(eventTopics.workspaceId, workspaceId), eq(eventTopics.environmentId, scopedEnvironmentId), eq(eventTopics.isReserved, true)));
  if (existing) return existing;

  const [row] = await db
    .insert(eventTopics)
    .values({
      workspaceId,
      environmentId: scopedEnvironmentId,
      topicId: generateTopicId(),
      name: RESERVED_TOPIC_NAME,
      description: "Platform lifecycle events (approval.*, action.invocation.*, environment.*, secret.*, end_user.*, budget.*)",
      isReserved: true,
    })
    .onConflictDoNothing()
    .returning();

  if (row) return row;
  const [winner] = await db
    .select()
    .from(eventTopics)
    .where(and(eq(eventTopics.workspaceId, workspaceId), eq(eventTopics.environmentId, scopedEnvironmentId), eq(eventTopics.isReserved, true)));
  return winner;
}

export async function createSubscription(
  workspaceId: string,
  topicRef: string,
  input: {
    url: string;
    eventTypes?: string[];
    enabled?: boolean;
    generateSecret?: boolean;
    headers?: Record<string, string>;
  },
  environmentId?: string
) {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const topic =
    topicRef === RESERVED_TOPIC_NAME
      ? await ensureReservedTopic(workspaceId, scopedEnvironmentId)
      : await resolveTopicRow(workspaceId, topicRef, scopedEnvironmentId);

  const urlValidation = validateUrl(input.url);
  if (!urlValidation.valid) {
    throw new ValidationError(`Invalid URL: ${urlValidation.error}`);
  }

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const limits = getPlanLimits((workspace?.plan ?? "free") as PlanType, workspace);
  if (limits.maxSubscriptionsPerTopic !== "unlimited") {
    const [{ total }] = await db
      .select({ total: count() })
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.topicId, topic.id));
    if (Number(total) >= limits.maxSubscriptionsPerTopic) {
      throw new QuotaExceededError(
        `Free plan allows up to ${limits.maxSubscriptionsPerTopic} subscriptions per topic. ${limitAdvice("resource", "subscriptions")}`,
        0
      );
    }
  }

  let secretEncrypted: string | null = null;
  let plaintextSecret: string | undefined;
  if (input.generateSecret) {
    const { secret } = generateDeliverySecret();
    plaintextSecret = secret;
    secretEncrypted = encryptSecret(secret, env.DELIVERY_SECRET_MASTER_KEY, {
      store: "event-subscription",
      workspaceId,
    });
  }

  const [row] = await db
    .insert(eventSubscriptions)
    .values({
      workspaceId,
      environmentId: scopedEnvironmentId,
      topicId: topic.id,
      subscriptionId: generateSubscriptionId(),
      url: input.url,
      eventTypes: input.eventTypes && input.eventTypes.length > 0 ? input.eventTypes : ["*"],
      enabled: input.enabled ?? true,
      secretEncrypted,
      headers: input.headers ?? null,
    })
    .returning();

  await refreshHasSubsFlag(workspaceId);

  return { ...toSubscription(row), secret: plaintextSecret };
}

export async function upsertMcpSubscription(input: {
  workspaceId: string;
  environmentId: string;
  subscriptionId: string;
  url: string;
  secret: string;
  mcpEventName: string;
  platformTypes: readonly string[];
  principal: string;
  expiresAt: Date;
}): Promise<void> {
  const defaultEnvironmentId = await getDefaultEnvironmentId(input.workspaceId);
  const topic = await ensureReservedTopic(input.workspaceId, defaultEnvironmentId);
  const [existing] = await db
    .select({ id: eventSubscriptions.id })
    .from(eventSubscriptions)
    .where(eq(eventSubscriptions.subscriptionId, input.subscriptionId));

  if (!existing) {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId));
    const limits = getPlanLimits((workspace?.plan ?? "free") as PlanType, workspace);
    if (limits.maxSubscriptionsPerTopic !== "unlimited") {
      const [{ total }] = await db
        .select({ total: count() })
        .from(eventSubscriptions)
        .where(eq(eventSubscriptions.topicId, topic.id));
      if (Number(total) >= limits.maxSubscriptionsPerTopic) {
        throw new QuotaExceededError(
          `Free plan allows up to ${limits.maxSubscriptionsPerTopic} subscriptions per topic. ${limitAdvice("resource", "subscriptions")}`,
          0
        );
      }
    }
  }

  const values = {
    url: input.url,
    eventTypes: [...input.platformTypes],
    enabled: true,
    secretEncrypted: encryptSecret(input.secret, env.DELIVERY_SECRET_MASTER_KEY, {
      store: "event-subscription",
      workspaceId: input.workspaceId,
    }),
    deliveryFormat: "mcp" as const,
    expiresAt: input.expiresAt,
    mcpEventName: input.mcpEventName,
    mcpPrincipal: input.principal,
    mcpEnvironmentId: input.environmentId,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(eventSubscriptions)
    .values({
      workspaceId: input.workspaceId,
      environmentId: defaultEnvironmentId,
      topicId: topic.id,
      subscriptionId: input.subscriptionId,
      headers: null,
      ...values,
    })
    .onConflictDoUpdate({ target: eventSubscriptions.subscriptionId, set: values })
    .returning({ id: eventSubscriptions.id });

  await redis.del(subSecretCacheKey(row.id));
  await refreshHasSubsFlag(input.workspaceId);
}

export async function deleteMcpSubscription(workspaceId: string, subscriptionId: string): Promise<void> {
  const deleted = await db
    .delete(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.workspaceId, workspaceId),
        eq(eventSubscriptions.subscriptionId, subscriptionId),
        eq(eventSubscriptions.deliveryFormat, "mcp")
      )
    )
    .returning({ id: eventSubscriptions.id });
  for (const row of deleted) await redis.del(subSecretCacheKey(row.id));
  if (deleted.length > 0) await refreshHasSubsFlag(workspaceId);
}

export async function listSubscriptions(workspaceId: string, topicRef: string, environmentId?: string) {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const topic = await resolveTopicRow(workspaceId, topicRef, scopedEnvironmentId);
  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.topicId, topic.id),
        eq(eventSubscriptions.environmentId, scopedEnvironmentId),
        eq(eventSubscriptions.deliveryFormat, "anlyon"),
      ),
    )
    .orderBy(desc(eventSubscriptions.createdAt));
  return rows.map(toSubscription);
}

async function resolveSubscriptionRow(
  workspaceId: string,
  subscriptionId: string,
  environmentId?: string
): Promise<SubscriptionRow> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const [row] = await db
    .select()
    .from(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.workspaceId, workspaceId),
        eq(eventSubscriptions.environmentId, scopedEnvironmentId),
        eq(eventSubscriptions.subscriptionId, subscriptionId),
        eq(eventSubscriptions.deliveryFormat, "anlyon")
      )
    );
  if (!row) {
    throw new SubscriptionNotFoundError();
  }
  return row;
}

export async function updateSubscription(
  workspaceId: string,
  subscriptionId: string,
  updates: {
    url?: string;
    eventTypes?: string[];
    enabled?: boolean;
    headers?: Record<string, string> | null;
  },
  environmentId?: string
) {
  const row = await resolveSubscriptionRow(workspaceId, subscriptionId, environmentId);

  if (updates.url !== undefined) {
    const urlValidation = validateUrl(updates.url);
    if (!urlValidation.valid) {
      throw new ValidationError(`Invalid URL: ${urlValidation.error}`);
    }
  }

  const [updated] = await db
    .update(eventSubscriptions)
    .set({
      ...(updates.url !== undefined ? { url: updates.url } : {}),
      ...(updates.eventTypes !== undefined ? { eventTypes: updates.eventTypes } : {}),
      ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
      ...(updates.headers !== undefined ? { headers: updates.headers } : {}),
      updatedAt: new Date(),
    })
    .where(eq(eventSubscriptions.id, row.id))
    .returning();

  await refreshHasSubsFlag(workspaceId);
  return toSubscription(updated);
}

export async function deleteSubscription(workspaceId: string, subscriptionId: string, environmentId?: string): Promise<void> {
  const row = await resolveSubscriptionRow(workspaceId, subscriptionId, environmentId);
  await db.delete(eventSubscriptions).where(eq(eventSubscriptions.id, row.id));
  await redis.del(subSecretCacheKey(row.id));
  await refreshHasSubsFlag(workspaceId);
}

export async function rotateSubscriptionSecret(workspaceId: string, subscriptionId: string, environmentId?: string) {
  const row = await resolveSubscriptionRow(workspaceId, subscriptionId, environmentId);
  const { secret } = generateDeliverySecret();
  const encrypted = encryptSecret(secret, env.DELIVERY_SECRET_MASTER_KEY, {
    store: "event-subscription",
    workspaceId,
  });

  await db
    .update(eventSubscriptions)
    .set({ secretEncrypted: encrypted, updatedAt: new Date() })
    .where(eq(eventSubscriptions.id, row.id));
  await redis.del(subSecretCacheKey(row.id));

  return { id: row.subscriptionId, secret };
}

function subSecretCacheKey(internalId: string): string {
  return `cache:sub-signing:v2:${internalId}`;
}

export interface SubscriptionSigning {
  secret: string | null;
  format: "anlyon" | "mcp";
  expiresAt: Date | null;
}

interface CachedSigning {
  workspaceId: string;
  secretEncrypted: string | null;
  format: "anlyon" | "mcp";
  expiresAt: string | null;
}

export async function getSubscriptionSigningByInternalId(
  internalId: string
): Promise<SubscriptionSigning | null> {
  const cacheKey = subSecretCacheKey(internalId);
  const cached = await redis.get(cacheKey);
  let entry: CachedSigning | null;
  if (cached !== null) {
    entry = cached === "" ? null : (JSON.parse(cached) as CachedSigning);
  } else {
    const [row] = await db
      .select({
        workspaceId: eventSubscriptions.workspaceId,
        secretEncrypted: eventSubscriptions.secretEncrypted,
        format: eventSubscriptions.deliveryFormat,
        expiresAt: eventSubscriptions.expiresAt,
      })
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, internalId));
    entry = row ? { ...row, expiresAt: row.expiresAt?.toISOString() ?? null } : null;
    await redis.set(cacheKey, entry ? JSON.stringify(entry) : "", "EX", SUB_SECRET_CACHE_TTL);
  }
  if (!entry) return null;

  return {
    secret: entry.secretEncrypted
      ? decryptSecret(entry.secretEncrypted, env.DELIVERY_SECRET_MASTER_KEY, {
          store: "event-subscription",
          workspaceId: entry.workspaceId,
        })
      : null,
    format: entry.format,
    expiresAt: entry.expiresAt ? new Date(entry.expiresAt) : null,
  };
}

async function refreshHasSubsFlag(workspaceId: string): Promise<void> {
  try {
    const [{ total }] = await db
      .select({ total: count() })
      .from(eventSubscriptions)
      .innerJoin(eventTopics, eq(eventSubscriptions.topicId, eventTopics.id))
      .where(
        and(
          eq(eventSubscriptions.workspaceId, workspaceId),
          eq(eventSubscriptions.enabled, true),
          eq(eventTopics.isReserved, true)
        )
      );
    if (Number(total) > 0) {
      await redis.set(RedisKeys.eventsHasSubs(workspaceId), "1");
    } else {
      await redis.del(RedisKeys.eventsHasSubs(workspaceId));
    }
  } catch (error) {
    logger.warn({ workspaceId, error }, "Failed to refresh events has-subs flag");
  }
}

export async function syncEventSubscriberFlags(): Promise<number> {
  const rows = await db
    .selectDistinct({ workspaceId: eventSubscriptions.workspaceId })
    .from(eventSubscriptions)
    .innerJoin(eventTopics, eq(eventSubscriptions.topicId, eventTopics.id))
    .where(and(eq(eventSubscriptions.enabled, true), eq(eventTopics.isReserved, true)));

  if (rows.length > 0) {
    const pipeline = redis.pipeline();
    for (const { workspaceId } of rows) {
      pipeline.set(RedisKeys.eventsHasSubs(workspaceId), "1");
    }
    await pipeline.exec();
  }

  logger.info({ count: rows.length }, "Synced events has-subs flags to Redis");
  return rows.length;
}

export async function publishEvent(
  workspaceId: string,
  input: {
    topic: string;
    type: string;
    data?: Record<string, unknown>;
    idempotencyKey?: string;
  },
  options: { allowReserved?: boolean; traceRunId?: string; traceParentSpanId?: string; environmentId?: string } = {}
): Promise<{ id: string; status: string; deduplicated?: boolean }> {
  const environmentId = options.environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const topic = await resolveTopicRow(workspaceId, input.topic, environmentId);
  if (topic.isReserved && !options.allowReserved) {
    throw new ReservedTopicError("Publishing to the platform topic is not allowed");
  }
  if (!input.type?.trim()) {
    throw new ValidationError("type is required");
  }

  if (!options.allowReserved) {
    await checkEventPublishQuota(workspaceId);
  }

  const [row] = await db
    .insert(events)
    .values({
      workspaceId,
      environmentId,
      topicId: topic.id,
      eventId: generateEventId(),
      type: input.type.trim(),
      data: input.data ?? {},
      idempotencyKey: input.idempotencyKey ?? null,
      traceRunId: options.traceRunId ?? null,
      traceParentSpanId: options.traceParentSpanId ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (!row) {
    const [existing] = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.workspaceId, workspaceId),
          eq(events.environmentId, environmentId),
          eq(events.topicId, topic.id),
          eq(events.idempotencyKey, input.idempotencyKey!)
        )
      );
    return { id: existing.eventId, status: existing.status, deduplicated: true };
  }

  if (!options.allowReserved) {
    await incrementEventPublishesFast(workspaceId);
  }

  await redis.xadd(
    RedisKeys.eventsIngestStream(),
    "MAXLEN",
    "~",
    env.EVENTS_STREAM_MAXLEN,
    "*",
    "eventId",
    row.id,
    "workspaceId",
    workspaceId
  );

  return { id: row.eventId, status: row.status };
}

export async function listEvents(
  workspaceId: string,
  options: { topic?: string; type?: string; limit?: number; offset?: number; environmentId?: string }
) {
  const environmentId = options.environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;

  const conditions = [eq(events.workspaceId, workspaceId), eq(events.environmentId, environmentId)];
  if (options.topic) {
    const topic = await resolveTopicRow(workspaceId, options.topic, environmentId);
    conditions.push(eq(events.topicId, topic.id));
  }
  if (options.type) {
    conditions.push(eq(events.type, options.type));
  }
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        event: events,
        topicName: eventTopics.name,
      })
      .from(events)
      .innerJoin(eventTopics, eq(events.topicId, eventTopics.id))
      .where(where)
      .orderBy(desc(events.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(events).where(where),
  ]);

  return {
    events: rows.map(({ event, topicName }) => toEvent(event, topicName)),
    total: Number(total),
  };
}

export async function getEventWithDeliveries(workspaceId: string, publicEventId: string, environmentId?: string) {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const [row] = await db
    .select({
      event: events,
      topicName: eventTopics.name,
    })
    .from(events)
    .innerJoin(eventTopics, eq(events.topicId, eventTopics.id))
    .where(and(eq(events.workspaceId, workspaceId), eq(events.environmentId, scopedEnvironmentId), eq(events.eventId, publicEventId)));

  if (!row) {
    throw new EventNotFoundError();
  }

  const deliveries = await db
    .select({
      messageId: messages.messageId,
      url: messages.url,
      status: messages.status,
      attempts: messages.attempts,
      responseStatus: messages.responseStatus,
      deliveredAt: messages.deliveredAt,
      failedAt: messages.failedAt,
    })
    .from(messages)
    .where(eq(messages.eventId, row.event.id));

  return { ...toEvent(row.event, row.topicName), deliveries };
}

export async function ensureSystemQueue(workspaceId: string, environmentId?: string): Promise<string> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const [existing] = await db
    .select({ name: queues.name })
    .from(queues)
    .where(
      and(
        eq(queues.workspaceId, workspaceId),
        eq(queues.environmentId, scopedEnvironmentId),
        eq(queues.name, SYSTEM_QUEUE_NAME),
        sql`${queues.status} != 'deleted'`
      )
    );
  if (existing) return SYSTEM_QUEUE_NAME;

  await db
    .insert(queues)
    .values({
      workspaceId,
      environmentId: scopedEnvironmentId,
      queueId: generateQueueId(),
      name: SYSTEM_QUEUE_NAME,
      description: "System queue for event fan-out deliveries",
      parallelism: 10,
      isSystem: true,
    })
    .onConflictDoNothing();

  return SYSTEM_QUEUE_NAME;
}
