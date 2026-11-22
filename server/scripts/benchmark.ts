import { Pool } from "pg";
import { randomUUID } from "node:crypto";

process.env.INTERNAL_AUTH_SECRET ??= "internal-auth-test-secret-0000000000000";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";
const WARMUP = 25;
const N = Number(process.env.BENCH_N ?? 200);

type App = { request: (path: string, init?: RequestInit) => Promise<Response> };

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function report(name: string, samples: number[], perOp = 1): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const fmt = (v: number) => (v / perOp).toFixed(2);
  console.log(
    `${name.padEnd(46)} p50 ${fmt(percentile(sorted, 50))}ms  p95 ${fmt(percentile(sorted, 95))}ms  p99 ${fmt(
      percentile(sorted, 99),
    )}ms  mean ${fmt(sum / sorted.length)}ms  (n=${sorted.length}${perOp > 1 ? `, per ${perOp === 100 ? "span" : "op"}` : ""})`,
  );
}

async function timed(fn: () => Promise<void>, n: number, warmup: number): Promise<number[]> {
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  return samples;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query("SELECT 1");

  const app = (await import("../src/api/index.ts")).default as unknown as App;
  const keys = await import("../src/core/auth/api-keys.ts");
  const envSvc = await import("../src/core/environments/service.ts");

  const userId = `user_${randomUUID()}`;
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'B', $2, false, now(), now())`,
    [userId, `${userId}@bench.dev`],
  );
  const ws = await pool.query(
    `INSERT INTO workspaces (name, slug, plan) VALUES ('Bench', $1, 'enterprise') RETURNING id`,
    [`bench-${randomUUID().slice(0, 8)}`],
  );
  const workspaceId = ws.rows[0].id as string;
  const env = await envSvc.ensureDefaultEnvironment(workspaceId);
  const { key } = await keys.createApiKey(workspaceId, userId, "bench-key", undefined, undefined, env.id);
  const { key: approverKey } = await keys.createApiKey(
    workspaceId,
    userId,
    "bench-approver",
    undefined,
    undefined,
    env.id,
  );

  const authed = (k: string, init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
  });

  const expectStatus = async (res: Response, allowed: number[], label: string) => {
    if (!allowed.includes(res.status)) {
      throw new Error(`${label} returned ${res.status}: ${await res.text()}`);
    }
  };

  console.log(`Anlyon hot-path benchmark  n=${N} per case, in-process HTTP, real Postgres + Redis\n`);

  const runIds: string[] = [];
  report(
    "POST /runs (start trace)",
    await timed(async () => {
      const res = await app.request(
        "/api/v2/runs",
        authed(key, { method: "POST", body: JSON.stringify({ name: "bench-run" }) }),
      );
      await expectStatus(res, [201], "run start");
      runIds.push((await res.json()).data.id as string);
    }, N, WARMUP),
  );

  {
    const res = await app.request(
      "/api/v2/runs",
      authed(key, { method: "POST", body: JSON.stringify({ name: "bench-span-run" }) }),
    );
    const runId = (await res.json()).data.id as string;
    let batchNo = 0;
    const startedAt = new Date().toISOString();
    report(
      "POST /runs/:id/spans (100-span batch)",
      await timed(async () => {
        const batch = Array.from({ length: 100 }, (_, i) => ({
          id: `b${batchNo}_s${i}`,
          name: `span-${i}`,
          type: "model_call" as const,
          startedAt,
          endedAt: startedAt,
          tokens: { input: 100, output: 50, total: 150 },
          cost: 0.001,
        }));
        batchNo += 1;
        const r = await app.request(
          `/api/v2/runs/${runId}/spans`,
          authed(key, { method: "POST", body: JSON.stringify({ spans: batch }) }),
        );
        await expectStatus(r, [200, 201], "span ingest");
      }, Math.min(N, 100), 5),
    );
  }

  report(
    "POST /approvals + /approve (request + decide)",
    await timed(async () => {
      const created = await app.request(
        "/api/v2/approvals",
        authed(key, { method: "POST", body: JSON.stringify({ title: "Bench approval" }) }),
      );
      await expectStatus(created, [201], "approval create");
      const approvalId = (await created.json()).data.id as string;
      const decided = await app.request(
        `/api/v2/approvals/${approvalId}/approve`,
        authed(approverKey, { method: "POST", body: JSON.stringify({}) }),
      );
      await expectStatus(decided, [200], "approval decide");
    }, N, WARMUP),
  );

  {
    const runId = runIds[runIds.length - 1];
    report(
      "GET /runs/:id (assembled span tree)",
      await timed(async () => {
        const res = await app.request(`/api/v2/runs/${runId}`, authed(key));
        await expectStatus(res, [200], "run read");
      }, N, WARMUP),
    );
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
