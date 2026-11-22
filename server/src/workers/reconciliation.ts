import { redis, RedisKeys } from "../lib/redis.ts";
import { db } from "../db/index.ts";
import { messages } from "../db/schema/messages.ts";
import { eq, inArray, and, or } from "drizzle-orm";
import { createLogger } from "../lib/logger.ts";
import { LeaderElection } from "../lib/distributed-lock.ts";
import { WorkerHealth } from "../lib/worker-health.ts";
import { captureException } from "../lib/sentry.ts";
import { Metrics, Timer } from "../lib/metrics.ts";
import { drainMessageOutbox } from "../core/messaging/enqueue-outbox.ts";

const logger = createLogger({ module: "reconciliation-worker" });

const POLL_INTERVAL = 60000;
const BATCH_SIZE = 100;
const MAX_RECONCILIATION_AGE_MS = 5 * 60 * 1000;

export const reconciliationMetrics = new Metrics("reconciliation");

export class ReconciliationWorker {
  private isRunning = false;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private leaderElection: LeaderElection;
  private health: WorkerHealth;
  private workerId: string;

  constructor() {
    this.workerId = `reconciliation-${process.pid}-${Date.now()}`;
    this.leaderElection = new LeaderElection(
      "reconciliation",
      30000,
      () => this.onBecomeLeader(),
      () => this.onLoseLeadership()
    );
    this.health = new WorkerHealth("reconciliation", this.workerId);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Reconciliation worker already running");
      return;
    }

    this.isRunning = true;
    logger.info("Starting reconciliation worker");

