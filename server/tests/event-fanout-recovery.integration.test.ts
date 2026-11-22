import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

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

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("event fan-out replay (real Postgres + Redis)", () => {
  let pool: Pool;
  let envSvc: typeof import("../src/core/environments/service.ts");
  let worker: { fanOut: (eventInternalId: string, workspaceId: string) => Promise<void> };

  let workspaceId: string;
  let environmentId: string;
  let topicInternalId: string;
  let subscriptionIds: string[];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    envSvc = await import("../src/core/environments/service.ts");
    const { EventsFanoutWorker } = await import("../src/workers/events.ts");
    worker = new EventsFanoutWorker() as unknown as typeof worker;

    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('E', $1) RETURNING id`, [
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

    subscriptionIds = [];
    for (const label of ["alpha", "beta"]) {
      const row = await pool.query(
        `INSERT INTO event_subscriptions (workspace_id, environment_id, topic_id, subscription_id, url)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          workspaceId,
          environmentId,
          topicInternalId,
          `sub_${randomUUID().slice(0, 12)}`,
          `https://${label}.subscriber.test/hook`,
        ],
      );
      subscriptionIds.push(row.rows[0].id);
    }
  }, 60_000);

  afterAll(async () => {
    if (workspaceId) await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool?.end().catch(() => {});
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM messages WHERE workspace_id = $1", [workspaceId]);
  });

  async function seedEvent() {
    const { rows } = await pool.query(
      `INSERT INTO events (workspace_id, environment_id, topic_id, event_id, type, data, status)
       VALUES ($1, $2, $3, $4, 'order.created', '{"id":1}'::jsonb, 'received') RETURNING id`,
      [workspaceId, environmentId, topicInternalId, `evt_${randomUUID().slice(0, 12)}`],
    );
    return rows[0].id as string;
  }

  const deliveryUrls = async () =>
    (
      await pool.query(
        "SELECT url FROM messages WHERE workspace_id = $1 ORDER BY url, created_at",
        [workspaceId],
      )
    ).rows.map((r) => r.url as string);

  it("delivers once per subscription on the first pass", async () => {
    const eventInternalId = await seedEvent();

    await worker.fanOut(eventInternalId, workspaceId);

    expect(await deliveryUrls()).toEqual([
      "https://alpha.subscriber.test/hook",
      "https://beta.subscriber.test/hook",
    ]);
    const { rows } = await pool.query("SELECT status, subscription_count FROM events WHERE id = $1", [
      eventInternalId,
    ]);
    expect(rows[0].status).toBe("fanned_out");
    expect(rows[0].subscription_count).toBe(2);
  });

  it("does not deliver a subscription twice when a partial fan-out is replayed", async () => {
    const eventInternalId = await seedEvent();

    await worker.fanOut(eventInternalId, workspaceId);
    await pool.query("UPDATE events SET status = 'received' WHERE id = $1", [eventInternalId]);

    await worker.fanOut(eventInternalId, workspaceId);

    expect(await deliveryUrls()).toEqual([
      "https://alpha.subscriber.test/hook",
      "https://beta.subscriber.test/hook",
    ]);
    const { rows } = await pool.query("SELECT status, subscription_count FROM events WHERE id = $1", [
      eventInternalId,
    ]);
    expect(rows[0].status).toBe("fanned_out");
    expect(rows[0].subscription_count).toBe(2);
  });

  it("still delivers a subscription that was added between the crash and the replay", async () => {
    const eventInternalId = await seedEvent();
    await worker.fanOut(eventInternalId, workspaceId);
    await pool.query("UPDATE events SET status = 'received' WHERE id = $1", [eventInternalId]);

    await pool.query(
      `INSERT INTO event_subscriptions (workspace_id, environment_id, topic_id, subscription_id, url)
       VALUES ($1, $2, $3, $4, 'https://gamma.subscriber.test/hook')`,
      [workspaceId, environmentId, topicInternalId, `sub_${randomUUID().slice(0, 12)}`],
    );

    await worker.fanOut(eventInternalId, workspaceId);

    expect(await deliveryUrls()).toEqual([
      "https://alpha.subscriber.test/hook",
      "https://beta.subscriber.test/hook",
      "https://gamma.subscriber.test/hook",
    ]);
    await pool.query("DELETE FROM event_subscriptions WHERE url = 'https://gamma.subscriber.test/hook'");
  });
});
