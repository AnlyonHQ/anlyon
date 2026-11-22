import { redis, RedisKeys, execPipelineChecked, createBlockingConnection } from "../lib/redis.ts";
import { db } from "../db/index.ts";
import { queues } from "../db/schema/queues.ts";
import { inArray } from "drizzle-orm";
import { deliverMessage, type MessageData } from "../core/messaging/consumer.ts";
import { createLogger } from "../lib/logger.ts";
import { env } from "../config/env.ts";
import { WorkerHealth } from "../lib/worker-health.ts";
import { captureException } from "../lib/sentry.ts";
import { consumerMetrics, Timer } from "../lib/metrics.ts";
import { workspaceIndexCache } from "../lib/workspace-index-cache.ts";
import { batchAckCollector } from "../lib/batch-ack.ts";
import { callbackQueue } from "../lib/callback-queue.ts";
import { urlValidationCache } from "../lib/url-cache.ts";

const logger = createLogger({ module: "consumer-worker" });

const CONSUMER_GROUP = "consumers";
const DEFAULT_BLOCK_TIME = 5000;
const QUEUE_STATE_TTL_MS = 5000;
const MAX_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 10;
const MAX_IN_FLIGHT = 50;
const MIN_BLOCK_TIME = 100;
const MAX_BLOCK_TIME = 30000;
const TASK_TIMEOUT_MS = 60000;

type XReadGroupResult = [string, [string, string[]][]][];

interface ProcessingTask {
  promise: Promise<void>;
  messageId: string;
  startedAt: number;
  timeoutHandle: NodeJS.Timeout;
}

export class ConsumerWorker {
  private isRunning = false;
  private consumerId: string;
  private health: WorkerHealth;
  private concurrency: number;
  private inFlightTasks: Map<string, ProcessingTask> = new Map();
  private adaptiveBlockTime = DEFAULT_BLOCK_TIME;
  private lastMessageTime = Date.now();
  private lastBlockTimeCalc = 0;
  private cachedBlockTime = DEFAULT_BLOCK_TIME;
  private queueStateCache: Map<string, { skip: boolean; drop: boolean; at: number }> = new Map();

  private blocking: ReturnType<typeof createBlockingConnection>;

  constructor(id: number, concurrency: number = DEFAULT_CONCURRENCY) {
    this.consumerId = `consumer-${id}`;
    this.health = new WorkerHealth("consumer", this.consumerId);
    this.concurrency = concurrency;
    this.blocking = createBlockingConnection(this.consumerId);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn({ consumerId: this.consumerId }, "Consumer already running");
      return;
    }

    this.isRunning = true;
    logger.info({ consumerId: this.consumerId, concurrency: this.concurrency }, "Starting consumer worker");

    await this.health.start();
    consumerMetrics.start();
    await workspaceIndexCache.start();
    await batchAckCollector.start();
    await callbackQueue.start();
    urlValidationCache.start();

    await this.ensureConsumerGroups();

