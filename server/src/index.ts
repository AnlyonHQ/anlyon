import dotenv from "dotenv";
dotenv.config();
import { initSentry, flush as flushSentry, captureException } from "./lib/sentry.ts";
initSentry();

import { serve } from "@hono/node-server";
import app from "./api/index.ts";
import { env } from "./config/env.ts";
import { workerManager } from "./workers/manager.ts";
import { logger } from "./lib/logger.ts";
import { checkRedisHealth, closeRedis } from "./lib/redis.ts";
import { pool } from "./db/index.ts";
import { loadExtensions } from "./core/extensions/loader.ts";
import { runStartTasks, runStopTasks } from "./core/extensions/registry.ts";
import { currentEdition, editionDecision } from "./core/edition/edition.ts";
import { enabledModules, isModuleEnabled } from "./core/edition/modules.ts";
import { logEnterpriseLicenseStatus, logLicenseSeats } from "./core/edition/features.ts";
import { flushAuditEvents } from "./core/audit/recorder.ts";
import { startInstanceSettingsRefresh, stopInstanceSettingsRefresh } from "./core/instance/settings.ts";
import { ensureInstanceAdmin } from "./core/instance/admins.ts";
import { prepareSetup } from "./core/instance/setup.ts";

async function startupChecks() {
  logger.info("Running startup checks...");

  const redisHealthy = await checkRedisHealth();
    if (!redisHealthy) {
    logger.error("Redis health check failed");
    process.exit(1);
  }
  
  logger.info({ redisHealthy }, "Redis health check");

  await loadExtensions();

  logger.info({ edition: currentEdition(), modules: enabledModules() }, "Edition");
  const { declaredBy, ignoredSetting } = editionDecision();
  if (ignoredSetting) {
    logger.warn(
      { edition: currentEdition(), declaredBy, EDITION: ignoredSetting },
      `EDITION=${ignoredSetting} is ignored: this build carries the ${declaredBy.join(", ")} extension, which runs the cloud edition. To run the core alone, set ANLYON_EXTENSIONS=none.`,
    );
  }
  if (isModuleEnabled("instance")) {
    await startInstanceSettingsRefresh();
    await ensureInstanceAdmin();
    await prepareSetup();
  }
  logEnterpriseLicenseStatus();
  await logLicenseSeats().catch((error) => logger.warn({ error }, "Could not count licence seats"));

  await runStartTasks();
}

async function start() {
  try {
    await startupChecks();
    if (env.ENABLE_WORKERS) {
      logger.info("Starting workers...");
      await workerManager.start();
    }

    logger.info({ port: env.PORT, host: env.HOST }, "Starting HTTP server...");

    try {
      const server = serve(
        {
          fetch: app.fetch,
          port: env.PORT as number,
          hostname: env.HOST,
        },
        (info) => {
          const displayHost = env.HOST === "0.0.0.0" ? "localhost" : env.HOST;
          logger.info(
            {
              port: info.port,
              host: env.HOST,
              env: env.NODE_ENV,
            },
            `Anlyon Relay API is running`
          );
          logger.info(`📍 API: http://${displayHost}:${info.port}`);
          logger.info(`🏥 Health: http://${displayHost}:${info.port}/health`);
        }
      );

      logger.info("HTTP server initialization complete");

      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info("Shutting down gracefully...");

        const forceExit = setTimeout(() => {
          logger.error("Forced shutdown after timeout");
          process.exit(1);
        }, 45000);
        forceExit.unref();

        runStopTasks();
        stopInstanceSettingsRefresh();

        const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
        const sockets = server as unknown as { closeIdleConnections?: () => void; closeAllConnections?: () => void };
        sockets.closeIdleConnections?.();

        if (env.ENABLE_WORKERS) {
          await workerManager.stop();
        }

        await flushAuditEvents();

        logger.info("Flushing Sentry events...");
        await flushSentry(2000);

        sockets.closeAllConnections?.();
        await serverClosed;
        logger.info("Server closed");

        await closeRedis().catch((error) => logger.warn({ error }, "Redis did not close cleanly"));
        await pool.end().catch((error) => logger.warn({ error }, "Postgres pool did not close cleanly"));
        process.exit(0);
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    } catch (error) {
      logger.error({ error }, "Failed to start HTTP server");
      throw error;
    }
  } catch (error) {
    logger.error({ error }, "Failed to start application");
    
    captureException(error, { startupError: true });
    await flushSentry(2000);
    
    process.exit(1);
  }
}

start();

