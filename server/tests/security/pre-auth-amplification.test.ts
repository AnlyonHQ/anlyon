import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ redisReads: 0, dbSelects: 0, dbUpdates: 0, redisPings: 0, dbExecutes: 0 }));
const cachedKey = vi.hoisted(() => ({ value: {} as Record<string, string> }));

vi.mock("../../src/lib/redis.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/redis.ts")>()),
  redis: {
    hgetall: async () => { calls.redisReads++; return cachedKey.value; },
    hset: async () => 1,
    expire: async () => 1,
  },
  checkRedisHealth: async () => { calls.redisPings++; return true; },
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => { calls.dbSelects++; return []; } }) }),
    update: () => ({ set: () => ({ where: () => { calls.dbUpdates++; return Promise.resolve(); } }) }),
    execute: async () => { calls.dbExecutes++; return []; },
  },
}));

const { verifyApiKeyAndGetWorkspace, resetApiKeyCachesForTests } = await import("../../src/core/auth/api-keys.ts");
const { default: health } = await import("../../src/api/routes/health.ts");

beforeEach(() => {
  Object.assign(calls, { redisReads: 0, dbSelects: 0, dbUpdates: 0, redisPings: 0, dbExecutes: 0 });
  cachedKey.value = {};
  resetApiKeyCachesForTests();
});

describe("a flood of requests with one bogus API key", () => {
  it("reaches Redis and Postgres once, not once per request", async () => {
    for (let i = 0; i < 100; i++) {
      await expect(verifyApiKeyAndGetWorkspace("anlyon_live_not_a_real_key")).rejects.toThrow("Authentication failed");
    }
    expect(calls.redisReads).toBe(1);
    expect(calls.dbSelects).toBe(1);
  });

  it("still checks each distinct key", async () => {
    await verifyApiKeyAndGetWorkspace("anlyon_live_a").catch(() => {});
    await verifyApiKeyAndGetWorkspace("anlyon_live_b").catch(() => {});
    expect(calls.dbSelects).toBe(2);
  });
});

describe("a valid API key used repeatedly", () => {
  it("writes lastUsedAt once per interval, not once per request", async () => {
    cachedKey.value = {
      workspaceId: "ws_1", keyId: "key_1", environmentId: "env_1",
      isActive: "true", expiresAt: "", scopes: JSON.stringify(["messages:read"]), endUserRequired: "false",
    };
    for (let i = 0; i < 100; i++) {
      await expect(verifyApiKeyAndGetWorkspace("anlyon_live_valid")).resolves.toMatchObject({ keyId: "key_1" });
    }
    expect(calls.dbUpdates).toBe(1);
  });
});

describe("GET /health/ready", () => {
  it("probes Redis and Postgres at most once per cache window", async () => {
    for (let i = 0; i < 50; i++) {
      const response = await health.request("/ready");
      expect(response.status).toBe(200);
    }
    expect(calls.redisPings).toBe(1);
    expect(calls.dbExecutes).toBe(1);
  });
});

describe("TtlCache", async () => {
  const { TtlCache } = await import("../../src/lib/ttl-cache.ts");

  it("expires entries after their lifetime", () => {
    let now = 0;
    const cache = new TtlCache<true>({ ttlMs: 1000, maxEntries: 10, now: () => now });
    cache.set("k", true);
    now = 999;
    expect(cache.has("k")).toBe(true);
    now = 1000;
    expect(cache.has("k")).toBe(false);
  });

  it("never grows past its bound, evicting the oldest first", () => {
    const cache = new TtlCache<true>({ ttlMs: 60_000, maxEntries: 3 });
    for (const k of ["a", "b", "c", "d"]) cache.set(k, true);
    expect(cache.size).toBe(3);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("d")).toBe(true);
  });
});
