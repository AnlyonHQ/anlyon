import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { messageUsage, resetMessageUsage } from "./support/message-quota-fixture.ts";

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

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("worker-time accounting (real Postgres + Redis)", () => {
  let pool: Pool;
  let envSvc: typeof import("../src/core/environments/service.ts");
  let redisLib: typeof import("../src/lib/redis.ts");
  let dlq: typeof import("../src/core/messaging/dlq.ts");
  let fanoutWorker: { fanOut: (eventInternalId: string, workspaceId: string) => Promise<void> };

  let workspaceId: string;
  let environmentId: string;
  let topicInternalId: string;
  let monthKey: string;
  let todayKey: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    envSvc = await import("../src/core/environments/service.ts");
    redisLib = await import("../src/lib/redis.ts");
    dlq = await import("../src/core/messaging/dlq.ts");
    const { EventsFanoutWorker } = await import("../src/workers/events.ts");
    fanoutWorker = new EventsFanoutWorker(0) as unknown as typeof fanoutWorker;

    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('W', $1, 'free') RETURNING id`, [
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

    for (const label of ["alpha", "beta"]) {
      await pool.query(
        `INSERT INTO event_subscriptions (workspace_id, environment_id, topic_id, subscription_id, url)
         VALUES ($1, $2, $3, $4, $5)`,
        [workspaceId, environmentId, topicInternalId, `sub_${randomUUID().slice(0, 12)}`,
         `https://${label}.subscriber.test/hook`],
      );
    }

    const now = new Date();
    monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    todayKey = now.toISOString().split("T")[0];
  }, 60_000);

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await redisLib.redis.del(
        redisLib.RedisKeys.workspaceCache(workspaceId),
        redisLib.RedisKeys.quotaMonthly(workspaceId, monthKey),
        redisLib.RedisKeys.quotaDaily(workspaceId, todayKey),
        redisLib.RedisKeys.quotaBandwidth(workspaceId, monthKey),
      );
    }
    await pool?.end().catch(() => {});
  });

  beforeEach(async () => {
    await resetMessageUsage(pool, workspaceId, monthKey);
    await pool.query("DELETE FROM messages WHERE workspace_id = $1", [workspaceId]);
    await redisLib.redis.del(
      redisLib.RedisKeys.quotaMonthly(workspaceId, monthKey),
      redisLib.RedisKeys.quotaBandwidth(workspaceId, monthKey),
      redisLib.RedisKeys.pendingStream(workspaceId),
    );
  });

  const monthlyMessages = async () =>
    (await messageUsage(pool, workspaceId, monthKey)).messages;
  const monthlyBandwidth = async () =>
    (await messageUsage(pool, workspaceId, monthKey)).bandwidth;

  it("charges an event fan-out child to the workspace plan, since no key owns it", async () => {
    const event = await pool.query(
      `INSERT INTO events (workspace_id, environment_id, topic_id, event_id, type, data, status)
       VALUES ($1, $2, $3, $4, 'order.created', '{"id":1}'::jsonb, 'received') RETURNING id`,
      [workspaceId, environmentId, topicInternalId, `evt_${randomUUID().slice(0, 12)}`],
    );

    await fanoutWorker.fanOut(event.rows[0].id, workspaceId);

    expect(await monthlyMessages()).toBe(2);
    expect(await monthlyBandwidth()).toBeGreaterThan(0);
  });

  it("does not charge a dead-letter replay a second time", async () => {
    const messageId = `msg_${randomUUID().slice(0, 16)}`;
    await pool.query(
      `INSERT INTO messages (workspace_id, environment_id, message_id, url, method, status, attempts, max_retries, failed_at, error_message)
       VALUES ($1, $2, $3, 'https://example.test/hook', 'POST', 'failed', 3, 3, now(), 'connection refused')`,
      [workspaceId, environmentId, messageId],
    );
    await redisLib.redis.zadd(redisLib.RedisKeys.dlqSet(workspaceId), Date.now(), messageId);

    await dlq.retryDLQMessage({ workspaceId, environmentId }, messageId);

    expect(await monthlyMessages()).toBe(0);
    expect(await redisLib.redis.xlen(redisLib.RedisKeys.pendingStream(workspaceId))).toBe(1);
  });
});
