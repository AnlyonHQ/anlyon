import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { count, eq, gt, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { approvals } from "../../db/schema/approvals.ts";
import { environments } from "../../db/schema/environments.ts";
import { runs } from "../../db/schema/runs.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { env } from "../../config/env.ts";
import { getAggregatedMetrics } from "../../lib/metrics.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ module: "metrics-endpoint" });

const metricsRouter = new Hono();

const WORKER_PREFIXES = ["consumer", "scheduler", "retry", "archival"] as const;

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

metricsRouter.get("/", async (c: Context) => {
  const token = env.METRICS_TOKEN;
  if (!token) return c.notFound();
  const presented = Buffer.from(c.req.header("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return c.text("unauthorized", 401);
  }

  const lines: string[] = [];
  const emit = (name: string, type: "counter" | "gauge", value: number | string) => {
    lines.push(`# TYPE ${name} ${type}`, `${name} ${value}`);
  };

  for (const prefix of WORKER_PREFIXES) {
    try {
      const snapshot = await getAggregatedMetrics(prefix);
      for (const [key, value] of Object.entries(snapshot)) {
        if (typeof value === "string") {
          const parsed = Number(value);
          if (!Number.isNaN(parsed)) {
            emit(`anlyon_${prefix}_${sanitize(key)}`, "gauge", parsed);
          }
        } else {
          for (const [stat, statValue] of Object.entries(value)) {
            const parsed = Number(statValue);
            if (!Number.isNaN(parsed)) {
              emit(`anlyon_${prefix}_${sanitize(key)}_${sanitize(stat)}`, "gauge", parsed);
            }
          }
        }
      }
    } catch (error) {
      logger.warn({ prefix, error }, "Metrics aggregation failed for prefix");
    }
  }

  try {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const [
      [workspaceCount],
      [pendingApprovals],
      [haltedEnvs],
      [suspendedWorkspaces],
      [runsLastDay],
      [paidWorkspaces],
    ] = await Promise.all([
      db.select({ n: count() }).from(workspaces),
      db.select({ n: count() }).from(approvals).where(eq(approvals.status, "pending")),
      db.select({ n: count() }).from(environments).where(isNotNull(environments.haltedAt)),
      db.select({ n: count() }).from(workspaces).where(isNotNull(workspaces.deliverySuspendedAt)),
      db.select({ n: count() }).from(runs).where(gt(runs.startedAt, dayAgo)),
      db.select({ n: count() }).from(workspaces).where(sql`plan != 'free'`),
    ]);

    emit("anlyon_workspaces_total", "gauge", workspaceCount.n);
    emit("anlyon_workspaces_paid", "gauge", paidWorkspaces.n);
    emit("anlyon_approvals_pending", "gauge", pendingApprovals.n);
    emit("anlyon_environments_halted", "gauge", haltedEnvs.n);
    emit("anlyon_workspaces_suspended", "gauge", suspendedWorkspaces.n);
    emit("anlyon_runs_last_24h", "gauge", runsLastDay.n);
  } catch (error) {
    logger.warn({ error }, "Platform gauge collection failed");
  }

  emit("anlyon_metrics_scrape_timestamp_seconds", "gauge", Math.floor(Date.now() / 1000));

  return c.text(`${lines.join("\n")}\n`, 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
});

export default metricsRouter;
