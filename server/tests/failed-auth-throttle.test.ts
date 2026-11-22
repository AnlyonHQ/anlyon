import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono, type Context } from "hono";
import { NotFoundError } from "../src/utils/errors.ts";

const store = vi.hoisted(() => new Map<string, number>());
const redis = vi.hoisted(() => ({
  status: "ready",
  mget: vi.fn(),
  pipeline: vi.fn(),
}));
const getSession = vi.hoisted(() => vi.fn());
const verifyApiKey = vi.hoisted(() => vi.fn());
const getEnvironment = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/redis.ts", () => ({ redis, RedisKeys: {} }));
vi.mock("../src/lib/workspace-cache.ts", () => ({ getWorkspaceCached: vi.fn() }));
vi.mock("../src/utils/auth.ts", () => ({ auth: { api: { getSession } } }));
vi.mock("../src/core/auth/api-keys.ts", () => ({ verifyApiKeyAndGetWorkspace: verifyApiKey }));
vi.mock("../src/core/auth/oauth-tokens.ts", () => ({ looksLikeJwt: () => false, verifyOAuthAccessToken: vi.fn() }));
vi.mock("../src/core/workspace/service.ts", () => ({ hasWorkspaceAccess: async () => true }));
vi.mock("../src/core/environments/service.ts", () => ({ getEnvironment, getDefaultEnvironment: async () => ({ id: "env_default" }) }));
vi.mock("../src/core/sso/sessions.ts", () => ({ assertSsoSessionForWorkspace: async () => undefined }));

const { rateLimitFailedAuthByIp } = await import("../src/api/middleware/rateLimit.ts");
const { requireApiKey } = await import("../src/api/middleware/auth.ts");
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const { markCredentialRejected } = await import("../src/api/credential-rejection.ts");
const { mcpUnauthorized, MCP_RESOURCE_METADATA_URL } = await import("../src/api/mcp-challenge.ts");
const { AuthenticationError } = await import("../src/utils/errors.ts");

const IP = "203.0.113.9";
const WS = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const addressKey = () => `ratelimit:authfail:${IP}:${Math.floor(Date.now() / 60000)}`;

const mcpRoute = vi.fn(async (c: Context) => {
  markCredentialRejected(c);
  return mcpUnauthorized("invalid access token");
});

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.use("/api/v2/*", rateLimitFailedAuthByIp);
app.use("/mcp", rateLimitFailedAuthByIp);
app.use("/api/v2/*", requireApiKey);
app.get("/api/v2/things", (c) => c.json({ success: true }));
app.post("/mcp", mcpRoute);

const call = (path: string, headers: Record<string, string>, method = "GET") =>
  app.request(path, { method, headers: { "x-forwarded-for": IP, ...headers } });
const withKey = (key: string) => call("/api/v2/things", { Authorization: `Bearer ${key}` });

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  redis.status = "ready";
  redis.mget.mockImplementation(async (...keys: string[]) => keys.map((key) => (store.has(key) ? String(store.get(key)) : null)));
  redis.pipeline.mockImplementation(() => {
    const ops: Array<() => number> = [];
    const pipeline = {
      incr(key: string) {
        ops.push(() => {
          const next = (store.get(key) ?? 0) + 1;
          store.set(key, next);
          return next;
        });
        return pipeline;
      },
      expire() {
        ops.push(() => 1);
        return pipeline;
      },
      exec: async () => ops.map((op) => [null, op()]),
    };
    return pipeline;
  });
  getSession.mockResolvedValue(null);
  getEnvironment.mockImplementation(async (_ws: string, id: string) => ({ id }));
  verifyApiKey.mockImplementation(async (key: string) => {
    if (key === "anlyon_live_good") return { workspaceId: WS, environmentId: ENV, keyId: "key_1", scopes: [], expiresAt: null };
    throw new AuthenticationError("Authentication failed");
  });
});

