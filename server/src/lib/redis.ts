import {Redis} from "ioredis";
import { env } from "../config/env.ts";
import { redisLogger } from "./logger.ts";
import dotenv from "dotenv";
dotenv.config();
const redisUrl = process.env.REDIS_URL;

const commonOptions = {
  maxRetriesPerRequest: 3,
  connectTimeout: 10000,
  enableOfflineQueue: true,
  retryStrategy(times: number) {
    return Math.min(times * 50, 5000);
  },
  reconnectOnError(err: Error) {
    if (err.message.includes("READONLY")) {
      return true;
    }
    return false;
  },
  keepAlive: 10000,
  noDelay: true,
  enableReadyCheck: true,
  lazyConnect: false,
};

redisLogger.info("Initializing Redis connection (API)");
export const redis = new Redis(redisUrl as string, {
  ...commonOptions,
  commandTimeout: 5000,
});

redisLogger.info("Initializing Redis connection (Workers)");
export const redisBlocking = new Redis(redisUrl as string, {
  ...commonOptions,
});

export function createBlockingConnection(label: string): Redis {
  const conn = redisBlocking.duplicate();
  conn.on("error", (err) => {
    redisLogger.error({ err, label }, "Redis blocking connection error");
  });
  return conn;
}

redis.on("connect", () => {
  redisLogger.info("Redis API client connected");
});

redis.on("ready", () => {
  redisLogger.info("Redis API client ready");
});

redis.on("error", (err) => {
  redisLogger.error({ err }, "Redis API client error");
});

redis.on("close", () => {
  redisLogger.warn("Redis API client connection closed");
});

redis.on("reconnecting", () => {
  redisLogger.info("Redis API client reconnecting");
});

redisBlocking.on("connect", () => {
  redisLogger.info("Redis Worker client connected");
});

redisBlocking.on("ready", () => {
  redisLogger.info("Redis Worker client ready");
});

redisBlocking.on("error", (err) => {
  redisLogger.error({ err }, "Redis Worker client error");
});

redisBlocking.on("close", () => {
  redisLogger.warn("Redis Worker client connection closed");
});

redisBlocking.on("reconnecting", () => {
  redisLogger.info("Redis Worker client reconnecting");
});

export const USAGE_COUNTER_TTL_SECONDS = 172_800;

export const WAITING_EVENT_TTL_SECONDS = 30 * 24 * 60 * 60;

