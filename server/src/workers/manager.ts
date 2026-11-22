import { startConsumers, ConsumerWorker } from "./consumer.ts";
import { schedulerWorker } from "./scheduler.ts";
import { retryWorker } from "./retry.ts";
import { archivalWorker } from "./archival.ts";
import { startEventsWorkers, EventsFanoutWorker } from "./events.ts";
import { RecoveryWorker } from "./recovery.ts";
import { ReconciliationWorker } from "./reconciliation.ts";
import { ensurePartitionsExist } from "../core/archival/partition-manager.ts";
import { resumeApprovedInvocations, sweepExpiredApprovals } from "../core/approvals/service.ts";
import { reconcileDueEffects } from "../core/effects/reconcile.ts";
import { sweepAbandonedOAuthClients } from "../core/auth/oauth-client-maintenance.ts";
import { resyncHaltStateSweep, syncHaltedEnvironments } from "../core/environments/halt.ts";
import { CLAIM_LEASE_MS, sweepPendingAdvice } from "../core/assistant/service.ts";
import { syncEventSubscriberFlags } from "../core/events/service.ts";
import { sweepConnectionHealth } from "../core/connections/health.ts";
import { sweepUnconfirmedGrants } from "../core/end-users/connect.ts";
import { sweepEndUserKeyHealth } from "../core/end-users/connections.ts";
import { isFeatureEnabled as isFeatureOnBuild } from "@anlyon/feature-flags";
import { SWEEP_INTERVAL_MS as MCP_TOOL_CHECK_SWEEP_MS, sweepUpstreamToolChecks } from "../core/mcp-upstreams/tool-checks.ts";
import { syncSuspendedWorkspaces } from "../core/messaging/abuse-guard.ts";
import { createLogger } from "../lib/logger.ts";
import { env } from "../config/env.ts";
import { flushMessageUpdates } from "../lib/batch-writer.ts";
import { deliverDueAuditSinks } from "../core/audit/delivery.ts";
import { flushAuditEvents } from "../core/audit/recorder.ts";
import { sweepAuditRetention } from "../core/audit/retention.ts";
import { sweepSignOffs } from "../core/governance/sign-offs.ts";
import { isFeatureEnabled } from "../core/edition/features.ts";
import { getSystemHealth, cleanupStaleWorkers } from "../lib/worker-health.ts";
import { captureException } from "../lib/sentry.ts";
import { syncAllWorkspaceUsage, reconcileAllWorkspaceUsage } from "../core/billing/usage-sync.ts";
import { withSweepLock } from "../core/billing/sweep-lock.ts";
import { isModuleEnabled } from "../core/edition/modules.ts";
import { extensionSweeps, type MaintenanceSweep } from "../core/extensions/registry.ts";
import { reportTelemetryIfDue } from "../core/instance/telemetry.ts";
import { currentEdition, isLicensedEdition, type Edition } from "../core/edition/edition.ts";
import { logLicenseSeats } from "../core/edition/features.ts";

const logger = createLogger({ module: "worker-manager" });

