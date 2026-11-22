import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { usePlanFixture } from "./support/plan-fixture.ts";

const state = vi.hoisted(() => {
  process.env.FUNCTION_RUNNER_URL = "https://runner.anlyon.test";
  process.env.RUNNER_SHARED_SECRET = "test-runner-shared-secret-at-least-32-chars";
  return { client: undefined as PGlite | undefined, store: new Map<string, string>() };
});

vi.mock("../src/lib/safe-http.ts", async (original) => ({
  ...await original<typeof import("../src/lib/safe-http.ts")>(),
  safeFetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
}));
vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client), pool: { end: async () => {} } };
});
vi.mock("../src/lib/redis.ts", () => {
  const redis = {
    async set(key: string, value: string) { state.store.set(key, value); return "OK"; },
    async get(key: string) { return state.store.get(key) ?? null; },
    async getdel(key: string) { const value = state.store.get(key) ?? null; state.store.delete(key); return value; },
    async del(key: string) { return state.store.delete(key) ? 1 : 0; },
    async incr(key: string) { const next = Number(state.store.get(key) ?? 0) + 1; state.store.set(key, String(next)); return next; },
    async decr() { return 0; },
    async expire() { return 1; },
    async pttl() { return -2; },
    async exists() { return 0; },
    async hgetall() { return {}; },
    async eval() { return null; },
  };
  const RedisKeys = new Proxy({}, { get: (_t, name) => (...parts: unknown[]) => `${String(name)}:${parts.join(":")}` });
  return { redis, redisBlocking: redis, RedisKeys, createBlockingConnection: () => redis };
});
vi.mock("../src/core/events/emitter.ts", () => ({ emitEvent: vi.fn() }));
vi.mock("../src/core/notifications/notification-service.ts", () => ({ createAndSendNotification: vi.fn() }));
vi.mock("../src/core/assistant/service.ts", async (original) => ({
  getAssistantSettings: (await original<typeof import("../src/core/assistant/service.ts")>()).getAssistantSettings,
  onApprovalAnnounced: async () => false,
}));
vi.mock("../src/lib/product-events.ts", () => ({ captureMilestoneOnce: vi.fn() }));
vi.mock("../src/core/assistant/usage.ts", async (original) => ({
  ...await original<typeof import("../src/core/assistant/usage.ts")>(),
  admitPlatformReview: async () => ({ period: "test" }),
  releasePlatformReview: async () => {},
}));

const STARTER_RUNS = { runsPerMonth: 50, concurrentRuns: 2, runStartsPerMinute: 5 };
const NO_PLAN = { usagePolicy: { actionInvokes: { kind: "payment-required" as const } } };
const plans = usePlanFixture({
  free: NO_PLAN,
  starter: {
    functionRuns: STARTER_RUNS,
    usagePolicy: { actionInvokes: { kind: "included-with-grace", includedUnits: 1_000, graceCapUnits: 1_100 } },
  },
}, { purchasable: true });

const { env } = await import("../src/config/env.ts");
const service = await import("../src/core/functions/service.ts");
const runs = await import("../src/core/functions/runs.ts");
const { getFunctionRunUsage, RUN_SLOT_SECONDS } = await import("../src/core/functions/admission.ts");
const { handleFunctionCall } = await import("../src/core/functions/calls.ts");
const { signRunnerRequest } = await import("../src/core/functions/runner-signing.ts");
const { FunctionRunnerUnavailableError } = await import("../src/core/functions/errors.ts");
const { getMonthKey } = await import("../src/lib/workspace-cache.ts");
const { resetPlanProvider, setPlanProvider, SELF_HOSTED_LIMITS } = await import("../src/core/plans/limits.ts");
type RunnerRunRequest = import("../src/core/functions/runner-client.ts").RunnerRunRequest;
type RunnerRunResponse = import("../src/core/functions/runner-client.ts").RunnerRunResponse;

const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);
const actor = { type: "api_key" as const, id: "key" };
const done = async (): Promise<RunnerRunResponse> => ({ status: "succeeded", output: 1, logs: [], durationMs: 1 });