export const RedisKeys = {
  pendingStream: (workspaceId: string) => `workspace:${workspaceId}:stream:pending`,
  scheduledSet: (workspaceId: string) => `workspace:${workspaceId}:zset:scheduled`,
  processingSet: (workspaceId: string) => `workspace:${workspaceId}:zset:processing`,
  dlqSet: (workspaceId: string) => `workspace:${workspaceId}:zset:dlq`,

  queuePendingStream: (workspaceId: string, queueId: string) => `queue:${workspaceId}:${queueId}:stream:pending`,
  queueScheduledSet: (workspaceId: string, queueId: string) => `queue:${workspaceId}:${queueId}:zset:scheduled`,

  activeQueues: (workspaceId: string) => `index:queues:${workspaceId}:active`,
  activeQueuesPending: () => `index:queues:pending`,

  activeWorkspacesPending: () => `index:workspaces:pending`,
  activeWorkspacesScheduled: () => `index:workspaces:scheduled`,
  activeWorkspacesProcessing: () => `index:workspaces:processing`,

  message: (workspaceId: string, messageId: string) =>
    `workspace:${workspaceId}:messages:${messageId}`,

  contentHash: (workspaceId: string, hash: string) =>
    `workspace:${workspaceId}:dedup:${hash}`,

  usageCounter: (workspaceId: string, date: string, metric: string) =>
    `workspace:${workspaceId}:usage:${date}:${metric}`,

  rateLimit: (workspaceId: string, window: string) =>
    `workspace:${workspaceId}:ratelimit:${window}`,

  apiKey: (keyHash: string) => `apikey:${keyHash}`,
  apiKeyPrevious: (keyId: string) => `apikey:${keyId}:previous`,
  apiKeyRollbackLock: (keyId: string) => `apikey:${keyId}:rollback-lock`,

  deliverySecret: (workspaceId: string) => `workspace:${workspaceId}:delivery-secret`,
  deliverySecretOld: (workspaceId: string) => `workspace:${workspaceId}:delivery-secret:old`,

  workerLock: (workerName: string) => `lock:worker:${workerName}`,

  circuitBreaker: (host: string) => `circuit:${host}`,

  workerHeartbeat: (workerType: string, workerId: string) => `health:worker:${workerType}:${workerId}`,
  activeWorkers: (workerType: string) => `health:workers:${workerType}`,

  workspaceCache: (workspaceId: string) => `cache:workspace:${workspaceId}`,

  quotaDaily: (workspaceId: string, date: string) => `quota:${workspaceId}:daily:${date}`,
  quotaMonthly: (workspaceId: string, month: string) => `quota:${workspaceId}:monthly:${month}`,
  quotaBandwidth: (workspaceId: string, month: string) => `quota:${workspaceId}:bandwidth:${month}`,
  idempotency: (workspaceId: string, environmentId: string, key: string) =>
    `idempotency:${workspaceId}:${environmentId}:${key}`,
  quotaEventPublishes: (workspaceId: string, month: string) => `quota:${workspaceId}:event-publishes:${month}`,
  quotaActionInvokes: (workspaceId: string, month: string) => `quota:${workspaceId}:action-invokes:${month}`,
  keyBudgetCounter: (keyId: string, dim: string, month: string) => `budget:${keyId}:${dim}:${month}`,
  keyBudgetConfig: (keyId: string) => `cache:budget:${keyId}`,
  keyBudgetAlerted: (keyId: string, month: string) => `budget:${keyId}:alerted:${month}`,
  approvalsPendingCount: (workspaceId: string) => `approvals:${workspaceId}:pending-count`,

  environmentHalt: (environmentId: string) => `env:halt:${environmentId}`,

  notificationEmails: (workspaceId: string, month: string) =>
    `notif-emails:${workspaceId}:${month}`,

  abuseStats: (workspaceId: string, hour: string) => `abuse:${workspaceId}:${hour}:stats`,
  abuseHosts: (workspaceId: string, hour: string) => `abuse:${workspaceId}:${hour}:hosts`,
  workspaceSuspended: (workspaceId: string) => `ws:suspended:${workspaceId}`,

  eventsIngestStream: () => `events:ingest`,
  eventsHasSubs: (workspaceId: string) => `events:has-subs:${workspaceId}`,
  eventsFanoutAttempts: (eventInternalId: string) => `events:fanout-attempts:${eventInternalId}`,

  realtimeStream: (workspaceId: string) => `realtime:${workspaceId}`,
};

const INCR_WITH_TTL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export async function incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
  return (await redis.eval(INCR_WITH_TTL_SCRIPT, 1, key, ttlSeconds.toString())) as number;
}

export function checkPipelineResults(
  results: [error: Error | null, result: unknown][] | null,
  context?: string
): [error: Error | null, result: unknown][] {
  if (!results) {
    throw new Error(`Pipeline execution returned null${context ? ` (${context})` : ""}`);
  }

  const errors: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const [err] = results[i];
    if (err) {
      errors.push(`Operation ${i}: ${err.message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Pipeline operations failed${context ? ` (${context})` : ""}: ${errors.join("; ")}`);
  }

  return results;
}

export async function execPipelineChecked(
  pipeline: ReturnType<typeof redis.pipeline>,
  context?: string
): Promise<[error: Error | null, result: unknown][]> {
  const results = await pipeline.exec();
  return checkPipelineResults(results, context);
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === "PONG";
  } catch (error) {
    redisLogger.error({ error }, "Redis health check failed");
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  redisLogger.info("Closing Redis connections");
  await Promise.all([
    redis.quit(),
    redisBlocking.quit(),
  ]);
}

const MOVE_TO_STREAM_SCRIPT = `
local sourceKey = KEYS[1]
local streamKey = KEYS[2]
local indexKey = KEYS[3]
local messageId = ARGV[1]
local workspaceId = ARGV[2]

-- Check if message exists in source set and remove it atomically
local removed = redis.call('ZREM', sourceKey, messageId)
if removed == 0 then
  return 0
end

-- Add to stream
redis.call('XADD', streamKey, '*', 'messageId', messageId)

-- Add to workspace index
redis.call('SADD', indexKey, workspaceId)

return 1
`;

export async function atomicMoveScheduledToPending(
  workspaceId: string,
  messageId: string
): Promise<boolean> {
  const result = await redis.eval(
    MOVE_TO_STREAM_SCRIPT,
    3,
    RedisKeys.scheduledSet(workspaceId),
    RedisKeys.pendingStream(workspaceId),
    RedisKeys.activeWorkspacesPending(),
    messageId,
    workspaceId
  );
  return result === 1;
}

