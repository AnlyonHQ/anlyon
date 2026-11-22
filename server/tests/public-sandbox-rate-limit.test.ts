import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const counters = vi.hoisted(() => new Map<string, number>());

vi.mock("../src/lib/redis.ts", () => ({
  redis: {
    incr: async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    expire: async () => 1,
  },
  RedisKeys: {},
}));
vi.mock("../src/lib/resend-client.ts", () => ({ resendClient: {} }));
vi.mock("../src/lib/workspace-cache.ts", () => ({ getWorkspaceCached: vi.fn() }));
vi.mock("../src/api/middleware/rateLimit.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/middleware/rateLimit.ts")>();
  return { ...actual, rateLimitByWorkspace: async (_c: unknown, next: () => Promise<void>) => next() };
});
vi.mock("../src/api/middleware/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/middleware/auth.ts")>();
  return {
    ...actual,
    requireSessionOnly: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set("authType", "session");
      c.set("workspaceId", "ws_mint");
      await next();
    },
  };
});

const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const { default: publicSandboxRouter, rateLimitPublic } = await import("../src/api/routes/public-sandbox.ts");
const { default: sandboxRouter } = await import("../src/api/routes/sandbox.ts");
const { mintSandboxToken, verifySandboxToken } = await import("../src/core/sandbox/token.ts");
const { env } = await import("../src/config/env.ts");

const IP_LIMIT = Math.floor(Number(env.RATE_LIMIT_MAX ?? 100) / 2);
const EGRESS_IP = "203.0.113.9";

function app(): Hono {
  const root = new Hono();
  root.onError((caught, c) => buildErrorResponse(caught, c));
  root.use("/api/v2/public/*", rateLimitPublic);
  root.get("/api/v2/public/pricing-policy", (c) => c.json({ success: true }));
  root.route("/api/v2/public/sandbox", publicSandboxRouter);
  root.route("/api/v2/sandbox", sandboxRouter);
  return root;
}

function echo(a: Hono, authorization?: string, ip = EGRESS_IP) {
  return a.request("/api/v2/public/sandbox/echo", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({ orderId: "ord_1042", amount: 4900 }),
  });
}

beforeEach(() => counters.clear());

describe("sandbox tokens", () => {
  it("verify to the workspace they were minted for, and each is new", () => {
    const token = mintSandboxToken("ws_123");
    expect(token).toMatch(/^demo_sk_v1\./);
    expect(verifySandboxToken(token)).toBe("ws_123");
    expect(mintSandboxToken("ws_123")).not.toBe(token);
  });

  it("are refused when tampered with, truncated or made up", () => {
    const token = mintSandboxToken("ws_123");
    const [prefix, , nonce, signature] = token.split(".");
    const other = Buffer.from("ws_victim").toString("base64url");
    expect(verifySandboxToken(`${prefix}.${other}.${nonce}.${signature}`)).toBeNull();
    expect(verifySandboxToken(token.slice(0, -2))).toBeNull();
    expect(verifySandboxToken(`${token}x`)).toBeNull();
    expect(verifySandboxToken(`${prefix}.${other}.${nonce}.${"A".repeat(43)}`)).toBeNull();
    expect(verifySandboxToken("demo_sk_abcdefghijkmnpqrstuvwxyz23")).toBeNull();
    expect(verifySandboxToken("x".repeat(10_000))).toBeNull();
  });
});

describe("sandbox echo rate limit", () => {
  it("does not throttle many workspaces' tour calls together behind one egress IP", async () => {
    const a = app();
    const workspaces = Array.from({ length: IP_LIMIT + 10 }, (_, i) => `ws_${i}`);
    for (const workspaceId of workspaces) {
      const token = mintSandboxToken(workspaceId);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await echo(a, `Bearer ${token}`);
        expect(response.status).toBe(200);
      }
    }
    const token = mintSandboxToken("ws_last");
    expect((await (await echo(a, `Bearer ${token}`)).json()).data.authorization).toBe(`Bearer ${token}`);
  });

  it("still limits one workspace on its own, without touching the others", async () => {
    const a = app();
    const noisy = mintSandboxToken("ws_noisy");
    for (let i = 0; i < IP_LIMIT; i++) expect((await echo(a, `Bearer ${noisy}`)).status).toBe(200);
    expect((await echo(a, `Bearer ${noisy}`)).status).toBe(429);
    expect((await echo(a, `Bearer ${mintSandboxToken("ws_noisy")}`)).status).toBe(429);
    expect((await echo(a, `Bearer ${mintSandboxToken("ws_quiet")}`)).status).toBe(200);
    expect((await echo(a)).status).toBe(200);
  });

  it("limits anonymous callers by IP", async () => {
    const a = app();
    for (let i = 0; i < IP_LIMIT; i++) expect((await echo(a)).status).toBe(200);
    const limited = await echo(a);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect((await echo(a, undefined, "198.51.100.7")).status).toBe(200);
  });

  it("counts a forged or invalid token against the IP bucket", async () => {
    const a = app();
    const real = mintSandboxToken("ws_real").split(".");
    const forgeries = [
      "Bearer demo_sk_abcdefghijkmnpqrstuvwxyz23",
      `Bearer ${real[0]}.${Buffer.from("ws_other").toString("base64url")}.${real[2]}.${real[3]}`,
      `Bearer ${real.slice(0, 3).join(".")}.${"B".repeat(43)}`,
      "Basic d3NfcmVhbDpzZWNyZXQ=",
    ];
    for (let i = 0; i < IP_LIMIT; i++) {
      expect((await echo(a, forgeries[i % forgeries.length])).status).toBe(200);
    }
    for (const forged of forgeries) expect((await echo(a, forged)).status).toBe(429);
    expect((await echo(a)).status).toBe(429);
    expect((await echo(a, `Bearer ${mintSandboxToken("ws_real")}`)).status).toBe(200);
  });

  it("keeps other public routes on the IP bucket even with a valid token", async () => {
    const a = app();
    const auth = { Authorization: `Bearer ${mintSandboxToken("ws_1")}`, "X-Forwarded-For": EGRESS_IP };
    for (let i = 0; i < IP_LIMIT; i++) {
      expect((await a.request("/api/v2/public/pricing-policy", { headers: auth })).status).toBe(200);
    }
    expect((await a.request("/api/v2/public/pricing-policy", { headers: auth })).status).toBe(429);
  });

  it("keeps the 16 KB cap for signed calls", async () => {
    const response = await app().request("/api/v2/public/sandbox/echo", {
      method: "POST",
      headers: { Authorization: `Bearer ${mintSandboxToken("ws_1")}`, "X-Forwarded-For": EGRESS_IP },
      body: "x".repeat(16 * 1024 + 1),
    });
    expect(response.status).toBe(413);
  });
});

describe("POST /api/v2/sandbox/token", () => {
  it("mints a token signed for the calling workspace", async () => {
    const response = await app().request("/api/v2/sandbox/token", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { data } = await response.json();
    expect(verifySandboxToken(data.token)).toBe("ws_mint");
  });
});
