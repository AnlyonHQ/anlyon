import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const destination = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; headers: Record<string, string>; body: string }>,
  answer: (_attempt: number): number => 200,
}));

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return {
    ...actual,
    safeFetch: vi.fn(async (url: string, init?: RequestInit) => {
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      destination.calls.push({ url, headers, body: String(init?.body ?? "") });
      const status = destination.answer(destination.calls.length);
      return new Response(status < 400 ? '{"ok":true}' : '{"error":"down"}', { status });
    }),
  };
});

const DATABASE_URL = process.env.DATABASE_URL ?? "";

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("event webhook: retries, DLQ and replay (real stack)", () => {
  let pool: Pool;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let redisLib: typeof import("../src/lib/redis.ts");
  let consumer: typeof import("../src/core/messaging/consumer.ts");
  let batch: typeof import("../src/lib/batch-writer.ts");
  let crypto: typeof import("../src/utils/crypto.ts");
  let worker: { fanOut: (eventInternalId: string, workspaceId: string) => Promise<void> };

  let userId: string;
  let workspaceId: string;
  let environmentId: string;
  let apiKey: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = (await import("../src/api/index.ts")).default as typeof app;
    redisLib = await import("../src/lib/redis.ts");
    consumer = await import("../src/core/messaging/consumer.ts");
    batch = await import("../src/lib/batch-writer.ts");
    crypto = await import("../src/utils/crypto.ts");
    const keys = await import("../src/core/auth/api-keys.ts");
    const envSvc = await import("../src/core/environments/service.ts");
    const { EventsFanoutWorker } = await import("../src/workers/events.ts");
    worker = new EventsFanoutWorker(0) as unknown as typeof worker;

    userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'T', $2, true, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('W', $1, 'enterprise') RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    environmentId = (await envSvc.ensureDefaultEnvironment(workspaceId)).id;
    apiKey = (await keys.createApiKey(workspaceId, userId, "events", undefined, undefined, environmentId)).key;
  }, 60_000);

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
      await redisLib.redis.del(
        redisLib.RedisKeys.dlqSet(workspaceId),
        redisLib.RedisKeys.processingSet(workspaceId),
        redisLib.RedisKeys.pendingStream(workspaceId),
      );
    }
    await pool?.end().catch(() => {});
  });

  beforeEach(() => {
    destination.calls.length = 0;
  });

  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await app.request(path, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: await res.json() };
  };

  const messageState = async (messageId: string) =>
    (await redisLib.redis.hgetall(redisLib.RedisKeys.message(workspaceId, messageId))) as unknown as
      import("../src/core/messaging/consumer.ts").MessageData;

  const row = async (messageId: string) => {
    await batch.flushMessageUpdates();
    return (
      await pool.query("SELECT status, attempts, max_retries, event_id, event_subscription_id FROM messages WHERE message_id = $1", [messageId])
    ).rows[0] as { status: string; attempts: number; max_retries: number; event_id: string | null; event_subscription_id: string | null };
  };

  const signedWith = (secret: string, sent: { headers: Record<string, string>; body: string }) => {
    const header = sent.headers["Anlyon-Signature"];
    const timestamp = Number(sent.headers["Anlyon-Timestamp"]);
    return header === crypto.signDeliveryPayloadForEnvironment(sent.body, secret, environmentId, timestamp);
  };

  it("publishes, retries with backoff, dead-letters, lists, replays and delivers", async () => {
    const host = `hooks-${randomUUID().slice(0, 8)}.receiver.test`;
    const topic = `orders-${randomUUID().slice(0, 6)}`;
    expect((await call("/api/v2/events/topics", { method: "POST", body: { name: topic } })).status).toBe(201);
    const subscribed = await call(`/api/v2/events/topics/${topic}/subscriptions`, {
      method: "POST",
      body: { url: `https://${host}/anlyon`, generateSecret: true },
    });
    expect(subscribed.status).toBe(201);
    const secret = subscribed.body.data.secret as string;
    expect(secret).toMatch(/^whsec_/);

    const published = await call("/api/v2/events", {
      method: "POST",
      body: { topic, type: "order.created", data: { orderId: "ord_1", total: 42 } },
    });
    expect(published.status).toBe(202);
    const { rows: [event] } = await pool.query(
      "SELECT id, event_id FROM events WHERE workspace_id = $1 AND type = 'order.created' ORDER BY created_at DESC LIMIT 1",
      [workspaceId],
    );
    await worker.fanOut(event.id, workspaceId);
    const { rows: [{ message_id: messageId }] } = await pool.query(
      "SELECT message_id FROM messages WHERE workspace_id = $1 AND event_id = $2",
      [workspaceId, event.id],
    );
    const before = await row(messageId);
    expect(before.event_subscription_id).not.toBeNull();
    const maxRetries = before.max_retries;
    expect(maxRetries).toBeGreaterThan(1);

    destination.answer = (n) => (n <= 3 ? 503 : 404);
    const delaysSeconds: number[] = [];
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const state = await messageState(messageId);
      expect(Number(state.attempts)).toBe(attempt - 1);
      const now = Math.floor(Date.now() / 1000);
      await consumer.deliverMessage(state);
      expect(destination.calls).toHaveLength(attempt);
      expect(destination.calls[attempt - 1].headers["X-Delivery-Attempt"]).toBe(String(attempt));
      expect(signedWith(secret, destination.calls[attempt - 1])).toBe(true);
      if (attempt < maxRetries) {
        const score = await redisLib.redis.zscore(redisLib.RedisKeys.processingSet(workspaceId), messageId);
        expect(score).not.toBeNull();
        delaysSeconds.push(Number(score) - now);
        expect((await row(messageId)).status).toBe("processing");
      }
    }
    for (let i = 1; i < delaysSeconds.length; i++) expect(delaysSeconds[i]).toBeGreaterThanOrEqual(delaysSeconds[i - 1]);
    expect(delaysSeconds[0]).toBeGreaterThanOrEqual(1);
    expect(delaysSeconds.at(-1)!).toBeGreaterThan(delaysSeconds[0] * 4);

    const failed = await row(messageId);
    expect(failed).toMatchObject({ status: "failed", attempts: maxRetries });
    expect(await redisLib.redis.zscore(redisLib.RedisKeys.dlqSet(workspaceId), messageId)).not.toBeNull();
    expect(await redisLib.redis.exists(redisLib.RedisKeys.message(workspaceId, messageId))).toBe(0);

    const listed = await call("/api/v2/dlq");
    expect(listed.status).toBe(200);
    const entry = (listed.body.data as Array<{ messageId: string; url: string; attempts: number; responseStatus: number }>)
      .find((m) => m.messageId === messageId);
    expect(entry).toMatchObject({ url: `https://${host}/anlyon`, attempts: maxRetries, responseStatus: 404 });

    const replayed = await call(`/api/v2/dlq/${messageId}/retry`, { method: "POST" });
    expect(replayed.status).toBe(200);
    expect(replayed.body.data.messageId).toBe(messageId);
    expect((await row(messageId)).status).toBe("pending");
    expect(await redisLib.redis.zscore(redisLib.RedisKeys.dlqSet(workspaceId), messageId)).toBeNull();

    destination.answer = () => 200;
    const restored = await messageState(messageId);
    expect(restored).toMatchObject({ attempts: "0", environmentId, eventId: event.id });
    await consumer.deliverMessage(restored);

    const delivered = destination.calls.at(-1)!;
    expect(destination.calls).toHaveLength(maxRetries + 1);
    expect(delivered.url).toBe(`https://${host}/anlyon`);
    expect(delivered.headers["X-Delivery-Attempt"]).toBe("1");
    expect(signedWith(secret, delivered)).toBe(true);
    expect(JSON.parse(delivered.body)).toMatchObject({
      id: event.event_id, topic, type: "order.created", data: { orderId: "ord_1", total: 42 },
    });
    expect(await row(messageId)).toMatchObject({ status: "delivered", attempts: 1 });

    const after = await call("/api/v2/dlq");
    expect((after.body.data as Array<{ messageId: string }>).some((m) => m.messageId === messageId)).toBe(false);
  });
});