    this.consume().catch((error) => {
      logger.error({ consumerId: this.consumerId, error }, "Consumer loop crashed");
      captureException(error, {
        worker: "consumer",
        consumerId: this.consumerId,
        context: "consume_loop_crash",
      });
    });
  }

  async stop(): Promise<void> {
    logger.info({ consumerId: this.consumerId }, "Stopping consumer worker");
    this.isRunning = false;

    for (const task of this.inFlightTasks.values()) {
      clearTimeout(task.timeoutHandle);
    }

    if (this.inFlightTasks.size > 0) {
      logger.info({ inFlight: this.inFlightTasks.size }, "Waiting for in-flight tasks");
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30000));
      const allTasks = Promise.all(Array.from(this.inFlightTasks.values()).map((t) => t.promise));
      await Promise.race([allTasks, timeout]);
    }

    await this.blocking.quit().catch(() => {});
    await batchAckCollector.stop();
    await callbackQueue.stop();
    await this.health.stop();
    await consumerMetrics.stop();
    await workspaceIndexCache.stop();
    urlValidationCache.stop();
  }

  private async ensureConsumerGroups(): Promise<void> {
    try {
      const workspaceIds = await workspaceIndexCache.getWorkspaceIds("pending");

      if (workspaceIds.length === 0) return;

      const pipeline = redis.pipeline();
      for (const workspaceId of workspaceIds) {
        const streamKey = RedisKeys.pendingStream(workspaceId);
        pipeline.xgroup("CREATE", streamKey, CONSUMER_GROUP, "0", "MKSTREAM");
      }

      const results = await pipeline.exec();
      let created = 0;
      if (results) {
        for (const [err] of results) {
          if (!err) created++;
        }
      }

      if (created > 0) {
        logger.info({ created }, "Consumer groups created");
      }
    } catch (error) {
      logger.error({ error }, "Error ensuring consumer groups");
    }
  }

  private async ensureConsumerGroupsForStreams(keys: string[]): Promise<void> {
    const pipeline = redis.pipeline();
    for (const streamKey of keys) {
      pipeline.xgroup("CREATE", streamKey, CONSUMER_GROUP, "0", "MKSTREAM");
    }
    await pipeline.exec();
  }

  private async getActiveQueueStreamKeys(): Promise<string[]> {
    const pairs = await redis.smembers(RedisKeys.activeQueuesPending());
    if (!pairs || pairs.length === 0) return [];

    const now = Date.now();
    const stale = pairs.filter((pair) => {
      const cached = this.queueStateCache.get(pair);
      return !cached || now - cached.at > QUEUE_STATE_TTL_MS;
    });

    if (stale.length > 0) {
      const queueIds = [...new Set(stale.map((p) => p.split(":")[1]).filter(Boolean))];
      const rows = queueIds.length
        ? await db
            .select({ queueId: queues.queueId, isPaused: queues.isPaused, status: queues.status })
            .from(queues)
            .where(inArray(queues.queueId, queueIds))
        : [];
      const byId = new Map(rows.map((r) => [r.queueId, r]));

      for (const pair of stale) {
        const queueId = pair.split(":")[1];
        const row = queueId ? byId.get(queueId) : undefined;
        if (!row || row.status === "deleted") {
          this.queueStateCache.set(pair, { skip: true, drop: true, at: now });
        } else {
          this.queueStateCache.set(pair, { skip: row.isPaused, drop: false, at: now });
        }
      }
    }

    const keys: string[] = [];
    const toDrop: string[] = [];
    for (const pair of pairs) {
      const state = this.queueStateCache.get(pair);
      if (!state) continue;
      if (state.drop) {
        toDrop.push(pair);
        this.queueStateCache.delete(pair);
        continue;
      }
      if (state.skip) continue;

      const [workspaceId, queueId] = pair.split(":");
      if (!workspaceId || !queueId) {
        toDrop.push(pair);
        continue;
      }
      keys.push(RedisKeys.queuePendingStream(workspaceId, queueId));
    }

    if (toDrop.length > 0) {
      await redis.srem(RedisKeys.activeQueuesPending(), ...toDrop);
    }
    return keys;
  }

  private shouldApplyBackpressure(): boolean {
    return this.inFlightTasks.size >= MAX_IN_FLIGHT;
  }

  private async waitForCapacity(): Promise<void> {
    while (this.shouldApplyBackpressure() && this.isRunning) {
      consumerMetrics.increment("backpressure_events");
      const tasks = Array.from(this.inFlightTasks.values()).map((t) => t.promise);
      if (tasks.length > 0) {
        await Promise.race(tasks);
      }
    }
  }

  private calculateAdaptiveBlockTime(): number {
    const now = Date.now();

    if (now - this.lastBlockTimeCalc < 500) {
      return this.cachedBlockTime;
    }

    this.lastBlockTimeCalc = now;
    const timeSinceLastMessage = now - this.lastMessageTime;

    if (timeSinceLastMessage < 1000) {
      this.adaptiveBlockTime = Math.max(MIN_BLOCK_TIME, this.adaptiveBlockTime / 2);
    } else if (timeSinceLastMessage > 10000) {
      this.adaptiveBlockTime = Math.min(MAX_BLOCK_TIME, this.adaptiveBlockTime * 1.5);
    }

    this.cachedBlockTime = Math.floor(this.adaptiveBlockTime);
    return this.cachedBlockTime;
  }

  private handleTaskTimeout(taskId: string): void {
    const task = this.inFlightTasks.get(taskId);
    if (task) {
      logger.warn({ taskId, messageId: task.messageId, duration: Date.now() - task.startedAt }, "Task timed out");
      this.inFlightTasks.delete(taskId);
      consumerMetrics.increment("task_timeouts");
    }
  }

  private async consume(): Promise<void> {
    let lastWorkspaceCheck = 0;
    let cachedWorkspaceIds: string[] = [];
    let cachedQueueStreamKeys: string[] = [];

    while (this.isRunning) {
      const loopTimer = new Timer();

      try {
        if (this.shouldApplyBackpressure()) {
          await this.waitForCapacity();
          continue;
        }

        const now = Date.now();
        if (now - lastWorkspaceCheck > 1000 || cachedWorkspaceIds.length > 0) {
          cachedWorkspaceIds = await workspaceIndexCache.getWorkspaceIds("pending");
          cachedQueueStreamKeys = await this.getActiveQueueStreamKeys();
          lastWorkspaceCheck = now;
        }

        if (cachedWorkspaceIds.length === 0 && cachedQueueStreamKeys.length === 0) {
          consumerMetrics.increment("idle_loops");
          await this.sleep(this.cachedBlockTime || DEFAULT_BLOCK_TIME);
          continue;
        }

        consumerMetrics.setGauge("active_workspaces", cachedWorkspaceIds.length);
        consumerMetrics.setGauge("active_queue_streams", cachedQueueStreamKeys.length);

        const uniqueWorkspaceIds = [...new Set(cachedWorkspaceIds)];
        const keys = [
          ...uniqueWorkspaceIds.map((id) => RedisKeys.pendingStream(id)),
          ...cachedQueueStreamKeys,
        ];

        await this.ensureConsumerGroupsForStreams(keys);

        const availableCapacity = Math.max(1, this.concurrency - this.inFlightTasks.size);
        const batchSize = Math.min(MAX_BATCH_SIZE, availableCapacity);
        const blockTime = this.calculateAdaptiveBlockTime();
        const ids = keys.map(() => ">");

        const result = (await this.blocking.xreadgroup(
          "GROUP",
          CONSUMER_GROUP,
          this.consumerId,
          "COUNT",
          batchSize,
          "BLOCK",
          blockTime,
          "STREAMS",
          ...keys,
          ...ids
        )) as XReadGroupResult | null;

        if (!result) {
          consumerMetrics.increment("empty_reads");
          continue;
        }

        this.lastMessageTime = Date.now();

        let messagesProcessed = 0;
        for (const [streamKey, messages] of result) {
          const parts = streamKey.split(":");
          if (parts.length < 2 || !parts[1]) {
            logger.error({ streamKey }, "Invalid streamKey format, skipping messages");
            consumerMetrics.increment("invalid_stream_keys");
            continue;
          }
          const workspaceId = parts[1];

          if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId)) {
            logger.error({ streamKey, workspaceId }, "Invalid workspaceId format, skipping messages");
            consumerMetrics.increment("invalid_workspace_ids");
            continue;
          }

          for (const [messageId, fields] of messages) {
            while (this.inFlightTasks.size >= this.concurrency && this.isRunning) {
              await Promise.race(Array.from(this.inFlightTasks.values()).map((t) => t.promise));
            }

            if (!this.isRunning) break;

            const taskId = `${streamKey}:${messageId}`;
            const startedAt = Date.now();

            const timeoutHandle = setTimeout(() => {
              this.handleTaskTimeout(taskId);
            }, TASK_TIMEOUT_MS);

            const promise = this.processMessageWithTracking(
              streamKey,
              workspaceId,
              messageId,
              fields,
              taskId,
              timeoutHandle
            );

            this.inFlightTasks.set(taskId, { promise, messageId, startedAt, timeoutHandle });
            messagesProcessed++;
          }
        }

        consumerMetrics.increment("messages_read", messagesProcessed);
        loopTimer.recordTo(consumerMetrics, "loop_duration_ms");

      } catch (error) {
        logger.error({ error, consumerId: this.consumerId }, "Error in consume loop");
        this.health.recordError();
        consumerMetrics.increment("loop_errors");
        captureException(error, {
          worker: "consumer",
          consumerId: this.consumerId,
          context: "consume_loop",
        });
        await this.sleep(1000);
      }
    }
  }

  private async processMessageWithTracking(
    streamKey: string,
    workspaceId: string,
    streamMessageId: string,
    fields: string[],
    taskId: string,
    timeoutHandle: NodeJS.Timeout
  ): Promise<void> {
    const timer = new Timer();

    try {
      await this.processMessage(streamKey, workspaceId, streamMessageId, fields);
      timer.recordTo(consumerMetrics, "message_processing_ms");
      consumerMetrics.increment("messages_processed");
    } catch (error) {
      consumerMetrics.increment("message_errors");
      logger.error({ error, streamMessageId, workspaceId }, "Error processing message");
    } finally {
      clearTimeout(timeoutHandle);
      this.inFlightTasks.delete(taskId);
      consumerMetrics.setGauge("in_flight_tasks", this.inFlightTasks.size);
    }
  }

  private async processMessage(
    streamKey: string,
    workspaceId: string,
    streamMessageId: string,
    fields: string[]
  ): Promise<void> {
    let messageId: string | undefined;

    try {
      const messageIdIndex = fields.indexOf("messageId");
      if (messageIdIndex === -1 || messageIdIndex + 1 >= fields.length) {
        logger.error({ fields }, "Invalid message format");
        await batchAckCollector.add(streamKey, CONSUMER_GROUP, streamMessageId);
        return;
      }

      messageId = fields[messageIdIndex + 1];

      const messageData = await redis.hgetall(
        RedisKeys.message(workspaceId, messageId)
      );

      if (!messageData || Object.keys(messageData).length === 0) {
        logger.warn({ messageId }, "Message data not found in Redis");
        await batchAckCollector.add(streamKey, CONSUMER_GROUP, streamMessageId);
        return;
      }

      await deliverMessage(messageData as unknown as MessageData);

      await batchAckCollector.add(streamKey, CONSUMER_GROUP, streamMessageId);

      this.health.recordProcessed();
      logger.debug({ messageId, workspaceId }, "Message processed");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: errorMessage, streamMessageId, messageId, workspaceId }, "Error processing message");
      this.health.recordError();

      if (messageId) {
        try {
          await this.scheduleEmergencyRetry(workspaceId, messageId, errorMessage);
          await batchAckCollector.add(streamKey, CONSUMER_GROUP, streamMessageId);
        } catch (retryError) {
          logger.error({ retryError, messageId }, "Failed to schedule emergency retry, message will be recovered");
        }
      }

      captureException(error, {
        worker: "consumer",
        consumerId: this.consumerId,
        streamMessageId,
        messageId,
        workspaceId,
        context: "process_message",
      });
    }
  }

  private async scheduleEmergencyRetry(
    workspaceId: string,
    messageId: string,
    errorMessage: string
  ): Promise<void> {
    const retryTimestamp = Math.floor(Date.now() / 1000) + 30;

    const pipeline = redis.pipeline();
    pipeline.zadd(RedisKeys.processingSet(workspaceId), retryTimestamp, messageId);
    pipeline.sadd(RedisKeys.activeWorkspacesProcessing(), workspaceId);
    await execPipelineChecked(pipeline, "scheduleEmergencyRetry");

    logger.warn({ messageId, workspaceId, errorMessage }, "Scheduled emergency retry for failed message");
    consumerMetrics.increment("emergency_retries");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getStats(): ConsumerStats {
    return {
      consumerId: this.consumerId,
      isRunning: this.isRunning,
      inFlightTasks: this.inFlightTasks.size,
      concurrency: this.concurrency,
      adaptiveBlockTime: this.adaptiveBlockTime,
      pendingAcks: batchAckCollector.getPendingCount(),
      callbackQueue: callbackQueue.getStats(),
      urlCacheStats: urlValidationCache.getStats(),
      metrics: consumerMetrics.getAll(),
    };
  }
}

export interface ConsumerStats {
  consumerId: string;
  isRunning: boolean;
  inFlightTasks: number;
  concurrency: number;
  adaptiveBlockTime: number;
  pendingAcks: number;
  callbackQueue: { queued: number; inFlight: number };
  urlCacheStats: { size: number; maxSize: number };
  metrics: ReturnType<typeof consumerMetrics.getAll>;
}

export async function startConsumers(
  count: number = Number(env.CONSUMER_WORKERS) || 1,
  concurrency: number = DEFAULT_CONCURRENCY
): Promise<ConsumerWorker[]> {
  const workers: ConsumerWorker[] = [];

  for (let i = 0; i < count; i++) {
    const worker = new ConsumerWorker(i, concurrency);
    await worker.start();
    workers.push(worker);
  }

  logger.info({ count, concurrency }, "Consumer workers started");
  return workers;
}