describe("the address cap", () => {
  it("never refuses a valid credential, however many bad ones came from the same address", async () => {
    store.set(addressKey(), 10_000);
    const res = await withKey("anlyon_live_good");
    expect(res.status).toBe(200);
    expect(verifyApiKey).toHaveBeenCalledOnce();
    expect(store.get(addressKey())).toBe(10_000);
  });

  it("answers a refused credential from an address over its cap with the same 401, after a delay", async () => {
    store.set(addressKey(), 300);
    const started = Date.now();
    const res = await withKey("anlyon_live_guess");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("AUTHENTICATION_ERROR");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
});

describe("what counts as a failed authentication", () => {
  it("a refused key counts, and after ten refusals it is refused without being looked up", async () => {
    for (let i = 0; i < 10; i++) expect((await withKey("anlyon_live_revoked")).status).toBe(401);
    expect(verifyApiKey).toHaveBeenCalledTimes(10);
    expect(store.get(addressKey())).toBe(10);

    const res = await withKey("anlyon_live_revoked");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("AUTHENTICATION_ERROR");
    expect(verifyApiKey).toHaveBeenCalledTimes(10);
    expect((await withKey("anlyon_live_good")).status).toBe(200);
  });

  it("a database or Redis failure during key lookup is a 503 and is not counted", async () => {
    verifyApiKey.mockRejectedValue(new Error("Connection terminated due to connection timeout"));
    for (let i = 0; i < 12; i++) expect((await withKey("anlyon_live_good")).status).toBe(503);
    expect(verifyApiKey).toHaveBeenCalledTimes(12);
    expect(store.size).toBe(0);

    verifyApiKey.mockResolvedValue({ workspaceId: WS, environmentId: ENV, keyId: "key_1", scopes: [], expiresAt: null });
    expect((await withKey("anlyon_live_good")).status).toBe(200);
  });

  it("a session store failure is a 503 and is not counted", async () => {
    getSession.mockRejectedValue(new Error("connect ETIMEDOUT"));
    const res = await call("/api/v2/things", { Cookie: "better-auth.session_token=abc", "X-Workspace-Id": WS });
    expect(res.status).toBe(503);
    expect(store.size).toBe(0);
  });

  it("a stale X-Environment-Id on a valid session is a 404, not counted as a bad credential", async () => {
    getSession.mockResolvedValue({ user: { id: "user_1", email: "a@example.com" }, session: { id: "s_1" } });
    getEnvironment.mockRejectedValue(new NotFoundError("Environment not found"));
    const res = await call("/api/v2/things", { Cookie: "better-auth.session_token=abc", "X-Workspace-Id": WS, "X-Environment-Id": ENV });
    expect(res.status).toBe(404);
    expect(store.size).toBe(0);
  });

  it("a cookie with no session behind it counts", async () => {
    const res = await call("/api/v2/things", { Cookie: "better-auth.session_token=expired" });
    expect(res.status).toBe(401);
    expect(store.get(addressKey())).toBe(1);
  });

  it("a request with no credential is never counted", async () => {
    expect((await call("/api/v2/things", {})).status).toBe(401);
    expect(redis.mget).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });
});

describe("a credential over its limit on /mcp", () => {
  it("gets the 401 with WWW-Authenticate that sends an MCP client to re-authorize, not a 429", async () => {
    const send = () => call("/mcp", { Authorization: "Bearer aaa.bbb.ccc" }, "POST");
    for (let i = 0; i < 10; i++) expect((await send()).status).toBe(401);
    expect(mcpRoute).toHaveBeenCalledTimes(10);

    const res = await send();
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${MCP_RESOURCE_METADATA_URL}"`);
    expect((await res.json()).error).toBe("invalid_token");
    expect(mcpRoute).toHaveBeenCalledTimes(10);
  });
});

describe("when Redis is unavailable", () => {
  it("lets requests through uncounted without waiting on it", async () => {
    redis.status = "reconnecting";
    expect((await withKey("anlyon_live_good")).status).toBe(200);
    expect((await withKey("anlyon_live_guess")).status).toBe(401);
    expect(redis.mget).not.toHaveBeenCalled();
    expect(redis.pipeline).not.toHaveBeenCalled();
  });

  it("gives up on a Redis that does not answer", async () => {
    redis.mget.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    expect((await withKey("anlyon_live_good")).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
