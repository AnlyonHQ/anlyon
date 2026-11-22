import { redis, RedisKeys, batchMoveProcessingToPending, getNextRetryTimestamp } from "../lib/redis.ts";
import { getTimestamp } from "../utils/time.ts";
import { createLogger } from "../lib/logger.ts";
import { LeaderElection } from "../lib/distributed-lock.ts";
import { WorkerHealth } from "../lib/worker-health.ts";
import { captureException } from "../lib/sentry.ts";
import { retryMetrics, Timer } from "../lib/metrics.ts";
import { workspaceIndexCache, removeFromWorkspaceIndex } from "../lib/workspace-index-cache.ts";

const logger = createLogger({ module: "retry-worker" });

const MIN_POLL_INTERVAL = 100;
const MAX_POLL_INTERVAL = 30000;
const DEFAULT_POLL_INTERVAL = 1000;
const WORKSPACE_CONCURRENCY = 10;

export class RetryWorker {
  private isRunning = false;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private leaderElection: LeaderElection;
  private health: WorkerHealth;
  private workerId: string;

  constructor() {
    this.workerId = `retry-${process.pid}-${Date.now()}`;
    this.leaderElection = new LeaderElection(
      "retry",
      30000,
      () => this.onBecomeLeader(),
      () => this.onLoseLeadership()
    );
    this.health = new WorkerHealth("retry", this.workerId);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Retry worker already running");
      return;
    }

    this.isRunning = true;
    logger.info("Starting retry worker");

    await this.health.start();
    retryMetrics.start();

    await workspaceIndexCache.start();

    await this.leaderElection.start();
  }

  private onBecomeLeader(): void {
    logger.info("Retry worker became leader, starting processing");
    this.health.setLeaderStatus(true);

    this.scheduleNextPoll(0);
  }

  private onLoseLeadership(): void {
    logger.warn("Retry worker lost leadership, stopping processing");
    this.health.setLeaderStatus(false);

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  async stop(): Promise<void> {
    logger.info("Stopping retry worker");
    this.isRunning = false;

    await this.leaderElection.stop();
    await this.health.stop();
    await retryMetrics.stop();
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
      await this.processRetries();
    }, delayMs);
  }

  private async calculateNextPollDelay(workspaceIds: string[]): Promise<number> {
    const now = getTimestamp();

    const nextTimestamp = await getNextRetryTimestamp(workspaceIds);

    if (nextTimestamp === null) {
      return MAX_POLL_INTERVAL;
    }

    const delay = Math.max(0, (nextTimestamp - now) * 1000 - 50);

    return Math.min(MAX_POLL_INTERVAL, Math.max(MIN_POLL_INTERVAL, delay));
  }

  private async processRetries(): Promise<void> {
    if (!this.leaderElection.isCurrentLeader()) {
      return;
    }

    const processTimer = new Timer();

    try {
      const workspaceIds = await workspaceIndexCache.getWorkspaceIds("processing");

      if (workspaceIds.length === 0) {
        retryMetrics.increment("empty_polls");
        this.scheduleNextPoll(MAX_POLL_INTERVAL);
        return;
      }

      retryMetrics.setGauge("active_workspaces", workspaceIds.length);

      const results = await this.processWorkspacesInParallel(workspaceIds);

      let totalMoved = 0;
      for (const result of results) {
        totalMoved += result.movedCount;
      }

      if (totalMoved > 0) {
        retryMetrics.increment("messages_retried", totalMoved);
        this.health.recordProcessed();
      }

      const nextDelay = await this.calculateNextPollDelay(workspaceIds);
      processTimer.recordTo(retryMetrics, "process_duration_ms");

      this.scheduleNextPoll(nextDelay);
    } catch (error) {
      logger.error({ error }, "Error processing retries");
      this.health.recordError();
      retryMetrics.increment("errors");
      captureException(error, {
        worker: "retry",
        workerId: this.workerId,
        context: "process_retries",
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
      const promise = this.processWorkspaceRetries(workspaceId);
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

  private async processWorkspaceRetries(workspaceId: string): Promise<WorkspaceResult> {
    const result: WorkspaceResult = { workspaceId, movedCount: 0 };

    try {
      const now = getTimestamp();
      const processingSetKey = RedisKeys.processingSet(workspaceId);

      const dueMessages = await redis.zrangebyscore(processingSetKey, "-inf", now, "LIMIT", 0, 1000);

      if (dueMessages.length === 0) {
        const remaining = await redis.zcard(processingSetKey);
        if (remaining === 0) {
          await removeFromWorkspaceIndex("processing", workspaceId);
        }
        return result;
      }

      logger.info(
        { workspaceId, count: dueMessages.length },
        "Processing retries"
      );

      const movedIds = await batchMoveProcessingToPending(workspaceId, dueMessages);

      if (movedIds.length > 0) {
        result.movedCount = movedIds.length;
        logger.debug({ workspaceId, moved: movedIds.length }, "Messages moved for retry");
      }

      const remaining = await redis.zcard(processingSetKey);
      if (remaining === 0) {
        await removeFromWorkspaceIndex("processing", workspaceId);
      }
    } catch (error) {
      logger.error({ workspaceId, error }, "Error processing workspace retries");
      retryMetrics.increment("workspace_errors");
      captureException(error, {
        worker: "retry",
        workerId: this.workerId,
        workspaceId,
        context: "process_workspace_retries",
      });
    }

    return result;
  }

  getStats(): RetryStats {
    return {
      workerId: this.workerId,
      isRunning: this.isRunning,
      isLeader: this.leaderElection.isCurrentLeader(),
      metrics: retryMetrics.getAll(),
    };
  }
}

interface WorkspaceResult {
  workspaceId: string;
  movedCount: number;
}

export interface RetryStats {
  workerId: string;
  isRunning: boolean;
  isLeader: boolean;
  metrics: ReturnType<typeof retryMetrics.getAll>;
}

export const retryWorker = new RetryWorker();
