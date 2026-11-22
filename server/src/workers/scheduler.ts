import {
  redis,
  RedisKeys,
  batchMoveScheduledToPending,
  batchMoveQueueScheduledToPending,
  getNextScheduledTimestamp,
} from "../lib/redis.ts";
import { db } from "../db/index.ts";
import { messages } from "../db/schema/messages.ts";
import { inArray } from "drizzle-orm";
import { getTimestamp } from "../utils/time.ts";
import { createLogger } from "../lib/logger.ts";
import { env } from "../config/env.ts";
import { LeaderElection } from "../lib/distributed-lock.ts";
import { WorkerHealth } from "../lib/worker-health.ts";
import { captureException } from "../lib/sentry.ts";
import { schedulerMetrics, Timer } from "../lib/metrics.ts";
import { workspaceIndexCache, removeFromWorkspaceIndex } from "../lib/workspace-index-cache.ts";

const logger = createLogger({ module: "scheduler-worker" });

const PROMOTE_BATCH = 1000;

const MIN_POLL_INTERVAL = 100;
const MAX_POLL_INTERVAL = 30000;
const DEFAULT_POLL_INTERVAL = Number(env.SCHEDULER_POLL_INTERVAL) || 1000;
const WORKSPACE_CONCURRENCY = 10;
const DB_BATCH_SIZE = 100;

export class SchedulerWorker {
  private isRunning = false;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private leaderElection: LeaderElection;
  private health: WorkerHealth;
  private workerId: string;
  private nextPollTime = 0;

  constructor() {
    this.workerId = `scheduler-${process.pid}-${Date.now()}`;
    this.leaderElection = new LeaderElection(
      "scheduler",
      30000,
      () => this.onBecomeLeader(),
      () => this.onLoseLeadership()
    );
    this.health = new WorkerHealth("scheduler", this.workerId);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Scheduler worker already running");
      return;
    }

    this.isRunning = true;
    logger.info("Starting scheduler worker");

    await this.health.start();
    schedulerMetrics.start();

    await workspaceIndexCache.start();

