import { createLogger } from "../../lib/logger.ts";
import { Hono, type Context } from "hono";
import { checkRedisHealth } from "../../lib/redis.ts";
import { db } from "../../db/index.ts";
import { workerManager } from "../../workers/manager.ts";
import { sql } from "drizzle-orm";
import { CircuitBreaker } from "../../lib/circuit-breaker.ts";
import { requireInternalAuth } from "../middleware/auth.ts";

const logger = createLogger({ module: "health" });
const health = new Hono();

const BUILD = {
  commit: process.env.BUILD_SHA || "unknown",
  builtAt: process.env.BUILD_TIME || null,
};

health.get("/", (c) => {
  return c.json({
    status: "ok",
    build: BUILD,
    timestamp: new Date().toISOString(),
  });
});

const READY_CACHE_MS = 5_000;
let lastReady: { at: number; ready: boolean; checks: { redis: boolean; database: boolean } } | null = null;

health.get("/ready", async (c:Context) => {
  if (lastReady && Date.now() - lastReady.at < READY_CACHE_MS) {
    return c.json(
      { ready: lastReady.ready, checks: lastReady.checks, timestamp: new Date(lastReady.at).toISOString(), cached: true },
      lastReady.ready ? 200 : 503
    );
  }
  try {
    const redisHealthy = await checkRedisHealth();

    let dbHealthy = false;
    try {
      await db.execute(sql`SELECT 1`);
      dbHealthy = true;
    } catch (error) {
      dbHealthy = false;
    }

    const ready = redisHealthy && dbHealthy;
    lastReady = { at: Date.now(), ready, checks: { redis: redisHealthy, database: dbHealthy } };

    return c.json(
      {
        ready,
        checks: {
          redis: redisHealthy,
          database: dbHealthy,
        },
        timestamp: new Date().toISOString(),
      },
      ready ? 200 : 503
    );
  } catch (error) {
    logger.warn({ error }, "Readiness check failed");
    return c.json(
      {
        ready: false,
        error: "A dependency is not ready",
        timestamp: new Date().toISOString(),
      },
      503
    );
  }
});

health.get("/live", (c) => {
  return c.json({
    alive: true,
    timestamp: new Date().toISOString(),
  });
});

health.get("/status", requireInternalAuth, async (c) => {
  const redisHealthy = await checkRedisHealth();

  let dbHealthy = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbHealthy = true;
  } catch (error) {
    dbHealthy = false;
  }

  const workerStatus = workerManager.getStatus();
  const workerHealth = await workerManager.getDetailedHealth();
  const openCircuits = await CircuitBreaker.getOpenCircuits();

  return c.json({
    status: workerHealth.healthy && redisHealthy && dbHealthy ? "healthy" : "degraded",
    services: {
      redis: redisHealthy ? "healthy" : "unhealthy",
      database: dbHealthy ? "healthy" : "unhealthy",
      workers: {
        ...workerStatus,
        detailed: workerHealth.workers,
      },
    },
    circuitBreakers: {
      openCount: openCircuits.length,
      openCircuits: openCircuits.map((c) => ({
        host: c.host,
        failures: c.state.failures,
        openUntil: new Date(c.state.openUntil).toISOString(),
      })),
    },
    issues: workerHealth.issues,
    timestamp: new Date().toISOString(),
  });
});

health.post("/cleanup", requireInternalAuth, async (c) => {
  const cleaned = await workerManager.cleanupStale();
  return c.json({
    message: "Cleanup completed",
    staleWorkersRemoved: cleaned,
    timestamp: new Date().toISOString(),
  });
});

export default health;
