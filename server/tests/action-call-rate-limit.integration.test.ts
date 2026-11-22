import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const destination = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return {
    ...actual,
    safeFetch: (...args: unknown[]) => {
      destination(...args);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    },
  };
});

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const PER_MINUTE = 3;

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("rate limit on action calls (real stack, HTTP)", () => {
  let pool: Pool;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let redisLib: typeof import("../src/lib/redis.ts");
  let userId: string;
  let workspaceId: string;
  let key: string;
  const actionName = `ping-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const { usePlanFixture } = await import("./support/plan-fixture.ts");
    usePlanFixture({ "*": { rateLimit: { requestsPerMinute: PER_MINUTE, requestsPerHour: 1_000 } } });
    app = (await import("../src/api/index.ts")).default as typeof app;
    redisLib = await import("../src/lib/redis.ts");
    const keys = await import("../src/core/auth/api-keys.ts");
    const scopes = await import("../src/core/auth/api-key-scopes.ts");
    const envSvc = await import("../src/core/environments/service.ts");
    const actionSvc = await import("../src/core/actions/service.ts");

    userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'T', $2, true, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('R', $1) RETURNING id`, [`ws-${randomUUID().slice(0, 8)}`])
    ).rows[0].id;
    const environmentId = (await envSvc.ensureDefaultEnvironment(workspaceId)).id;
    await actionSvc.createAction(workspaceId, {
      name: actionName, method: "POST", urlTemplate: "https://api.ping.test/ping",
    }, actionSvc.UNSCOPED_AUTHORITY, environmentId);
    key = (await keys.createApiKey(workspaceId, userId, "agent", undefined, [...scopes.DEFAULT_API_KEY_SCOPES], environmentId)).key;
  }, 60_000);

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
      await redisLib.redis.del(redisLib.RedisKeys.workspaceCache(workspaceId));
    }
    await pool?.end().catch(() => {});
  });

  const invoke = () =>
    app.request(`/api/v2/actions/${actionName}/invoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });

  it("refuses the call past the minute's limit with 429 and Retry-After, and the refused call never goes out", async () => {
    const intoMinute = Date.now() % 60_000;
    if (intoMinute > 45_000) await new Promise((resolve) => setTimeout(resolve, 60_000 - intoMinute + 100));

    for (let i = 0; i < PER_MINUTE; i++) {
      const res = await invoke();
      expect(res.status).toBe(200);
    }
    expect(destination).toHaveBeenCalledTimes(PER_MINUTE);

    const refused = await invoke();
    expect(refused.status).toBe(429);
    const retryAfter = Number(refused.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect((await refused.json()).error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(destination).toHaveBeenCalledTimes(PER_MINUTE);
  });
});
