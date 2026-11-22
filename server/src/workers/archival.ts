import { createLogger } from "../lib/logger.ts";
import { LeaderElection } from "../lib/distributed-lock.ts";
import { WorkerHealth } from "../lib/worker-health.ts";
import { captureException } from "../lib/sentry.ts";
import { MetricsCollector, Timer } from "../lib/metrics.ts";
import { env } from "../config/env.ts";
import { isR2Configured } from "../lib/r2-client.ts";
import {
  ensurePartitionsExist,
  getExpiredPartitions,
  dropPartition,
  getPartitionRecordCount,
  getPartitionWorkspaceIds,
  createArchivalTrackingEntry,
  updateArchivalTrackingStatus,
  getArchivalTrackingEntry,
  getPartitionsReadyForDrop,
  partitionExists,
  type PartitionInfo,
  type LogType,
} from "../core/archival/partition-manager.ts";
import { exportPartition } from "../core/archival/export-service.ts";
import { verifyManifestFiles } from "../core/archival/r2-storage.ts";

const logger = createLogger({ module: "archival-worker" });

const POLL_INTERVAL_MS = 60000;
const MAX_RETRIES = 3;

export const archivalMetrics = new MetricsCollector("archival");

export class ArchivalWorker {
  private isRunning = false;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private leaderElection: LeaderElection;
  private health: WorkerHealth;
  private workerId: string;
  private lastArchivalDate: string | null = null;

  constructor() {
    this.workerId = `archival-${process.pid}-${Date.now()}`;
    this.leaderElection = new LeaderElection(
      "archival",
      30000,
      () => this.onBecomeLeader(),
      () => this.onLoseLeadership()
    );
    this.health = new WorkerHealth("archival", this.workerId);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Archival worker already running");
      return;
    }

    if (!isR2Configured()) {
      logger.warn("R2 not configured, archival worker will not start");
      return;
    }

    this.isRunning = true;
    logger.info("Starting archival worker");

