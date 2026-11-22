import { db } from "../../db/index.ts";
import { messages } from "../../db/schema/messages.ts";
import { redactLogHeaders } from "../logging/public-log.ts";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { redis, RedisKeys } from "../../lib/redis.ts";
import { resolveMessageDestination } from "./destination.ts";
import { NotFoundError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";
import type { PaginateOptions } from "../../utils/pagination.ts";

const logger = createLogger({ module: "dlq" });

export interface DLQScope {
  workspaceId: string;
  environmentId: string;
}

export const DLQ_BULK_LIMIT = 1000;

type MessageRow = typeof messages.$inferSelect;

function toDLQMessage(message: MessageRow) {
  return {
    messageId: message.messageId,
    url: message.url,
    method: message.method,
    headers: redactLogHeaders(message.headers),
    body: message.body,
    status: message.status,
    scheduledFor: message.scheduledFor,
    attempts: message.attempts,
    maxRetries: message.maxRetries,
    responseStatus: message.responseStatus,
    responseBody: message.responseBody,
    errorMessage: message.errorMessage,
    deliveredAt: message.deliveredAt,
    failedAt: message.failedAt,
    callbackUrl: message.callbackUrl,
    failureCallbackUrl: message.failureCallbackUrl,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

function failedInScope(scope: DLQScope) {
  return and(
    eq(messages.workspaceId, scope.workspaceId),
    eq(messages.environmentId, scope.environmentId),
    eq(messages.status, "failed"),
  );
}

async function getDLQMessageRow(scope: DLQScope, messageId: string) {
  const [message] = await db
    .select()
    .from(messages)
    .where(and(failedInScope(scope), eq(messages.messageId, messageId)));

  if (!message) {
    throw new NotFoundError("Failed message");
  }

  return message;
}

async function countFailed(scope: DLQScope): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(failedInScope(scope));
  return Number(row?.count || 0);
}

export async function listDLQMessages(
  scope: DLQScope,
  options: PaginateOptions = { page: 1, limit: 20 }
) {
  const { page, limit } = options;
  const offset = (page - 1) * limit;

  const failedMessages = await db
    .select()
    .from(messages)
    .where(failedInScope(scope))
    .orderBy(desc(messages.failedAt))
    .limit(limit)
    .offset(offset);

  const total = await countFailed(scope);

  return {
    messages: failedMessages.map(toDLQMessage),
    total,
    page,
    limit,
  };
}

export async function getDLQMessage(scope: DLQScope, messageId: string) {
  return toDLQMessage(await getDLQMessageRow(scope, messageId));
}

export async function retryDLQMessage(scope: DLQScope, messageId: string) {
  const message = await getDLQMessageRow(scope, messageId);

  logger.info({ messageId, ...scope }, "Retrying message from DLQ");

  const destination = await resolveMessageDestination(scope.workspaceId, messageId);
  if (!destination) throw new NotFoundError("Failed message");
  const queue = destination.queue;

  await db
    .update(messages)
    .set({
      status: "pending",
      attempts: 0,
      errorMessage: null,
      failedAt: null,
    })
    .where(eq(messages.id, message.id));

  const messageData: Record<string, string> = {
    messageId: message.messageId,
    workspaceId: message.workspaceId,
    environmentId: message.environmentId,
    url: message.url,
    method: message.method,
    headers: JSON.stringify(message.headers || {}),
    body: JSON.stringify(message.body),
    maxRetries: (message.maxRetries ?? 0).toString(),
    attempts: "0",
    callbackUrl: message.callbackUrl || "",
    failureCallbackUrl: message.failureCallbackUrl || "",
  };
  if (message.eventId) {
    messageData.eventId = message.eventId;
    if (message.eventSubscriptionId) messageData.eventSubscriptionId = message.eventSubscriptionId;
  }
  if (queue) {
    messageData.queueId = queue.queueId;
    messageData.queueName = queue.name;
  }

  const messageKey = RedisKeys.message(scope.workspaceId, messageId);
  const pipeline = redis.pipeline();
  pipeline.hset(messageKey, messageData);
  pipeline.expire(messageKey, 604800);
  pipeline.zrem(RedisKeys.dlqSet(scope.workspaceId), messageId);
  pipeline.xadd(destination.streamKey, "*", "messageId", messageId);
  pipeline.sadd(destination.pendingIndexKey, destination.pendingIndexMember);
  if (queue) {
    pipeline.sadd(RedisKeys.activeQueues(scope.workspaceId), queue.queueId);
  }
  await pipeline.exec();

  logger.info({ messageId, ...scope, queueId: queue?.queueId }, "Message moved from DLQ to pending");

  return message;
}

export async function retryAllDLQMessages(
  scope: DLQScope,
): Promise<{ retriedCount: number; remaining: number }> {
  const failedMessages = await db
    .select({ messageId: messages.messageId })
    .from(messages)
    .where(failedInScope(scope))
    .orderBy(desc(messages.failedAt))
    .limit(DLQ_BULK_LIMIT);

  let retriedCount = 0;

  for (const message of failedMessages) {
    try {
      await retryDLQMessage(scope, message.messageId);
      retriedCount++;
    } catch (error) {
      logger.error({ messageId: message.messageId, error }, "Failed to retry message");
    }
  }

  const remaining = await countFailed(scope);
  logger.info({ ...scope, retriedCount, remaining }, "Retried DLQ messages");

  return { retriedCount, remaining };
}

export async function deleteDLQMessage(scope: DLQScope, messageId: string) {
  const message = await getDLQMessageRow(scope, messageId);

  await db.delete(messages).where(eq(messages.id, message.id));

  await redis.zrem(RedisKeys.dlqSet(scope.workspaceId), messageId);
  await redis.del(RedisKeys.message(scope.workspaceId, messageId));

  logger.info({ messageId, ...scope }, "Message deleted from DLQ");

  return message;
}

export async function clearDLQ(
  scope: DLQScope,
): Promise<{ deletedCount: number; remaining: number }> {
  const failedMessages = await db
    .select({ id: messages.id, messageId: messages.messageId })
    .from(messages)
    .where(failedInScope(scope))
    .orderBy(desc(messages.failedAt))
    .limit(DLQ_BULK_LIMIT);

  if (failedMessages.length === 0) return { deletedCount: 0, remaining: 0 };

  const ids = failedMessages.map((m) => m.id);
  await db.delete(messages).where(inArray(messages.id, ids));

  const messageIds = failedMessages.map((m) => m.messageId);
  const pipeline = redis.pipeline();
  pipeline.zrem(RedisKeys.dlqSet(scope.workspaceId), ...messageIds);
  for (const messageId of messageIds) {
    pipeline.del(RedisKeys.message(scope.workspaceId, messageId));
  }
  await pipeline.exec();

  const remaining = await countFailed(scope);
  logger.info({ ...scope, deletedCount: failedMessages.length, remaining }, "DLQ cleared");

  return { deletedCount: failedMessages.length, remaining };
}

export async function getDLQStats(scope: DLQScope) {
  const [stats] = await db
    .select({
      totalFailed: sql`count(*)`,
      oldestFailure: sql`min(failed_at)`,
      newestFailure: sql`max(failed_at)`,
    })
    .from(messages)
    .where(failedInScope(scope));

  return {
    totalFailed: Number(stats?.totalFailed || 0),
    oldestFailure: stats?.oldestFailure,
    newestFailure: stats?.newestFailure,
  };
}