const coreSweeps = (): MaintenanceSweep[] => [
  {
    name: "Log partition upkeep",
    context: "log_partition_upkeep",
    intervalMs: 6 * 60 * 60000,
    run: async () => { await withSweepLock("log-partitions", 5 * 60 * 60, () => ensurePartitionsExist(7), { holdOnSuccess: true }); },
  },
  { name: "Usage sync", context: "usage_sync", intervalMs: 15 * 60000,
    run: async () => { await withSweepLock("usage-sync", 840, syncAllWorkspaceUsage); } },
  { name: "Usage reconciliation", context: "usage_reconciliation", intervalMs: 6 * 60 * 60000,
    run: async () => { await withSweepLock("usage-reconciliation", 3540, reconcileAllWorkspaceUsage); } },
  {
    name: "Approval expiry sweep",
    context: "approval_expiry_sweep",
    intervalMs: env.MAINTENANCE_SWEEP_INTERVAL_MS,
    run: async () => {
      await withSweepLock("approval-expiry", 3300, async () => { await sweepExpiredApprovals(); });
    },
  },
  {
    name: "Sign-off expiry sweep",
    context: "sign_off_expiry_sweep",
    intervalMs: 300_000,
    run: async () => {
      await withSweepLock("sign-off-expiry", 290, async () => { await sweepSignOffs(); });
    },
  },
  {
    name: "Unconfirmed end-user grant sweep",
    context: "end_user_grant_sweep",
    intervalMs: 300_000,
    run: async () => {
      await withSweepLock("end-user-grants", 290, async () => { await sweepUnconfirmedGrants(); });
    },
  },
  {
    name: "Halt state resync",
    context: "halt_state_resync",
    intervalMs: 60000,
    run: async () => {
      await resyncHaltStateSweep();
    },
  },
  {
    name: "Assistant advice",
    context: "assistant_advice_sweep",
    intervalMs: 15000,
    enabled: () => Boolean(env.TYPESAFE_API_KEY),
    run: async () => {
      await withSweepLock("assistant-advice", Math.ceil(CLAIM_LEASE_MS / 1000) + 30, async () => { await sweepPendingAdvice(); });
    },
  },
  {
    name: "Approved invocation resume",
    context: "approval_resume_sweep",
    intervalMs: env.MAINTENANCE_SWEEP_INTERVAL_MS,
    run: async () => {
      await resumeApprovedInvocations();
    },
  },
  {
    name: "Effect reconciliation",
    context: "effect_reconciliation_sweep",
    intervalMs: 15000,
    run: async () => {
      await reconcileDueEffects();
    },
  },
  {
    name: "OAuth client sweep",
    context: "oauth_client_sweep",
    intervalMs: env.MAINTENANCE_SWEEP_INTERVAL_MS,
    run: async () => {
      await withSweepLock("oauth-clients", 3300, async () => { await sweepAbandonedOAuthClients(); });
    },
  },
  {
    name: "Instance telemetry",
    context: "instance_telemetry",
    intervalMs: 60 * 60 * 1000,
    module: "instance",
    run: async () => {
      await withSweepLock("instance-telemetry", 3540, async () => { await reportTelemetryIfDue(); });
    },
  },
  {
    name: "Licence seat check",
    context: "license_seat_check",
    intervalMs: 60 * 60 * 1000,
    enabled: () => isLicensedEdition(),
    run: async () => {
      await logLicenseSeats();
    },
  },
  {
    name: "Connected account health sweep",
    context: "connection_health_sweep",
    intervalMs: 60 * 60 * 1000,
    run: async () => {
      await withSweepLock("connection-health", 3540, async () => {
        await sweepConnectionHealth();
        await sweepEndUserKeyHealth();
      });
    },
  },
  {
    name: "MCP tool check sweep",
    context: "mcp_tool_check_sweep",
    intervalMs: MCP_TOOL_CHECK_SWEEP_MS,
    enabled: () => isFeatureOnBuild("mcp-upstreams"),
    run: async () => {
      await sweepUpstreamToolChecks();
    },
  },
  {
    name: "Audit sink delivery",
    context: "audit_sink_delivery",
    intervalMs: 5000,
    enabled: () => isFeatureEnabled("audit_streaming"),
    run: async () => {
      await deliverDueAuditSinks();
    },
  },
  {
    name: "Audit retention sweep",
    context: "audit_retention_sweep",
    intervalMs: 60 * 60 * 1000,
    enabled: () => isFeatureEnabled("audit_streaming"),
    run: async () => {
      await withSweepLock("audit-retention", 3540, async () => { await sweepAuditRetention(); });
    },
  },
];

const maintenanceSweeps = (): MaintenanceSweep[] => [...coreSweeps(), ...extensionSweeps()];