beforeAll(async () => {
  await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('user_lim', 'Dev', 'lim@example.test', true, now(), now())`);
}, 120_000);
afterAll(() => resetPlanProvider());

let counter = 0;
async function workspace(plan: string) {
  const n = ++counter;
  const ws = randomUUID();
  const envId = randomUUID();
  const keyId = randomUUID();
  await sql("INSERT INTO workspaces (id, name, slug, plan) VALUES ($1, $2, $3, $4)", [ws, `W${n}`, `w-core-${n}`, plan]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug, is_default) VALUES ($1, $2, 'Production', 'prod', true)", [envId, ws]);
  await sql(
    `INSERT INTO api_keys (id, workspace_id, environment_id, name, key_hash, key_prefix, created_by, scopes)
       VALUES ($1, $2, $3, 'server', $4, 'anlyon_l', 'user_lim', '["functions:run","actions:invoke"]'::jsonb)`,
    [keyId, ws, envId, `hash_core_${n}`],
  );
  await sql("INSERT INTO actions (workspace_id, environment_id, action_id, name, method, url_template, enabled) VALUES ($1, $2, $3, 'refund', 'POST', 'https://shop.test/refunds', true)", [ws, envId, `act_core_${n}`]);
  const scope = { workspaceId: ws, environmentId: envId };
  await service.createFunction(scope, { name: "job" });
  await service.publishVersion(scope, "job", { language: "javascript", source: `export default async function run() { return ${n}; }`, allowedActions: ["refund"], straightThrough: { actions: ["refund"], maxWrites: 5 } }, { keyId, userId: null });
  const start = (send: (request: RunnerRunRequest) => Promise<RunnerRunResponse> = done) =>
    runs.startRun(scope, "job", {}, { mode: "straight_through", endUser: { endUserId: null, required: false }, requestedByKeyId: keyId, actor, send });
  const counted = async () => Number((await sql("SELECT function_runs FROM workspace_usage_periods WHERE workspace_id = $1 AND month = $2", [ws, getMonthKey()])).rows[0]?.function_runs ?? 0);
  return { ws, envId, keyId, scope, start, counted };
}

function heldRunner() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  const send = async (): Promise<RunnerRunResponse> => {
    started += 1;
    await gate;
    return done();
  };
  return { send, release: () => release(), started: () => started };
}

describe("the plan's function run limits", () => {
  it("are the registered plan's, as the billing page reads them", async () => {
    const w = await workspace("starter");
    expect((await getFunctionRunUsage(w.ws)).limits).toEqual(STARTER_RUNS);
  });

  it("cap nothing without a plan provider: the self-host core", async () => {
    const w = await workspace("starter");
    resetPlanProvider();
    try {
      expect(SELF_HOSTED_LIMITS.functionRuns).toEqual({ runsPerMonth: "unlimited", concurrentRuns: "unlimited", runStartsPerMinute: "unlimited" });
      expect((await getFunctionRunUsage(w.ws)).limits).toEqual(SELF_HOSTED_LIMITS.functionRuns);
      await sql(`INSERT INTO workspace_usage_periods (workspace_id, month, function_runs) VALUES ($1, $2, 10000)
        ON CONFLICT (workspace_id, month) DO UPDATE SET function_runs = 10000`, [w.ws, getMonthKey()]);
      for (let i = 0; i < STARTER_RUNS.runStartsPerMinute + 1; i++) expect((await w.start()).status).toBe("succeeded");
      expect(await w.counted()).toBe(10000 + STARTER_RUNS.runStartsPerMinute + 1);
    } finally {
      setPlanProvider(plans.provider);
    }
  });
});

describe("concurrent runs", () => {
  it("admits exactly the plan's number of racing runs, and refuses the rest before the runner is called", async () => {
    const w = await workspace("starter");
    const runner = heldRunner();
    const attempts = Array.from({ length: 5 }, () => w.start(runner.send).then((run) => ({ ok: true as const, run }), (error) => ({ ok: false as const, error })));
    await vi.waitFor(() => expect(runner.started()).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    runner.release();
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    const refused = results.filter((r) => !r.ok);
    expect(refused).toHaveLength(3);
    for (const r of refused) expect(r.error).toMatchObject({ statusCode: 429, code: "FUNCTION_RUN_CONCURRENCY_LIMIT" });
    expect(runner.started()).toBe(2);
    expect(await w.counted()).toBe(2);
    expect(Number((await sql("SELECT count(*)::int AS n FROM function_runs WHERE workspace_id = $1", [w.ws])).rows[0]!.n)).toBe(2);
  });

  it("frees a slot when a run ends, and does not let a run abandoned by a crash hold one for ever", async () => {
    const w = await workspace("starter");
    await w.start();
    await w.start();
    const version = (await sql("SELECT function_row_id, function_version_row_id FROM function_runs WHERE workspace_id = $1 LIMIT 1", [w.ws])).rows[0]!;
    const insertRunning = (age: number) => sql(
      "INSERT INTO function_runs (workspace_id, environment_id, function_row_id, function_version_row_id, run_id, status, input_digest, created_at) VALUES ($1, $2, $3, $4, $5, 'running', 'x', now() - make_interval(secs => $6))",
      [w.ws, w.envId, version.function_row_id, version.function_version_row_id, `frn_crash_${randomUUID().slice(0, 8)}`, age],
    );
    await insertRunning(RUN_SLOT_SECONDS + 60);
    await insertRunning(RUN_SLOT_SECONDS + 120);
    expect((await w.start()).status).toBe("succeeded");
    await insertRunning(70);
    await insertRunning(80);
    await expect(w.start()).rejects.toMatchObject({ statusCode: 429, code: "FUNCTION_RUN_CONCURRENCY_LIMIT" });
    expect((await getFunctionRunUsage(w.ws)).running).toBe(2);
  });
});

describe("run starts per minute", () => {
  it("refuses the start past the plan's number in 60 seconds, with nothing recorded", async () => {
    const w = await workspace("starter");
    for (let i = 0; i < STARTER_RUNS.runStartsPerMinute; i++) await w.start();
    await expect(w.start()).rejects.toMatchObject({ statusCode: 429, code: "FUNCTION_RUN_RATE_LIMITED" });
    expect(await w.counted()).toBe(STARTER_RUNS.runStartsPerMinute);
    await sql("UPDATE function_runs SET created_at = now() - interval '61 seconds' WHERE workspace_id = $1", [w.ws]);
    expect((await w.start()).status).toBe("succeeded");
  }, 60_000);
});

describe("runs per month", () => {
  it("counts each run once in the month's usage row and refuses the run past the allowance", async () => {
    const w = await workspace("starter");
    await w.start();
    expect(await w.counted()).toBe(1);
    await sql("UPDATE workspace_usage_periods SET function_runs = $3 WHERE workspace_id = $1 AND month = $2", [w.ws, getMonthKey(), STARTER_RUNS.runsPerMonth]);
    await expect(w.start()).rejects.toMatchObject({ statusCode: 429, code: "QUOTA_EXCEEDED", details: { limit: "runsPerMonth", cap: STARTER_RUNS.runsPerMonth } });
    expect(await w.counted()).toBe(STARTER_RUNS.runsPerMonth);
  });

  it("gives the run back when the runner could not be reached and nothing ran", async () => {
    const w = await workspace("starter");
    await expect(w.start(async () => { throw new FunctionRunnerUnavailableError(); })).rejects.toMatchObject({ statusCode: 503 });
    expect(await w.counted()).toBe(0);
  });

  it("counts a run's action calls as governed actions only, not as more runs", async () => {
    const w = await workspace("starter");
    const send = async (request: RunnerRunRequest): Promise<RunnerRunResponse> => {
      for (let i = 0; i < 2; i++) {
        const body = JSON.stringify({ kind: "invoke", action: "refund", input: { n: i }, execution: "exec-limits-core-1" });
        const path = `/api/internal/function-runs/${request.runId}/calls`;
        const answer = await handleFunctionCall({ runId: request.runId, token: request.runToken, signature: signRunnerRequest(env.RUNNER_SHARED_SECRET!, "POST", path, body), path, body });
        expect(answer.status).toBe(200);
      }
      return done();
    };
    await w.start(send);
    const [period] = (await sql("SELECT function_runs, action_billed, action_reserved FROM workspace_usage_periods WHERE workspace_id = $1 AND month = $2", [w.ws, getMonthKey()])).rows;
    expect(Number(period!.function_runs)).toBe(1);
    expect(Number(period!.action_billed) + Number(period!.action_reserved)).toBe(2);
  });
});

describe("a workspace with no plan", () => {
  it("answers 402 PAYMENT_REQUIRED before anything is recorded", async () => {
    const w = await workspace("free");
    const runner = heldRunner();
    runner.release();
    await expect(w.start(runner.send)).rejects.toMatchObject({ statusCode: 402, code: "PAYMENT_REQUIRED" });
    expect(runner.started()).toBe(0);
    expect(await w.counted()).toBe(0);
  });

  it("runs as soon as the plan table gives it limits (a provider change takes effect at once)", async () => {
    const w = await workspace("free");
    plans.set("free", { functionRuns: STARTER_RUNS });
    try {
      expect((await w.start()).status).toBe("succeeded");
      expect((await getFunctionRunUsage(w.ws)).limits).toEqual(STARTER_RUNS);
    } finally {
      plans.set("free", NO_PLAN);
    }
  });
});
