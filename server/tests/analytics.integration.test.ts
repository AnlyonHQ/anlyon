import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";

let available = false;

beforeAll(async () => {
  const probe = new Pool({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 1_500,
  });
  try {
    await probe.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.end().catch(() => {});
  }
});

async function seedWorkspace(pool: Pool): Promise<{
  workspaceId: string;
  environmentId: string;
  otherEnvironmentId: string;
}> {
  const workspace = await pool.query<{ id: string }>(
    "INSERT INTO workspaces (name, slug) VALUES ('Analytics', $1) RETURNING id",
    [`analytics-${randomUUID().slice(0, 8)}`],
  );
  const workspaceId = workspace.rows[0].id;
  const environments = await pool.query<{ id: string }>(
    `INSERT INTO environments (workspace_id, name, slug, is_default)
     VALUES ($1, 'Production', 'production', true), ($1, 'Staging', 'staging', false)
     RETURNING id`,
    [workspaceId],
  );
  return {
    workspaceId,
    environmentId: environments.rows[0].id,
    otherEnvironmentId: environments.rows[1].id,
  };
}

describe("expanded analytics (real Postgres)", () => {
  let pool: Pool;
  let analytics: typeof import("../src/core/analytics/expanded-service.ts");

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    analytics = await import("../src/core/analytics/expanded-service.ts");
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  it("aggregates agent outcomes without crossing environment or date boundaries", async () => {
    if (!available) return;
    const scope = await seedWorkspace(pool);
    const startedAt = "2026-07-15T12:00:00.000Z";
    const insertRun = async (
      environmentId: string,
      status: "succeeded" | "failed",
      durationMs: number,
      tokens: number,
      cost: number,
      timestamp = startedAt,
    ) => {
      await pool.query(
        `INSERT INTO runs (
          workspace_id, environment_id, run_id, name, status, tokens, cost,
          started_at, ended_at, duration_ms
        ) VALUES ($1, $2, $3, 'analytics-test', $4, $5, $6, $7, $7, $8)`,
        [
          scope.workspaceId,
          environmentId,
          `run_${randomUUID().replaceAll("-", "").slice(0, 21)}`,
          status,
          tokens,
          cost,
          timestamp,
          durationMs,
        ],
      );
    };

    await insertRun(scope.environmentId, "succeeded", 100, 20, 0.01);
    await insertRun(scope.environmentId, "failed", 300, 30, 0.02);
    await insertRun(scope.otherEnvironmentId, "failed", 900, 100, 1);
    await insertRun(
      scope.environmentId,
      "failed",
      1_000,
      500,
      2,
      "2026-06-01T12:00:00.000Z",
    );

    const result = await analytics.getAgentAnalytics(
      scope.workspaceId,
      new Date("2026-07-15T00:00:00.000Z"),
      new Date("2026-07-16T00:00:00.000Z"),
      "day",
      10,
      scope.environmentId,
    );

    expect(result.scope.environmentId).toBe(scope.environmentId);
    expect(result.summary).toMatchObject({
      totalRuns: 2,
      succeededRuns: 1,
      failedRuns: 1,
      successRate: 50,
      totalTokens: 50,
      totalCost: 0.03,
      p50DurationMs: 200,
    });
    expect(result.series).toEqual([
      {
        period: "2026-07-15",
        total: 2,
        running: 0,
        succeeded: 1,
        failed: 1,
        cancelled: 0,
      },
    ]);
  });
});