export function plannedSweeps(edition: Edition = currentEdition()): string[] {
  return maintenanceSweeps().filter((sweep) => !sweep.module || isModuleEnabled(sweep.module, edition)).map((sweep) => sweep.name);
}

export class WorkerManager {
  private consumers: ConsumerWorker[] = [];
  private eventsWorkers: EventsFanoutWorker[] = [];
  private recoveryWorker: RecoveryWorker | null = null;
  private reconciliationWorker: ReconciliationWorker | null = null;
  private sweepTimers: ReturnType<typeof setInterval>[] = [];
  private isRunning = false;

  async start(): Promise<void> {
    if (!env.ENABLE_WORKERS) {
      logger.info("Workers disabled in configuration");
      return;
    }

    if (this.isRunning) {
      logger.warn("Workers already running");
      return;
    }

    this.isRunning = true;
    logger.info("Starting all workers");

    try {
      await syncHaltedEnvironments();
      await syncSuspendedWorkspaces();

      await syncEventSubscriberFlags();

      await schedulerWorker.start();

      await retryWorker.start();

      this.consumers = await startConsumers(
        env.CONSUMER_WORKERS ? Number(env.CONSUMER_WORKERS) : undefined
      );

      this.recoveryWorker = new RecoveryWorker();
      await this.recoveryWorker.start();
      this.reconciliationWorker = new ReconciliationWorker();
      await this.reconciliationWorker.start();

      if (env.LOG_ARCHIVAL_ENABLED === "true") {
        await archivalWorker.start();
      }

      this.eventsWorkers = await startEventsWorkers();

      for (const sweep of maintenanceSweeps()) {
        if (sweep.module && !isModuleEnabled(sweep.module)) continue;
        if (sweep.enabled && !sweep.enabled()) continue;
        this.sweepTimers.push(
          setInterval(async () => {
            try {
              await sweep.run();
            } catch (error) {
              logger.error({ error }, `${sweep.name} failed`);
              captureException(error, { context: sweep.context });
            }
          }, sweep.intervalMs),
        );
      }

      logger.info(
        {
          schedulerWorker: true,
          retryWorker: true,
          archivalWorker: env.LOG_ARCHIVAL_ENABLED === "true",
          consumers: this.consumers.length,
          eventsWorkers: this.eventsWorkers.length,
        },
        "All workers started successfully"
      );

    } catch (error) {
      logger.error({ error }, "Failed to start workers");
      captureException(error, {
        context: "worker_manager_start",
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info("Stopping all workers");

    try {
      await schedulerWorker.stop();

      await retryWorker.stop();

      await archivalWorker.stop();

      await Promise.all(this.consumers.map((consumer) => consumer.stop()));

      await this.recoveryWorker?.stop();
      this.recoveryWorker = null;
      await this.reconciliationWorker?.stop();
      this.reconciliationWorker = null;

      await Promise.all(this.eventsWorkers.map((worker) => worker.stop()));
      this.eventsWorkers = [];

      for (const timer of this.sweepTimers) {
        clearInterval(timer);
      }
      this.sweepTimers = [];

      logger.info("Flushing pending database writes...");
      await flushMessageUpdates();
      await flushAuditEvents();

      this.consumers = [];
      this.isRunning = false;

      logger.info("All workers stopped successfully");
    } catch (error) {
      logger.error({ error }, "Error stopping workers");
      captureException(error, {
        context: "worker_manager_stop",
      });
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      consumers: this.consumers.length,
      schedulerWorker: this.isRunning,
      retryWorker: this.isRunning,
      archivalWorker: env.LOG_ARCHIVAL_ENABLED === "true" && this.isRunning,
    };
  }

  async getDetailedHealth() {
    return await getSystemHealth();
  }

  async cleanupStale() {
    return await cleanupStaleWorkers();
  }
}

export const workerManager = new WorkerManager();