    await this.health.start();
    archivalMetrics.start();
    await this.leaderElection.start();
  }

  private onBecomeLeader(): void {
    logger.info("Archival worker became leader, starting processing");
    this.health.setLeaderStatus(true);
    this.scheduleNextPoll(0);
  }

  private onLoseLeadership(): void {
    logger.warn("Archival worker lost leadership, stopping processing");
    this.health.setLeaderStatus(false);

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  async stop(): Promise<void> {
    logger.info("Stopping archival worker");
    this.isRunning = false;

    await this.leaderElection.stop();
    await this.health.stop();
    await archivalMetrics.stop();

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
      await this.checkAndRunArchival();
    }, delayMs);
  }

  private async checkAndRunArchival(): Promise<void> {
    if (!this.leaderElection.isCurrentLeader()) {
      return;
    }

    const processTimer = new Timer();

    try {
      const now = new Date();
      const currentHour = now.getUTCHours();
      const today = now.toISOString().split("T")[0];

      const shouldRunArchival =
        currentHour === env.LOG_ARCHIVAL_HOUR_UTC &&
        this.lastArchivalDate !== today;

      if (shouldRunArchival) {
        logger.info({ hour: currentHour }, "Starting daily archival run");
        await this.runArchival();
        this.lastArchivalDate = today;
        archivalMetrics.increment("archival_runs");
      }

      await this.ensureFuturePartitions();

      processTimer.recordTo(archivalMetrics, "check_duration_ms");
      this.scheduleNextPoll(POLL_INTERVAL_MS);
    } catch (error) {
      logger.error({ error }, "Error in archival check");
      this.health.recordError();
      archivalMetrics.increment("errors");
      captureException(error, {
        worker: "archival",
        workerId: this.workerId,
        context: "check_and_run_archival",
      });

      this.scheduleNextPoll(POLL_INTERVAL_MS);
    }
  }

  private async runArchival(): Promise<void> {
    const archivalTimer = new Timer();

    try {
      const expiredPartitions = await getExpiredPartitions();

      if (expiredPartitions.length === 0) {
        logger.info("No expired partitions to archive");
        return;
      }

      logger.info({ count: expiredPartitions.length }, "Found expired partitions");
      archivalMetrics.setGauge("expired_partitions", expiredPartitions.length);

      for (const partition of expiredPartitions) {
        await this.archivePartition(partition);
      }

      await this.dropArchivedPartitions();

      archivalTimer.recordTo(archivalMetrics, "archival_duration_ms");
      this.health.recordProcessed();

      logger.info("Daily archival run completed");
    } catch (error) {
      logger.error({ error }, "Error in archival run");
      throw error;
    }
  }

  private async archivePartition(partition: PartitionInfo): Promise<void> {
    const { partitionName, partitionDate, logType } = partition;

    try {
      let tracking = await getArchivalTrackingEntry(partitionName, logType);

      if (tracking?.status === "archived" || tracking?.status === "dropped") {
        logger.debug({ partitionName }, "Partition already archived/dropped");
        return;
      }

      if (tracking?.status === "failed" && (tracking.retryCount ?? 0) >= MAX_RETRIES) {
        logger.warn({ partitionName, retryCount: tracking.retryCount }, "Partition failed too many times, skipping");
        return;
      }

      const totalRecords = await getPartitionRecordCount(partitionName);
      const workspaceIds = await getPartitionWorkspaceIds(partitionName);

      if (totalRecords === 0) {
        logger.info({ partitionName }, "Partition is empty, marking as archived");
        await createArchivalTrackingEntry(partition, 0);
        await updateArchivalTrackingStatus(partitionName, logType, "archived", {
          archivalCompletedAt: new Date(),
        });
        return;
      }

      if (!tracking) {
        await createArchivalTrackingEntry(partition, totalRecords);
        tracking = await getArchivalTrackingEntry(partitionName, logType);
      }

      await updateArchivalTrackingStatus(partitionName, logType, "archiving", {
        archivalStartedAt: new Date(),
        retryCount: (tracking?.retryCount ?? 0) + 1,
      });

      logger.info(
        { partitionName, totalRecords, workspaces: workspaceIds.length },
        "Starting partition archival"
      );

      const exportResult = await exportPartition(
        partitionName,
        logType,
        partitionDate,
        workspaceIds
      );

      if (exportResult.failedWorkspaces.length > 0) {
        throw new Error(
          `Failed to export ${exportResult.failedWorkspaces.length} workspaces: ${exportResult.failedWorkspaces.join(", ")}`
        );
      }

      await updateArchivalTrackingStatus(partitionName, logType, "archived", {
        archivedRecords: exportResult.totalExported,
        r2ManifestKeys: exportResult.manifestKeys,
        archivalCompletedAt: new Date(),
      });

      archivalMetrics.increment("partitions_archived");
      archivalMetrics.increment("records_archived", exportResult.totalExported);

      logger.info(
        { partitionName, totalExported: exportResult.totalExported, manifests: exportResult.manifestKeys.length },
        "Partition archival completed"
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await updateArchivalTrackingStatus(partitionName, logType, "failed", {
        lastError: errorMessage,
      });

      archivalMetrics.increment("partition_failures");
      logger.error({ partitionName, error: errorMessage }, "Failed to archive partition");

      captureException(error, {
        worker: "archival",
        workerId: this.workerId,
        partitionName,
        context: "archive_partition",
      });
    }
  }

  private async dropArchivedPartitions(): Promise<void> {
    const readyForDrop = await getPartitionsReadyForDrop();

    for (const partition of readyForDrop) {
      const { partitionName, logType, partitionDate } = partition;

      try {
        const exists = await partitionExists(partitionName);
        if (!exists) {
          logger.info({ partitionName }, "Partition already dropped");
          await updateArchivalTrackingStatus(partitionName, logType, "dropped", {
            partitionDroppedAt: new Date(),
          });
          continue;
        }

        const workspaceIds = await getPartitionWorkspaceIds(partitionName);

        let allVerified = true;
        for (const workspaceId of workspaceIds) {
          const verification = await verifyManifestFiles(workspaceId, logType, partitionDate);
          if (!verification.valid) {
            logger.warn(
              { partitionName, workspaceId, missingFiles: verification.missingFiles },
              "Workspace archive verification failed"
            );
            allVerified = false;
            break;
          }
        }

        if (!allVerified) {
          logger.warn({ partitionName }, "Skipping drop due to verification failure");
          continue;
        }

        const dropped = await dropPartition(partitionName);
        if (dropped) {
          await updateArchivalTrackingStatus(partitionName, logType, "dropped", {
            partitionDroppedAt: new Date(),
          });
          archivalMetrics.increment("partitions_dropped");
          logger.info({ partitionName }, "Partition dropped successfully");
        }
      } catch (error) {
        logger.error({ partitionName, error }, "Error dropping partition");
        captureException(error, {
          worker: "archival",
          workerId: this.workerId,
          partitionName,
          context: "drop_partition",
        });
      }
    }
  }

  private async ensureFuturePartitions(): Promise<void> {
    try {
      await ensurePartitionsExist(env.LOG_RETENTION_HOT_DAYS);
    } catch (error) {
      logger.error({ error }, "Error ensuring future partitions");
      captureException(error, {
        worker: "archival",
        workerId: this.workerId,
        context: "ensure_future_partitions",
      });
    }
  }

  getStats(): ArchivalStats {
    return {
      workerId: this.workerId,
      isRunning: this.isRunning,
      isLeader: this.leaderElection.isCurrentLeader(),
      lastArchivalDate: this.lastArchivalDate,
      metrics: archivalMetrics.getAll(),
    };
  }
}

export interface ArchivalStats {
  workerId: string;
  isRunning: boolean;
  isLeader: boolean;
  lastArchivalDate: string | null;
  metrics: ReturnType<typeof archivalMetrics.getAll>;
}

export const archivalWorker = new ArchivalWorker();