export async function atomicMoveProcessingToPending(
  workspaceId: string,
  messageId: string
): Promise<boolean> {
  const result = await redis.eval(
    MOVE_TO_STREAM_SCRIPT,
    3,
    RedisKeys.processingSet(workspaceId),
    RedisKeys.pendingStream(workspaceId),
    RedisKeys.activeWorkspacesPending(),
    messageId,
    workspaceId
  );
  return result === 1;
}

const BATCH_MOVE_TO_STREAM_SCRIPT = `
local sourceKey = KEYS[1]
local streamKey = KEYS[2]
local indexKey = KEYS[3]
local workspaceId = ARGV[1]
local moved = {}

for i = 2, #ARGV do
  local messageId = ARGV[i]
  local removed = redis.call('ZREM', sourceKey, messageId)
  if removed == 1 then
    redis.call('XADD', streamKey, '*', 'messageId', messageId)
    moved[#moved + 1] = messageId
  end
end

if #moved > 0 then
  redis.call('SADD', indexKey, workspaceId)
end

return moved
`;

export async function batchMoveScheduledToPending(
  workspaceId: string,
  messageIds: string[]
): Promise<string[]> {
  if (messageIds.length === 0) return [];

  return (await redis.eval(
    BATCH_MOVE_TO_STREAM_SCRIPT,
    3,
    RedisKeys.scheduledSet(workspaceId),
    RedisKeys.pendingStream(workspaceId),
    RedisKeys.activeWorkspacesPending(),
    workspaceId,
    ...messageIds
  )) as string[];
}

export async function batchMoveQueueScheduledToPending(
  workspaceId: string,
  queueId: string,
  messageIds: string[]
): Promise<string[]> {
  if (messageIds.length === 0) return [];

  return (await redis.eval(
    BATCH_MOVE_TO_STREAM_SCRIPT,
    3,
    RedisKeys.queueScheduledSet(workspaceId, queueId),
    RedisKeys.queuePendingStream(workspaceId, queueId),
    RedisKeys.activeQueuesPending(),
    `${workspaceId}:${queueId}`,
    ...messageIds
  )) as string[];
}

export async function batchMoveProcessingToPending(
  workspaceId: string,
  messageIds: string[]
): Promise<string[]> {
  if (messageIds.length === 0) return [];

  return (await redis.eval(
    BATCH_MOVE_TO_STREAM_SCRIPT,
    3,
    RedisKeys.processingSet(workspaceId),
    RedisKeys.pendingStream(workspaceId),
    RedisKeys.activeWorkspacesPending(),
    workspaceId,
    ...messageIds
  )) as string[];
}

export async function getNextScheduledTimestamp(
  workspaceIds: string[]
): Promise<number | null> {
  if (workspaceIds.length === 0) return null;

  let minScore: number | null = null;

  const queuePipeline = redis.pipeline();
  for (const workspaceId of workspaceIds) {
    queuePipeline.smembers(RedisKeys.activeQueues(workspaceId));
  }
  const queueResults = await queuePipeline.exec();

  const pipeline = redis.pipeline();
  for (let i = 0; i < workspaceIds.length; i++) {
    const workspaceId = workspaceIds[i];
    pipeline.zrange(RedisKeys.scheduledSet(workspaceId), 0, 0, "WITHSCORES");

    const [err, queueIds] = queueResults?.[i] ?? [null, []];
    if (!err && Array.isArray(queueIds)) {
      for (const queueId of queueIds as string[]) {
        pipeline.zrange(
          RedisKeys.queueScheduledSet(workspaceId, queueId),
          0,
          0,
          "WITHSCORES"
        );
      }
    }
  }

  const results = await pipeline.exec();
  if (!results) return null;

  for (const [err, result] of results) {
    if (err) continue;
    const arr = result as string[];
    if (arr && arr.length >= 2) {
      const score = parseInt(arr[1]);
      if (!isNaN(score) && (minScore === null || score < minScore)) {
        minScore = score;
      }
    }
  }

  return minScore;
}

export async function getNextRetryTimestamp(
  workspaceIds: string[]
): Promise<number | null> {
  if (workspaceIds.length === 0) return null;

  let minScore: number | null = null;

  const pipeline = redis.pipeline();
  for (const workspaceId of workspaceIds) {
    pipeline.zrange(RedisKeys.processingSet(workspaceId), 0, 0, "WITHSCORES");
  }

  const results = await pipeline.exec();
  if (!results) return null;

  for (const [err, result] of results) {
    if (err) continue;
    const arr = result as string[];
    if (arr && arr.length >= 2) {
      const score = parseInt(arr[1]);
      if (!isNaN(score) && (minScore === null || score < minScore)) {
        minScore = score;
      }
    }
  }

  return minScore;
}
