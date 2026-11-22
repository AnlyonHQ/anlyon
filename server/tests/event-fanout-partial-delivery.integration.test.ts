process.env.EVENTS_FANOUT_CONCURRENCY = "1";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { resetMessageUsage } from "./support/message-quota-fixture.ts";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: vi.fn(async () => new Response("{}", { status: 200 })) };
});

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

const FREE_CAPS = {
  maxMonthlyMessages: 25_000,
  usagePolicy: {
    actionInvokes: { kind: "hard-cap", capUnits: 100_000 },
    messages: { kind: "hard-cap", capUnits: 25_000 },
    storage: { kind: "hard-cap", capUnits: 1024 ** 3 },
    bandwidth: { kind: "hard-cap", capUnits: 50 * 1024 ** 3 },
  },
} as const;

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("event fan-out partial delivery (real Postgres + Redis)", () => {
  let pool: Pool;
  let envSvc: typeof import("../src/core/environments/service.ts");
  let redisLib: typeof import("../src/lib/redis.ts");
  let pricing: typeof import("../src/core/plans/limits.ts");
  let worker: {
    fanOut: (eventInternalId: string, workspaceId: string) => Promise<void>;
    handleEntry: (streamId: string, fields: string[]) => Promise<void>;
  };

  let workspaceId: string;
  let environmentId: string;
  let topicInternalId: string;
  let monthlyCap: number;
  let monthKey: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    envSvc = await import("../src/core/environments/service.ts");
    redisLib = await import("../src/lib/redis.ts");
    pricing = await import("../src/core/plans/limits.ts");
    const { usePlanFixture } = await import("./support/plan-fixture.ts");
    usePlanFixture({ free: FREE_CAPS });
    const { EventsFanoutWorker } = await import("../src/workers/events.ts");
    worker = new EventsFanoutWorker(0) as unknown as typeof worker;

    const freeLimits = pricing.getPlanLimits("free");
    expect(freeLimits.maxMonthlyMessages).not.toBe("unlimited");
    monthlyCap = freeLimits.maxMonthlyMessages as number;

    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('E', $1, 'free') RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    environmentId = (await envSvc.ensureDefaultEnvironment(workspaceId)).id;

    topicInternalId = (
      await pool.query(
        `INSERT INTO event_topics (workspace_id, environment_id, topic_id, name)
         VALUES ($1, $2, $3, 'orders') RETURNING id`,
        [workspaceId, environmentId, `top_${randomUUID().slice(0, 12)}`],
      )
    ).rows[0].id;

    for (const label of ["alpha", "beta", "gamma"]) {
      await pool.query(
        `INSERT INTO event_subscriptions (workspace_id, environment_id, topic_id, subscription_id, url)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          workspaceId,
          environmentId,
          topicInternalId,
          `sub_${randomUUID().slice(0, 12)}`,
          `https://${label}.subscriber.test/hook`,
        ],
      );
    }

    const now = new Date();
    monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }, 60_000);

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await redisLib.redis.del(redisLib.RedisKeys.workspaceCache(workspaceId));
    }
    await pool?.end().catch(() => {});
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM messages WHERE workspace_id = $1", [workspaceId]);
    await clearQuota();
  });

  afterEach(async () => {
    await clearQuota();
  });

  async function clearQuota() {
    await resetMessageUsage(pool, workspaceId, monthKey);
    await redisLib.redis.del(redisLib.RedisKeys.quotaMonthly(workspaceId, monthKey));
  }

  async function fillQuotaToOneRemaining() {
    await resetMessageUsage(pool, workspaceId, monthKey, monthlyCap - 1);
    await redisLib.redis.set(
      redisLib.RedisKeys.quotaMonthly(workspaceId, monthKey),
      String(monthlyCap - 1),
      "EX",
      3600,
    );
  }

  async function exhaustQuota() {
    await resetMessageUsage(pool, workspaceId, monthKey, monthlyCap);
    await redisLib.redis.set(
      redisLib.RedisKeys.quotaMonthly(workspaceId, monthKey),
      String(monthlyCap),
      "EX",
      3600,
    );
  }

  async function seedEvent() {
    const { rows } = await pool.query(
      `INSERT INTO events (workspace_id, environment_id, topic_id, event_id, type, data, status)
       VALUES ($1, $2, $3, $4, 'order.created', '{"id":1}'::jsonb, 'received') RETURNING id, event_id`,
      [workspaceId, environmentId, topicInternalId, `evt_${randomUUID().slice(0, 12)}`],
    );
    return rows[0] as { id: string; event_id: string };
  }

  const deliveryUrls = async () =>
    (
      await pool.query("SELECT url FROM messages WHERE workspace_id = $1 ORDER BY url", [workspaceId])
    ).rows.map((r) => r.url as string);

  const eventRow = async (id: string) =>
    (await pool.query("SELECT status, subscription_count FROM events WHERE id = $1", [id])).rows[0] as {
      status: string;
      subscription_count: number;
    };

  it("does not mark an event fanned out when a subscriber could not be reached", async () => {
    const event = await seedEvent();
    await fillQuotaToOneRemaining();

    await worker.fanOut(event.id, workspaceId).catch(() => {});

    expect((await deliveryUrls()).length).toBe(1);
    expect((await eventRow(event.id)).status).toBe("received");
  });

  it("delivers only the missing subscribers when the retry succeeds", async () => {
    const event = await seedEvent();
    await fillQuotaToOneRemaining();
    await worker.fanOut(event.id, workspaceId).catch(() => {});
    const first = await deliveryUrls();
    expect(first.length).toBe(1);

    await clearQuota();
    await worker.fanOut(event.id, workspaceId);

    expect(await deliveryUrls()).toEqual([
      "https://alpha.subscriber.test/hook",
      "https://beta.subscriber.test/hook",
      "https://gamma.subscriber.test/hook",
    ]);
    const row = await eventRow(event.id);
    expect(row.status).toBe("fanned_out");
    expect(row.subscription_count).toBe(3);
  });

  it("gives up after a bounded number of attempts rather than retrying for ever", async () => {
    const event = await seedEvent();
    const fields = ["eventId", event.id, "workspaceId", workspaceId];

    let finalisedOnAttempt = 0;
    for (let attempt = 1; attempt <= 12 && finalisedOnAttempt === 0; attempt++) {
      if (attempt === 1) await fillQuotaToOneRemaining();
      else await exhaustQuota();
      await worker.handleEntry(`0-${attempt}`, fields);
      if ((await eventRow(event.id)).status === "fanned_out") finalisedOnAttempt = attempt;
    }

    expect(finalisedOnAttempt).toBeGreaterThan(0);
    expect(finalisedOnAttempt).toBeGreaterThan(1);

    const row = await eventRow(event.id);
    expect(row.subscription_count).toBe(1);
    expect((await deliveryUrls()).length).toBe(1);
  });
});
