import { redis, RedisKeys } from "../lib/redis.ts";
import { createLogger } from "../lib/logger.ts";
import { LeaderElection } from "../lib/distributed-lock.ts";
import { WorkerHealth } from "../lib/worker-health.ts";
import { captureException } from "../lib/sentry.ts";
import { Metrics, Timer } from "../lib/metrics.ts";
import { workspaceIndexCache } from "../lib/workspace-index-cache.ts";
import { MAX_RECOVERY_DELIVERIES, nextRecoveryAttempt } from "./recovery-attempts.ts";

const logger = createLogger({ module: "recovery-worker" });

const CONSUMER_GROUP = "consumers";
const STALE_MESSAGE_THRESHOLD_MS = 5 * 60 * 1000;
const POLL_INTERVAL = 60000;
const MAX_MESSAGES_PER_CLAIM = 100;
const WORKSPACE_CONCURRENCY = 5;
const TRIM_LIMIT_PER_POLL = 10_000;

export const recoveryMetrics = new Metrics("recovery");

type XPendingResult = [string, string, number, number][];

function compareStreamIds(a: string, b: string): number {
  const [aMs, aSeq] = a.split("-").map(Number);
  const [bMs, bSeq] = b.split("-").map(Number);
  return aMs !== bMs ? aMs - bMs : (aSeq ?? 0) - (bSeq ?? 0);
}

interface PendingMessage {
  messageId: string;
  consumerId: string;
  idleTime: number;
  deliveryCount: number;
}

export class RecoveryWorker {
  private isRunning = false;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private leaderElection: LeaderElection;
  private health: WorkerHealth;
  private workerId: string;
  private recoveryConsumerId: string;

  constructor() {
    this.workerId = `recovery-${process.pid}-${Date.now()}`;
    this.recoveryConsumerId = `recovery-consumer-${process.pid}`;
    this.leaderElection = new LeaderElection(
      "recovery",
      30000,
      () => this.onBecomeLeader(),
      () => this.onLoseLeadership()
    );
    this.health = new WorkerHealth("recovery", this.workerId);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Recovery worker already running");
      return;
    }

    this.isRunning = true;
    logger.info("Starting recovery worker");

