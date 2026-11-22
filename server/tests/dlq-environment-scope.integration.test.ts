import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("DLQ environment scope (real stack, HTTP)", () => {
  let pool: Pool;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let keys: typeof import("../src/core/auth/api-keys.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");
  let redisLib: typeof import("../src/lib/redis.ts");

  let userId: string;
  let workspaceId: string;
  let production: { id: string };
  let staging: { id: string };
  let productionKey: string;
  let stagingKey: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = (await import("../src/api/index.ts")).default as typeof app;
    keys = await import("../src/core/auth/api-keys.ts");
    envSvc = await import("../src/core/environments/service.ts");
    redisLib = await import("../src/lib/redis.ts");

    userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'T', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('D', $1, 'enterprise') RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    production = await envSvc.ensureDefaultEnvironment(workspaceId);
    staging = await envSvc.createEnvironment(workspaceId, {
      name: "Staging",
      slug: `staging-${randomUUID().slice(0, 8)}`,
    });
    productionKey = (
      await keys.createApiKey(workspaceId, userId, "prod", undefined, undefined, production.id)
    ).key;
    stagingKey = (
      await keys.createApiKey(workspaceId, userId, "staging", undefined, undefined, staging.id)
    ).key;
  }, 60_000);

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
      await redisLib.redis.del(redisLib.RedisKeys.dlqSet(workspaceId));
    }
    await pool?.end().catch(() => {});
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM messages WHERE workspace_id = $1", [workspaceId]);
    await redisLib.redis.del(redisLib.RedisKeys.dlqSet(workspaceId));
    await redisLib.redis.del(redisLib.RedisKeys.pendingStream(workspaceId));
  });

  async function seedFailed(
    environmentId: string,
    opts: { url?: string; queueId?: string } = {},
  ) {
    const messageId = `msg_${randomUUID().slice(0, 16)}`;
    await pool.query(
      `INSERT INTO messages (workspace_id, environment_id, message_id, url, method, status, attempts, max_retries, failed_at, error_message, queue_id)
       VALUES ($1, $2, $3, $4, 'POST', 'failed', 3, 3, now(), 'connection refused', $5)`,
      [
        workspaceId,
        environmentId,
        messageId,
        opts.url ?? "https://example.test/hook",
        opts.queueId ?? null,
      ],
    );
    await redisLib.redis.zadd(redisLib.RedisKeys.dlqSet(workspaceId), Date.now(), messageId);
    return messageId;
  }

  const authed = (key: string, init: RequestInit = {}) => ({
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

  it("lists only the calling environment's failed messages", async () => {
    await seedFailed(production.id, { url: "https://production.test/secret-path" });
    await seedFailed(staging.id, { url: "https://staging.test/hook" });

    const res = await app.request("/api/v2/dlq", authed(stagingKey));
    expect(res.status).toBe(200);
    const body = await res.json();
    const urls = body.data.map((m: { url: string }) => m.url);
    expect(urls).toEqual(["https://staging.test/hook"]);
  });

  it("counts only the calling environment in DLQ statistics", async () => {
    await seedFailed(production.id);
    await seedFailed(production.id);
    await seedFailed(staging.id);

    const res = await app.request("/api/v2/dlq/stats", authed(stagingKey));
    expect((await res.json()).data.totalFailed).toBe(1);
  });

  it("cannot read another environment's failed message by id", async () => {
    const messageId = await seedFailed(production.id);

    const res = await app.request(`/api/v2/dlq/${messageId}`, authed(stagingKey));
    expect(res.status).toBe(404);
  });

  it("cannot replay another environment's failed message", async () => {
    const messageId = await seedFailed(production.id);

    const res = await app.request(
      `/api/v2/dlq/${messageId}/retry`,
      authed(stagingKey, { method: "POST" }),
    );
    expect(res.status).toBe(404);

    const { rows } = await pool.query("SELECT status FROM messages WHERE message_id = $1", [messageId]);
    expect(rows[0].status).toBe("failed");
  });

  it("cannot delete another environment's failed message", async () => {
    const messageId = await seedFailed(production.id);

    const res = await app.request(`/api/v2/dlq/${messageId}`, authed(stagingKey, { method: "DELETE" }));
    expect(res.status).toBe(404);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM messages WHERE message_id = $1", [
      messageId,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it("retries only the calling environment's failures, and reports what is left", async () => {
    const productionMessage = await seedFailed(production.id);
    await seedFailed(staging.id);
    await seedFailed(staging.id);

    const retried = await app.request("/api/v2/dlq/retry-all", authed(stagingKey, { method: "POST" }));
    const retriedBody = (await retried.json()).data;
    expect(retriedBody.retriedCount).toBe(2);
    expect(retriedBody.remaining).toBe(0);

    const { rows } = await pool.query("SELECT status FROM messages WHERE message_id = $1", [
      productionMessage,
    ]);
    expect(rows[0].status).toBe("failed");
  });

  it("clears only the calling environment's failures", async () => {
    const productionMessage = await seedFailed(production.id);
    await seedFailed(staging.id);
    await seedFailed(staging.id);

    const cleared = await app.request("/api/v2/dlq", authed(stagingKey, { method: "DELETE" }));
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()).data;
    expect(clearedBody.deletedCount).toBe(2);
    expect(clearedBody.remaining).toBe(0);

    const { rows } = await pool.query("SELECT status FROM messages WHERE message_id = $1", [
      productionMessage,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    const stats = await app.request("/api/v2/dlq/stats", authed(productionKey));
    expect((await stats.json()).data.totalFailed).toBe(1);
  });

  it("restores the environment and queue a replayed message was published under", async () => {
    const queue = await pool.query(
      `INSERT INTO queues (workspace_id, environment_id, queue_id, name) VALUES ($1, $2, $3, 'orders') RETURNING id, queue_id`,
      [workspaceId, staging.id, `que_${randomUUID().slice(0, 12)}`],
    );
    const messageId = await seedFailed(staging.id, {
      queueId: queue.rows[0].id,
    });

    const res = await app.request(
      `/api/v2/dlq/${messageId}/retry`,
      authed(stagingKey, { method: "POST" }),
    );
    expect(res.status).toBe(200);

    const restored = await redisLib.redis.hgetall(redisLib.RedisKeys.message(workspaceId, messageId));
    expect(restored.environmentId).toBe(staging.id);
    expect(restored.queueId).toBe(queue.rows[0].queue_id);

    const queueStream = await redisLib.redis.xlen(
      redisLib.RedisKeys.queuePendingStream(workspaceId, queue.rows[0].queue_id),
    );
    expect(queueStream).toBe(1);
    expect(await redisLib.redis.xlen(redisLib.RedisKeys.pendingStream(workspaceId))).toBe(0);
    await redisLib.redis.del(
      redisLib.RedisKeys.queuePendingStream(workspaceId, queue.rows[0].queue_id),
    );
  });
});
