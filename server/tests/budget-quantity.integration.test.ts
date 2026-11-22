import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";

let available = false;

beforeAll(async () => {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    await probe.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.end().catch(() => {});
  }
});

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("budget quantity and replay (real stack, HTTP)", () => {
  let pool: Pool;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let keys: typeof import("../src/core/auth/api-keys.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");
  let budgets: typeof import("../src/core/billing/budgets.ts");

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = (await import("../src/api/index.ts")).default as typeof app;
    keys = await import("../src/core/auth/api-keys.ts");
    envSvc = await import("../src/core/environments/service.ts");
    budgets = await import("../src/core/billing/budgets.ts");
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  const authed = (key: string, init: RequestInit = {}) => ({
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

  async function cappedAccount(cap: number) {
    const userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'T', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    const ws = await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('B', $1) RETURNING id`, [
      `ws-${randomUUID().slice(0, 8)}`,
    ]);
    const workspaceId = ws.rows[0].id as string;
    const environment = await envSvc.ensureDefaultEnvironment(workspaceId);
    const { key, apiKey } = await keys.createApiKey(
      workspaceId, userId, "budgeted", undefined, undefined, environment.id,
    );
    const topic = await app.request("/api/v2/events/topics", authed(key, { method: "POST", body: JSON.stringify({ name: "orders" }) }));
    expect(topic.status).toBe(201);
    const topicId = (await topic.json()).data.id as string;
    await budgets.putBudget(workspaceId, apiKey.id, {
      dimensionCaps: { eventPublishes: cap },
      monthlyCostCentsCap: null,
      enabled: true,
    });
    return { workspaceId, environmentId: environment.id, key, apiKeyId: apiKey.id, topicId };
  }

  const publish = (acc: { key: string; topicId: string }, idempotencyKey?: string, data: Record<string, unknown> = { n: 1 }) =>
    app.request("/api/v2/events", authed(acc.key, {
      method: "POST",
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
      body: JSON.stringify({ topic: acc.topicId, type: "order.created", data }),
    }));

  const eventCount = async (workspaceId: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM events WHERE workspace_id = $1`, [workspaceId]))
      .rows[0].n as number;

  it("preserves a consumed cap when disposable Redis budget counters disappear", async () => {
    const acc = await cappedAccount(1);
    expect((await publish(acc)).status).toBe(202);
    const { redis, RedisKeys } = await import("../src/lib/redis.ts");
    const { getMonthKey } = await import("../src/lib/workspace-cache.ts");
    await redis.del(RedisKeys.keyBudgetCounter(acc.apiKeyId, "eventPublishes", getMonthKey()));
    expect((await publish(acc, undefined, { n: 2 })).status).toBe(429);
    expect(await eventCount(acc.workspaceId)).toBe(1);
    expect((await budgets.getBudgetUsage(acc.apiKeyId)).eventPublishes).toBe(1);
  });

  it("does not execute a paid effect again after its Redis idempotency result is lost", async () => {
    const acc = await cappedAccount(10);
    const id = `lost-${randomUUID()}`;
    expect((await publish(acc, id)).status).toBe(202);
    const { redis, RedisKeys } = await import("../src/lib/redis.ts");
    await redis.del(RedisKeys.idempotency(acc.workspaceId, acc.environmentId, id));
    const replay = await publish(acc, id);
    expect(replay.status).toBe(409);
    const { error } = await replay.json();
    expect(error.code).toBe("BUDGET_EFFECT_ALREADY_RESERVED");
    const { rows: [original] } = await pool.query("SELECT id, month FROM budget_reservations WHERE api_key_id = $1", [acc.apiKeyId]);
    expect(error.details).toEqual({ reservationId: original.id, month: original.month, dimension: "eventPublishes", units: 1 });
    expect(await eventCount(acc.workspaceId)).toBe(1);
    expect((await budgets.getBudgetUsage(acc.apiKeyId)).eventPublishes).toBe(1);
  });

  it("validates metered request bodies before reserving budget", async () => {
    const acc = await cappedAccount(10);
    for (const path of ["/events", "/actions/missing/invoke"]) {
      const res = await app.request(`/api/v2${path}`, authed(acc.key, { method: "POST", body: "null" }));
      expect(res.status, path).toBe(400);
    }
    const usage = await budgets.getBudgetUsage(acc.apiKeyId);
    expect(Object.values(usage).every(value => value === 0)).toBe(true);
  });

  it("replays an accepted publish at the cap instead of charging again", async () => {
    const acc = await cappedAccount(1);
    const idempotencyKey = `idem-${randomUUID()}`;

    const first = await publish(acc, idempotencyKey);
    expect(first.status).toBe(202);
    expect((await budgets.getBudgetUsage(acc.apiKeyId)).eventPublishes).toBe(1);

    const replay = await publish(acc, idempotencyKey);
    expect(replay.status).toBe(202);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
    expect((await budgets.getBudgetUsage(acc.apiKeyId)).eventPublishes).toBe(1);
    expect(await eventCount(acc.workspaceId)).toBe(1);
  });

  it("does not charge a request that fails validation", async () => {
    const acc = await cappedAccount(5);

    const res = await app.request(
      "/api/v2/events",
      authed(acc.key, { method: "POST", body: JSON.stringify({ topic: acc.topicId, type: "not a valid type!" }) }),
    );

    expect(res.status).toBe(400);
    expect((await budgets.getBudgetUsage(acc.apiKeyId)).eventPublishes).toBe(0);
  });

  it("never admits more than the cap when concurrent publishes race for the last units", async () => {
    const acc = await cappedAccount(2);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => publish(acc, undefined, { n: i })));
    const accepted = results.filter((r) => r.status === 202);

    expect(accepted).toHaveLength(2);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    expect(await eventCount(acc.workspaceId)).toBe(2);
    expect((await budgets.getBudgetUsage(acc.apiKeyId)).eventPublishes).toBe(2);
  });
});