    await this.health.start();
    recoveryMetrics.start();
    await workspaceIndexCache.start();
    await this.leaderElection.start();
  }

  private onBecomeLeader(): void {
    logger.info("Recovery worker became leader, starting processing");
    this.health.setLeaderStatus(true);
    this.scheduleNextPoll(0);
  }

  private onLoseLeadership(): void {
    logger.warn("Recovery worker lost leadership, stopping processing");
    this.health.setLeaderStatus(false);

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  async stop(): Promise<void> {
    logger.info("Stopping recovery worker");
    this.isRunning = false;

    await this.leaderElection.stop();
    await this.health.stop();
    await recoveryMetrics.stop();
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
      await this.recoverStaleMessages();
    }, delayMs);
  }

  private async recoverStaleMessages(): Promise<void> {
    if (!this.leaderElection.isCurrentLeader()) {
      return;
    }

    const processTimer = new Timer();

    try {
      const workspaceIds = await workspaceIndexCache.getWorkspaceIds("pending");

      if (workspaceIds.length === 0) {
        recoveryMetrics.increment("empty_polls");
        this.scheduleNextPoll(POLL_INTERVAL);
        return;
      }

      recoveryMetrics.setGauge("active_workspaces", workspaceIds.length);

      const results = await this.processWorkspacesInParallel(workspaceIds);
      results.push(...(await this.recoverQueueStreams()));

      let totalRecovered = 0;
      let totalStale = 0;
      for (const result of results) {
        totalRecovered += result.recoveredCount;
        totalStale += result.staleCount;
      }

      if (totalStale > 0) {
        recoveryMetrics.setGauge("stale_messages", totalStale);
        logger.info({ totalStale, totalRecovered }, "Recovery scan completed");
      }

      if (totalRecovered > 0) {
        recoveryMetrics.increment("messages_recovered", totalRecovered);
        this.health.recordProcessed();
      }

      processTimer.recordTo(recoveryMetrics, "process_duration_ms");
      this.scheduleNextPoll(POLL_INTERVAL);
    } catch (error) {
      logger.error({ error }, "Error recovering stale messages");
      this.health.recordError();
      recoveryMetrics.increment("errors");
      captureException(error, {
        worker: "recovery",
        workerId: this.workerId,
        context: "recover_stale_messages",
      });

      this.scheduleNextPoll(POLL_INTERVAL);
    }
  }

  private async processWorkspacesInParallel(
    workspaceIds: string[]
  ): Promise<WorkspaceResult[]> {
    const results: WorkspaceResult[] = [];
    const pending: Promise<WorkspaceResult>[] = [];

    for (const workspaceId of workspaceIds) {
      const promise = this.recoverWorkspaceMessages(workspaceId);
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

  private async recoverQueueStreams(): Promise<WorkspaceResult[]> {
    const pairs = await redis.smembers(RedisKeys.activeQueuesPending()).catch(() => [] as string[]);
    const results: WorkspaceResult[] = [];
    for (const pair of pairs) {
      const [workspaceId, queueId] = pair.split(":");
      if (!workspaceId || !queueId) continue;
      results.push(await this.recoverWorkspaceMessages(workspaceId, RedisKeys.queuePendingStream(workspaceId, queueId)));
    }
    return results;
  }

  private async recoverWorkspaceMessages(workspaceId: string, stream?: string): Promise<WorkspaceResult> {
    const result: WorkspaceResult = { workspaceId, staleCount: 0, recoveredCount: 0 };

    try {
      const streamKey = stream ?? RedisKeys.pendingStream(workspaceId);

      await this.trimDeliveredEntries(streamKey).catch((error) =>
        logger.warn({ workspaceId, error }, "Could not trim delivered stream entries"),
      );

      const pendingInfo = await this.getStaleMessages(streamKey);

      if (pendingInfo.length === 0) {
        return result;
      }

      result.staleCount = pendingInfo.length;
      logger.info(
        { workspaceId, staleCount: pendingInfo.length },
        "Found stale messages"
      );

      for (const pending of pendingInfo) {
        try {
          const claimed = await this.claimAndRequeue(streamKey, workspaceId, pending);
          if (claimed) {
            result.recoveredCount++;
          }
        } catch (error) {
          logger.error(
            { workspaceId, messageId: pending.messageId, error },
            "Error claiming message"
          );
        }
      }

      if (result.recoveredCount > 0) {
        logger.info(
          { workspaceId, recovered: result.recoveredCount },
          "Messages recovered"
        );
      }
    } catch (error) {
      logger.error({ workspaceId, error }, "Error recovering workspace messages");
      recoveryMetrics.increment("workspace_errors");
      captureException(error, {
        worker: "recovery",
        workerId: this.workerId,
        workspaceId,
        context: "recover_workspace_messages",
      });
    }

    return result;
  }

  private async trimDeliveredEntries(streamKey: string): Promise<void> {
    const groups = (await redis.xinfo("GROUPS", streamKey).catch(() => null)) as unknown[] | null;
    if (!groups) return;
    let lastDelivered: string | null = null;
    let oldestPending: string | null = null;
    for (const group of groups) {
      const fields = group as unknown[];
      const entries = new Map<string, unknown>();
      for (let i = 0; i + 1 < fields.length; i += 2) entries.set(String(fields[i]), fields[i + 1]);
      if (entries.get("name") !== CONSUMER_GROUP) continue;
      lastDelivered = String(entries.get("last-delivered-id") ?? "");
      const pending = Number(entries.get("pending") ?? 0);
      if (pending > 0) {
        const summary = (await redis.xpending(streamKey, CONSUMER_GROUP)) as unknown[];
        if (Array.isArray(summary) && summary[1]) oldestPending = String(summary[1]);
      }
    }
    if (!lastDelivered || lastDelivered === "0-0") return;
    const minId = oldestPending && compareStreamIds(oldestPending, lastDelivered) < 0 ? oldestPending : lastDelivered;
    await redis.xtrim(streamKey, "MINID", "~", minId, "LIMIT", TRIM_LIMIT_PER_POLL);
  }

  private async getStaleMessages(streamKey: string): Promise<PendingMessage[]> {
    try {
      const summary = await redis.xpending(streamKey, CONSUMER_GROUP) as any[];

      if (!summary || summary[0] === 0) {
        return [];
      }

      const detailed = await redis.xpending(
        streamKey,
        CONSUMER_GROUP,
        "IDLE",
        STALE_MESSAGE_THRESHOLD_MS,
        "-",
        "+",
        MAX_MESSAGES_PER_CLAIM
      ) as XPendingResult;

      if (!detailed || detailed.length === 0) {
        return [];
      }

      return detailed.map(([messageId, consumerId, idleTime, deliveryCount]) => ({
        messageId,
        consumerId,
        idleTime,
        deliveryCount,
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("NOGROUP")) {
        return [];
      }
      throw error;
    }
  }

  private async claimAndRequeue(
    streamKey: string,
    workspaceId: string,
    pending: PendingMessage
  ): Promise<boolean> {
    try {
      const claimed = await redis.xclaim(
        streamKey,
        CONSUMER_GROUP,
        this.recoveryConsumerId,
        STALE_MESSAGE_THRESHOLD_MS,
        pending.messageId
      ) as any[];

      if (!claimed || claimed.length === 0) {
        return false;
      }

      const claimedFields = (claimed[0]?.[1] ?? []) as string[];
      const { totalDeliveries, requeueFields } = nextRecoveryAttempt(claimedFields, pending.deliveryCount);

      if (totalDeliveries >= MAX_RECOVERY_DELIVERIES) {
        logger.warn(
          { workspaceId, messageId: pending.messageId, deliveryCount: pending.deliveryCount, totalDeliveries },
          "Message exceeded max redeliveries, moving to DLQ"
        );

        const claimedMessage = claimed[0];
        if (claimedMessage && claimedMessage[1]) {
          const fields = claimedMessage[1] as string[];
          const messageIdIndex = fields.indexOf("messageId");
          if (messageIdIndex !== -1 && messageIdIndex + 1 < fields.length) {
            const actualMessageId = fields[messageIdIndex + 1];

            const pipeline = redis.pipeline();
            pipeline.zadd(RedisKeys.dlqSet(workspaceId), Date.now(), actualMessageId);
            pipeline.xack(streamKey, CONSUMER_GROUP, pending.messageId);
            await pipeline.exec();

            recoveryMetrics.increment("messages_to_dlq");
            return true;
          }
        }

        await redis.xack(streamKey, CONSUMER_GROUP, pending.messageId);
        return true;
      }

      const claimedMessage = claimed[0];
      if (claimedMessage && claimedMessage[1]) {
        await redis.xadd(streamKey, "*", ...requeueFields);

        await redis.xack(streamKey, CONSUMER_GROUP, pending.messageId);

        logger.debug(
          { workspaceId, messageId: pending.messageId, deliveryCount: pending.deliveryCount, totalDeliveries },
          "Message recovered and requeued"
        );

        return true;
      }

      return false;
    } catch (error) {
      logger.error(
        { streamKey, messageId: pending.messageId, error },
        "Failed to claim message"
      );
      return false;
    }
  }

  getStats(): RecoveryStats {
    return {
      workerId: this.workerId,
      isRunning: this.isRunning,
      isLeader: this.leaderElection.isCurrentLeader(),
      metrics: recoveryMetrics.getAll(),
    };
  }
}

interface WorkspaceResult {
  workspaceId: string;
  staleCount: number;
  recoveredCount: number;
}

export interface RecoveryStats {
  workerId: string;
  isRunning: boolean;
  isLeader: boolean;
  metrics: ReturnType<typeof recoveryMetrics.getAll>;
}