    await this.leaderElection.start();
  }

  private onBecomeLeader(): void {
    logger.info("Scheduler worker became leader, starting processing");
    this.health.setLeaderStatus(true);

    this.scheduleNextPoll(0);
  }

  private onLoseLeadership(): void {
    logger.warn("Scheduler worker lost leadership, stopping processing");
    this.health.setLeaderStatus(false);

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  async stop(): Promise<void> {
    logger.info("Stopping scheduler worker");
    this.isRunning = false;

    await this.leaderElection.stop();
    await this.health.stop();
    await schedulerMetrics.stop();
    await workspaceIndexCache.stop();

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.isRunning || !this.leaderElection.isCurrentLeader()) {
      return;
    }

    this.timeoutHandle = setTimeout(async () => {
      await this.processScheduledMessages();
    }, delayMs);
  }

  private async calculateNextPollDelay(workspaceIds: string[]): Promise<number> {
    const now = getTimestamp();

    const nextTimestamp = await getNextScheduledTimestamp(workspaceIds);

    if (nextTimestamp === null) {
      return MAX_POLL_INTERVAL;
    }

    const delay = Math.max(0, (nextTimestamp - now) * 1000 - 50);

    return Math.min(MAX_POLL_INTERVAL, Math.max(MIN_POLL_INTERVAL, delay));
  }

  private async processScheduledMessages(): Promise<void> {
    if (!this.leaderElection.isCurrentLeader()) {
      return;
    }

    const processTimer = new Timer();

    try {
      const workspaceIds = await workspaceIndexCache.getWorkspaceIds("scheduled");

      if (workspaceIds.length === 0) {
        schedulerMetrics.increment("empty_polls");
        this.scheduleNextPoll(MAX_POLL_INTERVAL);
        return;
      }

      schedulerMetrics.setGauge("active_workspaces", workspaceIds.length);

      const results = await this.processWorkspacesInParallel(workspaceIds);

      const allMovedMessageIds: string[] = [];
      for (const result of results) {
        if (result.movedMessageIds.length > 0) {
          allMovedMessageIds.push(...result.movedMessageIds);
        }
      }

      if (allMovedMessageIds.length > 0) {
        await this.batchUpdateDatabase(allMovedMessageIds);
        schedulerMetrics.increment("messages_moved", allMovedMessageIds.length);
        this.health.recordProcessed();
      }

      const nextDelay = await this.calculateNextPollDelay(workspaceIds);
      processTimer.recordTo(schedulerMetrics, "process_duration_ms");

      this.scheduleNextPoll(nextDelay);
    } catch (error) {
      logger.error({ error }, "Error processing scheduled messages");
      this.health.recordError();
      schedulerMetrics.increment("errors");
      captureException(error, {
        worker: "scheduler",
        workerId: this.workerId,
        context: "process_scheduled_messages",
      });

      this.scheduleNextPoll(DEFAULT_POLL_INTERVAL);
    }
  }

  private async processWorkspacesInParallel(
    workspaceIds: string[]
  ): Promise<WorkspaceResult[]> {
    const results: WorkspaceResult[] = [];
    const pending: Promise<WorkspaceResult>[] = [];

    for (const workspaceId of workspaceIds) {
      const promise = this.processWorkspaceScheduled(workspaceId);
      pending.push(promise);

      if (pending.length >= WORKSPACE_CONCURRENCY) {
        const completed = await Promise.race(
          pending.map((p, i) => p.then((result) => ({ result, index: i })))
        );
        results.push(completed.result);
        pending.splice(completed.index, 1);
      }
    }

    const remaining = await Promise.all(pending);
    results.push(...remaining);

    return results;
  }

  private async processWorkspaceScheduled(workspaceId: string): Promise<WorkspaceResult> {
    const result: WorkspaceResult = { workspaceId, movedMessageIds: [] };

    try {
      const now = getTimestamp();
      const scheduledSetKey = RedisKeys.scheduledSet(workspaceId);

      const dueMessages = await redis.zrangebyscore(scheduledSetKey, "-inf", now, "LIMIT", 0, PROMOTE_BATCH);

      let moved = 0;
      if (dueMessages.length > 0) {
        logger.info(
          { workspaceId, count: dueMessages.length },
          "Processing scheduled messages"
        );

        const movedIds = await batchMoveScheduledToPending(workspaceId, dueMessages);
        moved = movedIds.length;

        if (moved > 0) {
          result.movedMessageIds = movedIds;
          logger.debug({ workspaceId, moved }, "Messages moved to pending");
        }
      }

      const queueMoved = await this.processQueueScheduled(workspaceId, now, result);

      if (moved > 0 || queueMoved > 0) {
        const remaining = await this.countRemainingScheduled(workspaceId);
        if (remaining === 0) {
          await removeFromWorkspaceIndex("scheduled", workspaceId);
        }
      }
    } catch (error) {
      logger.error({ workspaceId, error }, "Error processing workspace scheduled messages");
      schedulerMetrics.increment("workspace_errors");
      captureException(error, {
        worker: "scheduler",
        workerId: this.workerId,
        workspaceId,
        context: "process_workspace_scheduled",
      });
    }

    return result;
  }

  private async processQueueScheduled(
    workspaceId: string,
    now: number,
    result: WorkspaceResult
  ): Promise<number> {
    const queueIds = await redis.smembers(RedisKeys.activeQueues(workspaceId));
    if (queueIds.length === 0) return 0;

    let totalMoved = 0;
    for (const queueId of queueIds) {
      const due = await redis.zrangebyscore(
        RedisKeys.queueScheduledSet(workspaceId, queueId),
        "-inf",
        now,
        "LIMIT",
        0,
        PROMOTE_BATCH,
      );
      if (due.length === 0) continue;

      const movedIds = await batchMoveQueueScheduledToPending(workspaceId, queueId, due);
      if (movedIds.length > 0) {
        result.movedMessageIds.push(...movedIds);
        totalMoved += movedIds.length;
        logger.debug(
          { workspaceId, queueId, moved: movedIds.length },
          "Queue messages moved to pending"
        );
      }
    }
    return totalMoved;
  }

  private async countRemainingScheduled(workspaceId: string): Promise<number> {
    const queueIds = await redis.smembers(RedisKeys.activeQueues(workspaceId));
    const pipeline = redis.pipeline();
    pipeline.zcard(RedisKeys.scheduledSet(workspaceId));
    for (const queueId of queueIds) {
      pipeline.zcard(RedisKeys.queueScheduledSet(workspaceId, queueId));
    }
    const results = await pipeline.exec();
    if (!results) return 1;

    let total = 0;
    for (const [err, count] of results) {
      if (!err) total += Number(count) || 0;
    }
    return total;
  }

  private async batchUpdateDatabase(messageIds: string[]): Promise<void> {
    const dbTimer = new Timer();

    try {
      const batches: string[][] = [];
      for (let i = 0; i < messageIds.length; i += DB_BATCH_SIZE) {
        batches.push(messageIds.slice(i, i + DB_BATCH_SIZE));
      }

      const failedMessageIds: string[] = [];

      const MAX_PARALLEL_DB_BATCHES = 5;
      for (let i = 0; i < batches.length; i += MAX_PARALLEL_DB_BATCHES) {
        const parallelBatches = batches.slice(i, i + MAX_PARALLEL_DB_BATCHES);
        const results = await Promise.allSettled(
          parallelBatches.map((batch) =>
            db
              .update(messages)
              .set({ status: "pending" })
              .where(inArray(messages.messageId, batch))
              .then(() => batch)
          )
        );

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status === "rejected") {
            failedMessageIds.push(...parallelBatches[j]);
            logger.error(
              { error: result.reason, batch: parallelBatches[j] },
              "Database batch update failed for batch"
            );
          }
        }
      }

      if (failedMessageIds.length > 0) {
        await this.recordInconsistentMessages(failedMessageIds);
        schedulerMetrics.increment("db_update_partial_failures");
        logger.warn(
          { failedCount: failedMessageIds.length, totalCount: messageIds.length },
          "Some messages failed DB update, recorded for reconciliation"
        );
      }

      dbTimer.recordTo(schedulerMetrics, "db_update_duration_ms");
      logger.debug({ count: messageIds.length, batches: batches.length }, "Database batch update completed");
    } catch (error) {
      logger.error({ error, count: messageIds.length }, "Database batch update failed completely");
      await this.recordInconsistentMessages(messageIds);
      schedulerMetrics.increment("db_update_complete_failures");
      throw error;
    }
  }

  private async recordInconsistentMessages(messageIds: string[]): Promise<void> {
    try {
      const key = "reconciliation:pending_messages";
      const timestamp = Date.now();

      const pipeline = redis.pipeline();
      for (const messageId of messageIds) {
        pipeline.zadd(key, timestamp, messageId);
      }
      pipeline.expire(key, 86400);
      await pipeline.exec();

      logger.info({ count: messageIds.length }, "Recorded inconsistent messages for reconciliation");
    } catch (error) {
      logger.error({ error, messageIds }, "Failed to record inconsistent messages");
    }
  }

  getStats(): SchedulerStats {
    return {
      workerId: this.workerId,
      isRunning: this.isRunning,
      isLeader: this.leaderElection.isCurrentLeader(),
      nextPollTime: this.nextPollTime,
      metrics: schedulerMetrics.getAll(),
    };
  }
}

interface WorkspaceResult {
  workspaceId: string;
  movedMessageIds: string[];
}

export interface SchedulerStats {
  workerId: string;
  isRunning: boolean;
  isLeader: boolean;
  nextPollTime: number;
  metrics: ReturnType<typeof schedulerMetrics.getAll>;
}

export const schedulerWorker = new SchedulerWorker();
