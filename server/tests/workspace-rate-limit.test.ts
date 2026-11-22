import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  counters: new Map<string, number>(),
  ttls: new Map<string, number>(),
  evals: 0,
  scripts: [] as string[],
  plan: "starter",
}));

vi.mock("../src/lib/redis.ts", () => ({
  redis: {
    eval: vi.fn(async (script: string, numKeys: number, ...rest: string[]) => {
      store.evals += 1;
      store.scripts.push(script);
      const keys = rest.slice(0, numKeys);
      const [minuteTtl, hourTtl, minuteLimit] = rest.slice(numKeys).map(Number);
      const incr = (key: string, ttl: number) => {
        const next = (store.counters.get(key) ?? 0) + 1;
        store.counters.set(key, next);
        if (next === 1) store.ttls.set(key, ttl);
        return next;
      };
      const m = incr(keys[0], minuteTtl);
      const h = keys[1] && m <= minuteLimit ? incr(keys[1], hourTtl) : 0;
      return [m, h];
    }),
    incr: vi.fn(async () => {
      throw new Error("the workspace limit must not send a separate INCR");
    }),
    expire: vi.fn(async () => {
      throw new Error("the workspace limit must not send a separate EXPIRE");
    }),
  },
  RedisKeys: { rateLimit: (workspaceId: string, window: string) => `workspace:${workspaceId}:ratelimit:${window}` },
}));
vi.mock("../src/lib/workspace-cache.ts", () => ({
  getWorkspaceCached: vi.fn(async (id: string) => ({ id, plan: store.plan })),
}));

const { rateLimitByWorkspace, WORKSPACE_WINDOWS_LUA } = await import("../src/api/middleware/rateLimit.ts");
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const { usePlanFixture } = await import("./support/plan-fixture.ts");
const PRICING_PLANS = {
  starter: { rateLimit: { requestsPerMinute: 1000, requestsPerHour: 30_000 } },
  growth: { rateLimit: { requestsPerMinute: 1000, requestsPerHour: 45_000 } },
  enterprise: { rateLimit: { requestsPerMinute: "unlimited" as const, requestsPerHour: "unlimited" as const } },
};
usePlanFixture(PRICING_PLANS);

const WS = "ws_rate";
const minuteKey = () => `workspace:${WS}:ratelimit:${Math.floor(Date.now() / 60_000)}`;
const hourKey = () => `workspace:${WS}:ratelimit:h${Math.floor(Date.now() / 3_600_000)}`;

function app() {
  const hono = new Hono();
  hono.onError((err, c) => buildErrorResponse(err, c));
  hono.use("*", async (c, next) => {
    c.set("workspaceId" as never, WS as never);
    await next();
  });
  hono.get("/thing", rateLimitByWorkspace, (c) => c.json({ success: true }));
  return hono;
}

afterEach(() => {
  store.counters.clear();
  store.ttls.clear();
  store.evals = 0;
  store.scripts = [];
  store.plan = "starter";
  vi.useRealTimers();
});

describe("the workspace rate limit", () => {
  it("counts both windows with one script call per request, and sets each expiry once", async () => {
    const hono = app();
    for (let i = 0; i < 3; i += 1) expect((await hono.request("/thing")).status).toBe(200);
    expect(store.evals).toBe(3);
    expect(store.scripts.every((script) => script === WORKSPACE_WINDOWS_LUA)).toBe(true);
    expect(store.counters.get(minuteKey())).toBe(3);
    expect(store.counters.get(hourKey())).toBe(3);
    expect(store.ttls.get(minuteKey())).toBe(60);
    expect(store.ttls.get(hourKey())).toBe(3600);
  });

  it("publishes both windows in X-RateLimit headers", async () => {
    const response = await app().request("/thing");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1000");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("999");
    expect(response.headers.get("X-RateLimit-Limit-Hour")).toBe("30000");
    expect(response.headers.get("X-RateLimit-Remaining-Hour")).toBe("29999");
    const reset = Number(response.headers.get("X-RateLimit-Reset-Hour"));
    expect(reset % 3_600_000).toBe(0);
    expect(reset).toBeGreaterThan(Date.now());
  });

  it("refuses a burst past the minute limit with RATE_LIMIT_EXCEEDED, and does not spend the hour on it", async () => {
    store.counters.set(minuteKey(), 1000);
    store.counters.set(hourKey(), 1000);
    const refused = await app().request("/thing");
    expect(refused.status).toBe(429);
    const body = await refused.json();
    expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(body.error.message).toMatch(/1000 requests per minute/);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(store.counters.get(hourKey())).toBe(1000);
  });

  it("refuses a sustained flood past the hour limit, naming the limit and when it resets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T13:37:10.000Z"));
    store.counters.set(hourKey(), PRICING_PLANS.starter.rateLimit.requestsPerHour as number);
    const refused = await app().request("/thing");
    expect(refused.status).toBe(429);
    const body = await refused.json();
    expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(body.error.message).toBe(
      "Hourly rate limit exceeded. Your plan allows 30,000 requests an hour; the count resets at 14:00 UTC (in 23 minutes).",
    );
    expect(refused.headers.get("Retry-After")).toBe(String(22 * 60 + 50));
    expect(refused.headers.get("X-RateLimit-Remaining-Hour")).toBe("0");
  });

  it("gives Team the higher hour limit", async () => {
    store.plan = "growth";
    store.counters.set(hourKey(), 30_000);
    const response = await app().request("/thing");
    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Limit-Hour")).toBe("45000");
  });

  it("never counts an unlimited plan", async () => {
    store.plan = "enterprise";
    expect((await app().request("/thing")).status).toBe(200);
    expect(store.evals).toBe(0);
  });
});
