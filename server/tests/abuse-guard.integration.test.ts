import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

process.env.REQUIRE_EMAIL_VERIFICATION = "true";

vi.mock("../src/lib/safe-http.ts", () => {
  class SsrfBlockedError extends Error {}
  return {
    SsrfBlockedError,
    safeFetch: vi.fn(async () => new Response("ok", { status: 200 })),
  };
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

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("abuse defenses (real Postgres + Redis)", () => {
  let pool: Pool;
  let guard: typeof import("../src/core/messaging/abuse-guard.ts");
  let consumer: typeof import("../src/core/messaging/consumer.ts");
  let redisLib: typeof import("../src/lib/redis.ts");
  let safeHttp: { safeFetch: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    guard = await import("../src/core/messaging/abuse-guard.ts");
    consumer = await import("../src/core/messaging/consumer.ts");
    redisLib = await import("../src/lib/redis.ts");
    safeHttp = (await import("../src/lib/safe-http.ts")) as unknown as {
      safeFetch: ReturnType<typeof vi.fn>;
    };
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  beforeEach(() => safeHttp.safeFetch.mockClear());

  async function seedWorkspace(plan = "free"): Promise<string> {
    const ws = await pool.query(
      `INSERT INTO workspaces (name, slug, plan) VALUES ('WS', $1, $2) RETURNING id`,
      [`ws-${randomUUID().slice(0, 8)}`, plan],
    );
    return ws.rows[0].id as string;
  }

  it("trips the quarantine on the spam-relay profile, not on one broken endpoint", async () => {
    const honest = await seedWorkspace();
    for (let i = 0; i < 600; i++) {
      await guard.trackDeliveryOutcome(honest, "https://one-broken-host.example.com/hook", false);
    }
    expect(await guard.isWorkspaceSuspended(honest)).toBe(false);

    const relay = await seedWorkspace();
    for (let i = 0; i < 600; i++) {
      await guard.trackDeliveryOutcome(relay, `https://victim-${i % 120}.example.com/x`, i % 10 === 0);
    }
    expect(await guard.isWorkspaceSuspended(relay)).toBe(true);

    const row = await pool.query(
      `SELECT delivery_suspended_reason FROM workspaces WHERE id = $1`,
      [relay],
    );
    expect(row.rows[0].delivery_suspended_reason).toMatch(/failures across \d+ hosts/);

    const alert = await pool.query(
      `SELECT 1 FROM notifications WHERE workspace_id = $1 AND type = 'security_alert'`,
      [relay],
    );
    expect(alert.rowCount).toBe(1);
  });

  it("defers deliveries while suspended and delivers after resume", async () => {
    const workspaceId = await seedWorkspace();
    await guard.suspendWorkspaceDeliveries(workspaceId, "manual test");

    const environment = await pool.query(
      `INSERT INTO environments (workspace_id, name, slug, is_default)
       VALUES ($1, 'Production', 'production', true) RETURNING id`,
      [workspaceId],
    );
    const messageId = `msg_${randomUUID().slice(0, 12)}`;
    const messageData = {
      messageId,
      workspaceId,
      environmentId: environment.rows[0].id as string,
      url: "https://example.com/hook",
      method: "POST",
      headers: "{}",
      body: JSON.stringify({ x: 1 }),
      maxRetries: "3",
      attempts: "0",
    };

    await consumer.deliverMessage(messageData);
    expect(safeHttp.safeFetch).not.toHaveBeenCalled();
    const parked = await redisLib.redis.zscore(
      redisLib.RedisKeys.processingSet(workspaceId),
      messageId,
    );
    expect(parked).not.toBeNull();

    await guard.resumeWorkspaceDeliveries(workspaceId);
    await consumer.deliverMessage(messageData);
    expect(safeHttp.safeFetch).toHaveBeenCalledTimes(1);
  });

  it("re-syncs suspension flags from the DB after a Redis flush", async () => {
    const workspaceId = await seedWorkspace();
    await guard.suspendWorkspaceDeliveries(workspaceId, "sync test");

    await redisLib.redis.del(redisLib.RedisKeys.workspaceSuspended(workspaceId));
    expect(await guard.isWorkspaceSuspended(workspaceId)).toBe(false);

    const restored = await guard.syncSuspendedWorkspaces();
    expect(restored).toBeGreaterThanOrEqual(1);
    expect(await guard.isWorkspaceSuspended(workspaceId)).toBe(true);
  });

  it("free-tier publishes require a verified emergency-access admin email; paid plans do not", async () => {
    const { requireVerifiedSender } = await import("../src/api/middleware/verified-sender.ts");

    async function drive(workspaceId: string): Promise<number> {
      const app = new Hono();
      app.onError((err, c) =>
        c.json({ error: err.message }, ((err as { statusCode?: number }).statusCode ?? 500) as 403),
      );
      app.use("*", async (c, next) => {
        c.set("workspaceId" as never, workspaceId as never);
        await next();
      });
      app.post("/publish", requireVerifiedSender, (c) => c.json({ ok: true }));
      const res = await app.request("/publish", { method: "POST" });
      return res.status;
    }

    const freeWs = await seedWorkspace("free");
    const userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'U', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, emergency_access) VALUES ($1, $2, 'admin', true)`,
      [freeWs, userId],
    );
    expect(await drive(freeWs)).toBe(403);

    await pool.query(`UPDATE "user" SET email_verified = true WHERE id = $1`, [userId]);
    await redisLib.redis.del(`ws:admin-verified:${freeWs}`);
    expect(await drive(freeWs)).toBe(200);

    const paidWs = await seedWorkspace("paygo");
    const paidUser = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'P', $2, false, now(), now())`,
      [paidUser, `${paidUser}@test.dev`],
    );
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, emergency_access) VALUES ($1, $2, 'admin', true)`,
      [paidWs, paidUser],
    );
    expect(await drive(paidWs)).toBe(200);
  });
});
