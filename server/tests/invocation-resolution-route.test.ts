import { Hono, type Context, type Next } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolve = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/redis.ts", () => ({ RedisKeys: { idempotency: () => "k" }, redis: {} }));
vi.mock("../src/api/middleware/auth.ts", async (original) => ({
  ...await original<typeof import("../src/api/middleware/auth.ts")>(),
  requireApiKey: async (c: Context, next: Next) => {
    const session = c.req.header("Test-Auth") === "session";
    c.set("authType", session ? "session" : "apiKey");
    if (session) c.set("userId", "usr_1"); else c.set("apiKeyId", "key_operator");
    c.set("workspaceId", "ws_1");
    c.set("environmentId", "env_prod");
    c.set("apiKeyScopes", (c.req.header("Test-Scopes") ?? "").split(","));
    await next();
  },
}));
vi.mock("../src/core/workspace/roles.ts", () => ({
  resolveMemberRole: async () => ({ workspaceRole: roleHolder.role, role: roleHolder.role, grantedInEnvironmentId: null }),
}));
const roleHolder = vi.hoisted(() => ({ role: "admin" }));
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/halt.ts", () => ({ haltGuard: () => async (_c: Context, next: Next) => next() }));
vi.mock("../src/core/actions/resolution.ts", () => ({ resolveInvocation: resolve }));

const router = (await import("../src/api/routes/actions.ts")).default;
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/actions", router);

const body = { outcome: "failed", evidence: "No charge exists at the provider for this order." };
const call = (headers: Record<string, string>, payload: unknown = body) => app.request("/actions/invocations/inv_1/resolve", {
  method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers }, body: JSON.stringify(payload),
});

beforeEach(() => {
  resolve.mockReset();
  resolve.mockResolvedValue({ id: "inv_1", status: "failed" });
  roleHolder.role = "admin";
});

describe("resolve authorization", () => {
  it("accepts a key holding actions:resolve and passes the credential as the actor", async () => {
    expect((await call({ "Test-Scopes": "actions:resolve" })).status).toBe(200);
    expect(resolve).toHaveBeenCalledWith("ws_1", "env_prod", "inv_1", body, { type: "api_key", id: "key_operator" });
  });

  it.each(["actions:invoke", "actions:write,actions:govern", ""])("refuses a key without actions:resolve (%s)", async (scopes) => {
    expect((await call({ "Test-Scopes": scopes })).status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("lets a workspace admin resolve from the console, and refuses a member", async () => {
    expect((await call({ "Test-Auth": "session" })).status).toBe(200);
    expect(resolve).toHaveBeenLastCalledWith("ws_1", "env_prod", "inv_1", body, { type: "user", id: "usr_1" });
    roleHolder.role = "member";
    resolve.mockClear();
    expect((await call({ "Test-Auth": "session" })).status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    [{ outcome: "failed" }],
    [{ outcome: "failed", evidence: "too short" }],
    [{ outcome: "retry", evidence: "Checked the provider dashboard." }],
    [{ ...body, dispatch: true }],
  ])("requires an outcome and real evidence, and nothing else: %j", async (payload) => {
    expect((await call({ "Test-Scopes": "actions:resolve" }, payload)).status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });
});