    await this.health.start();
    reconciliationMetrics.start();
    await this.leaderElection.start();
  }

  private onBecomeLeader(): void {
    logger.info("Reconciliation worker became leader, starting processing");
    this.health.setLeaderStatus(true);
    this.scheduleNextPoll(0);
  }

  private onLoseLeadership(): void {
    logger.warn("Reconciliation worker lost leadership, stopping processing");
    this.health.setLeaderStatus(false);

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  async stop(): Promise<void> {
    logger.info("Stopping reconciliation worker");
    this.isRunning = false;

    await this.leaderElection.stop();
    await this.health.stop();
    await reconciliationMetrics.stop();

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
      await this.runReconciliation();
    }, delayMs);
  }

  private async runReconciliation(): Promise<void> {
    if (!this.leaderElection.isCurrentLeader()) {
      return;
    }

    const processTimer = new Timer();

    try {
      await drainMessageOutbox();
      await this.reconcilePendingMessages();

      if (Math.random() < 0.1) {
        await this.checkStatusMismatches();
      }

      processTimer.recordTo(reconciliationMetrics, "process_duration_ms");
      this.scheduleNextPoll(POLL_INTERVAL);
    } catch (error) {
      logger.error({ error }, "Error during reconciliation");
      this.health.recordError();
      reconciliationMetrics.increment("errors");
      captureException(error, {
        worker: "reconciliation",
        workerId: this.workerId,
        context: "run_reconciliation",
      });

      this.scheduleNextPoll(POLL_INTERVAL);
    }
  }

  private async reconcilePendingMessages(): Promise<void> {
    try {
      const key = "reconciliation:pending_messages";
      const maxAge = Date.now() - MAX_RECONCILIATION_AGE_MS;

      const messageIds = await redis.zrangebyscore(key, "-inf", maxAge, "LIMIT", 0, BATCH_SIZE);

      if (messageIds.length === 0) {
        return;
      }

      logger.info({ count: messageIds.length }, "Reconciling pending messages");

      const dbMessages = await db
        .select({ messageId: messages.messageId, status: messages.status, workspaceId: messages.workspaceId })
        .from(messages)
        .where(inArray(messages.messageId, messageIds));

      const dbMessageMap = new Map(dbMessages.map((m) => [m.messageId, m]));

      let reconciled = 0;
      let failed = 0;

      for (const messageId of messageIds) {
        try {
          const dbMessage = dbMessageMap.get(messageId);

          if (!dbMessage) {
            logger.warn({ messageId }, "Message not found in DB during reconciliation");
            failed++;
            continue;
          }

          const redisMessageKey = RedisKeys.message(dbMessage.workspaceId, messageId);
          const redisData = await redis.exists(redisMessageKey);

          if (redisData === 0) {
            if (dbMessage.status === "scheduled") {
              await db
                .update(messages)
                .set({ status: "pending" })
                .where(eq(messages.messageId, messageId));
              logger.debug({ messageId }, "Updated DB status to pending");
              reconciled++;
            }
          } else {
            if (dbMessage.status === "scheduled") {
              await db
                .update(messages)
                .set({ status: "pending" })
                .where(eq(messages.messageId, messageId));
              logger.debug({ messageId }, "Synced DB status with Redis");
              reconciled++;
            }
          }
        } catch (error) {
          logger.error({ messageId, error }, "Error reconciling message");
          failed++;
        }
      }

      if (messageIds.length > 0) {
        await redis.zrem(key, ...messageIds);
      }

      if (reconciled > 0 || failed > 0) {
        logger.info({ reconciled, failed }, "Reconciliation batch completed");
        reconciliationMetrics.increment("messages_reconciled", reconciled);
        reconciliationMetrics.increment("messages_failed", failed);
        this.health.recordProcessed();
      }
    } catch (error) {
      logger.error({ error }, "Error in reconcilePendingMessages");
      throw error;
    }
  }

  private async checkStatusMismatches(): Promise<void> {
    try {
      const pendingWorkspaces = await redis.smembers(RedisKeys.activeWorkspacesPending());

      if (pendingWorkspaces.length === 0) {
        return;
      }

      const sampleSize = Math.min(5, pendingWorkspaces.length);
      const sampledWorkspaces = pendingWorkspaces
        .sort(() => Math.random() - 0.5)
        .slice(0, sampleSize);

      let mismatches = 0;

      for (const workspaceId of sampledWorkspaces) {
        try {
          const streamKey = RedisKeys.pendingStream(workspaceId);
          const streamLength = await redis.xlen(streamKey);

          if (streamLength === 0) {
            await redis.srem(RedisKeys.activeWorkspacesPending(), workspaceId);
            continue;
          }

          const streamMessages = await redis.xrange(streamKey, "-", "+", "COUNT", 10);

          if (!streamMessages || streamMessages.length === 0) {
            continue;
          }

          const messageIds: string[] = [];
          for (const [, fields] of streamMessages) {
            const messageIdIndex = fields.indexOf("messageId");
            if (messageIdIndex !== -1 && messageIdIndex + 1 < fields.length) {
              messageIds.push(fields[messageIdIndex + 1]);
            }
          }

          if (messageIds.length === 0) {
            continue;
          }

          const dbMessages = await db
            .select({ messageId: messages.messageId, status: messages.status })
            .from(messages)
            .where(
              and(
                eq(messages.workspaceId, workspaceId),
                inArray(messages.messageId, messageIds)
              )
            );

          for (const dbMessage of dbMessages) {
            if (dbMessage.status === "scheduled") {
              mismatches++;
              await db
                .update(messages)
                .set({ status: "pending" })
                .where(eq(messages.messageId, dbMessage.messageId));
              logger.warn(
                { messageId: dbMessage.messageId, workspaceId },
                "Fixed status mismatch: scheduled -> pending"
              );
            }
          }
        } catch (error) {
          logger.error({ workspaceId, error }, "Error checking workspace for mismatches");
        }
      }

      if (mismatches > 0) {
        reconciliationMetrics.increment("status_mismatches_fixed", mismatches);
        logger.info({ mismatches }, "Fixed status mismatches");
      }
    } catch (error) {
      logger.error({ error }, "Error in checkStatusMismatches");
    }
  }

  getStats(): ReconciliationStats {
    return {
      workerId: this.workerId,
      isRunning: this.isRunning,
      isLeader: this.leaderElection.isCurrentLeader(),
      metrics: reconciliationMetrics.getAll(),
    };
  }
}

export interface ReconciliationStats {
  workerId: string;
  isRunning: boolean;
  isLeader: boolean;
  metrics: ReturnType<typeof reconciliationMetrics.getAll>;
}
