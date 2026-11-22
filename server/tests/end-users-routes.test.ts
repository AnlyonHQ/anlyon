import { Hono, type Context, type Next } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  invoke: vi.fn(),
  listInvocations: vi.fn(),
  listConnections: vi.fn(),
  createLink: vi.fn(),
  confirm: vi.fn(),
  setKey: vi.fn(),
  erase: vi.fn(),
  listEndUsers: vi.fn(),
  listApprovals: vi.fn(),
  approve: vi.fn(),
  deny: vi.fn(),
}));

vi.mock("../src/lib/redis.ts", () => ({ RedisKeys: { idempotency: () => "k" }, redis: {} }));
vi.mock("../src/api/middleware/auth.ts", async (original) => {
  const { readEndUserHeader } = await import("../src/api/end-user-context.ts");
  return {
    ...await original<typeof import("../src/api/middleware/auth.ts")>(),
    requireApiKey: async (c: Context, next: Next) => {
      const authType = c.req.header("x-test-auth") ?? "apiKey";
      c.set("authType", authType);
      c.set("workspaceId", "ws_1");
      c.set("environmentId", "env_1");
      if (authType === "apiKey") {
        c.set("apiKeyId", "00000000-0000-4000-8000-00000000000a");
        c.set("apiKeyScopes", (c.req.header("x-test-scopes") ?? "").split(",").filter(Boolean));
        c.set("endUserRequired", c.req.header("x-test-required") === "true");
      } else {
        c.set("userId", "user_1");
      }
      const endUserId = readEndUserHeader(c);
      if (endUserId) c.set("endUserId", endUserId);
      await next();
    },
    requirePermission: () => async (_c: Context, next: Next) => next(),
  };
});
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/halt.ts", () => ({ haltGuard: () => async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/feature-gate.ts", () => ({ requireFeature: () => async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/expensive-work.ts", () => ({ requireCostAdmission: async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/budget.ts", () => ({ budgetGuard: () => async (_c: Context, next: Next) => next() }));
vi.mock("../src/core/actions/service.ts", async (original) => ({
  ...await original<typeof import("../src/core/actions/service.ts")>(),
  invokeAction: calls.invoke,
  listInvocations: calls.listInvocations,
}));
vi.mock("../src/core/end-users/connect.ts", () => ({ createConnectLink: calls.createLink, confirmConnection: calls.confirm }));
vi.mock("../src/core/end-users/connections.ts", () => ({
  listEndUserConnections: calls.listConnections,
  setEndUserApiKey: calls.setKey,
  deleteEndUserConnection: vi.fn(),
  eraseEndUser: calls.erase,
  listEndUsers: calls.listEndUsers,
}));
vi.mock("../src/core/approvals/service.ts", async (original) => ({
  ...await original<typeof import("../src/core/approvals/service.ts")>(),
  listEndUserApprovals: calls.listApprovals,
  approveApproval: calls.approve,
  denyApproval: calls.deny,
}));

const actionsRouter = (await import("../src/api/routes/actions.ts")).default;
const endUsersRouter = (await import("../src/api/routes/end-users.ts")).default;
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/actions", actionsRouter);
app.route("/end-users", endUsersRouter);

const ALL = "actions:invoke,actions:read,end-users:read,end-users:write,end-users:approvals";
const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  app.request(path, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "x-test-scopes": ALL, ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
const code = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockReset();
  calls.invoke.mockResolvedValue({ id: "inv_1", status: "succeeded", pendingApproval: false });
  calls.listInvocations.mockResolvedValue({ invocations: [], total: 0 });
  calls.listConnections.mockResolvedValue([]);
  calls.listEndUsers.mockResolvedValue({ endUsers: [{ endUserId: "alice" }, { endUserId: "bob" }], nextCursor: "bob" });
  calls.listApprovals.mockResolvedValue({ approvals: [], total: 0 });
  calls.approve.mockResolvedValue({ approval: { id: "apr_1" } });
  calls.deny.mockResolvedValue({ approval: { id: "apr_1" } });
  calls.createLink.mockResolvedValue({ url: "https://x/link", expiresAt: new Date(), integration: "gmail" });
});

describe("the Anlyon-End-User header", () => {
  it("reaches invoke as the end user the call acts for", async () => {
    const res = await req("/actions/send/invoke", { method: "POST", headers: { "Anlyon-End-User": "user_42" }, body: {} });
    expect(res.status).toBe(200);
    expect(calls.invoke).toHaveBeenCalledWith("ws_1", "send", {}, expect.objectContaining({ endUser: { endUserId: "user_42", required: false } }));
  });

  it("is refused from a console session and from an OAuth token", async () => {
    for (const auth of ["session", "oauth"]) {
      const res = await req("/actions/send/invoke", { method: "POST", headers: { "x-test-auth": auth, "Anlyon-End-User": "user_42" }, body: {} });
      expect(res.status).toBe(400);
      expect(await code(res)).toBe("END_USER_HEADER_NOT_ALLOWED");
    }
    expect(calls.invoke).not.toHaveBeenCalled();
  });

  it.each(["has space", "x".repeat(129), "a/b", "erased~0123"])("refuses the malformed id %j", async (id) => {
    const res = await req("/actions/send/invoke", { method: "POST", headers: { "Anlyon-End-User": id }, body: {} });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("INVALID_END_USER");
  });

  it("is required by a key created with endUserRequired, on invoke and on previews", async () => {
    for (const path of ["/actions/send/invoke", "/actions/send/previews"]) {
      const res = await req(path, { method: "POST", headers: { "x-test-required": "true" }, body: { input: {} } });
      expect(res.status, path).toBe(400);
      expect(await code(res)).toBe("END_USER_REQUIRED");
    }
    expect(calls.invoke).not.toHaveBeenCalled();
  });

  it("limits a required key's invocation list to its own end user, whatever the query asks", async () => {
    await req("/actions/invocations?endUserId=bob", { headers: { "x-test-required": "true", "Anlyon-End-User": "alice" } });
    expect(calls.listInvocations).toHaveBeenLastCalledWith("ws_1", expect.objectContaining({ endUserId: "alice" }));
    await req("/actions/invocations?endUserId=bob");
    expect(calls.listInvocations).toHaveBeenLastCalledWith("ws_1", expect.objectContaining({ endUserId: "bob" }));
  });
});

describe("/end-users routes", () => {
  it("scope every call to the end user the path names", async () => {
    expect((await req("/end-users/alice%40acme.test/connections")).status).toBe(200);
    expect(calls.listConnections).toHaveBeenCalledWith({ workspaceId: "ws_1", environmentId: "env_1" }, "alice@acme.test");

    await req("/end-users/alice/connect-links", { method: "POST", body: { integration: "gmail", redirectUrl: "https://app.test/cb" } });
    expect(calls.createLink).toHaveBeenCalledWith(expect.anything(), "alice", { integration: "gmail", redirectUrl: "https://app.test/cb" });

    await req("/end-users/alice/connections/confirm", { method: "POST", body: { flowId: "flw_abc" } });
    expect(calls.confirm).toHaveBeenCalledWith(expect.anything(), "alice", "flw_abc", expect.objectContaining({ type: "api_key" }));

    await req("/end-users/alice/approvals/apr_9/decide", { method: "POST", body: { decision: "approve", reason: "ok" } });
    expect(calls.approve).toHaveBeenCalledWith("ws_1", "apr_9", expect.objectContaining({ endUserId: "alice", note: "ok" }), "env_1");
  });

  it("refuse a header that names another end user than the path", async () => {
    for (const [method, path, body] of [
      ["GET", "/end-users/alice/connections", undefined],
      ["GET", "/end-users/alice/approvals", undefined],
      ["POST", "/end-users/alice/approvals/apr_9/decide", { decision: "approve" }],
      ["POST", "/end-users/alice/connections/confirm", { flowId: "flw_abc" }],
      ["DELETE", "/end-users/alice", undefined],
    ] as const) {
      const res = await req(path, { method, headers: { "Anlyon-End-User": "bob" }, body });
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(await code(res)).toBe("END_USER_HEADER_MISMATCH");
    }
    expect(calls.listConnections).not.toHaveBeenCalled();
    expect(calls.approve).not.toHaveBeenCalled();
    expect(calls.confirm).not.toHaveBeenCalled();
    expect(calls.erase).not.toHaveBeenCalled();
  });

  it("need the header from a key created with endUserRequired", async () => {
    const res = await req("/end-users/alice/connections", { headers: { "x-test-required": "true" } });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("END_USER_REQUIRED");
    expect((await req("/end-users/alice/connections", { headers: { "x-test-required": "true", "Anlyon-End-User": "alice" } })).status).toBe(200);
    const list = await req("/end-users", { headers: { "x-test-required": "true" } });
    expect(list.status).toBe(400);
    expect(await code(list)).toBe("END_USER_REQUIRED");
    expect((await req("/end-users", { headers: { "x-test-required": "true", "Anlyon-End-User": "alice" } })).status).toBe(200);
  });

  it("need their scopes, none of which an ordinary key has", async () => {
    const asKey = (scopes: string) => ({ "x-test-scopes": scopes });
    expect((await req("/end-users/alice/connections", { headers: asKey("actions:invoke") })).status).toBe(403);
    expect((await req("/end-users/alice/connect-links", { method: "POST", headers: asKey("end-users:read"), body: { integration: "gmail" } })).status).toBe(403);
    expect((await req("/end-users/alice/approvals", { headers: asKey("end-users:read,end-users:write") })).status).toBe(403);
    expect((await req("/end-users/alice", { method: "DELETE", headers: asKey("end-users:read,end-users:approvals") })).status).toBe(403);
    expect(calls.createLink).not.toHaveBeenCalled();
    expect(calls.erase).not.toHaveBeenCalled();
  });

  it("refuse a malformed path id", async () => {
    const res = await req("/end-users/has%20space/connections");
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("INVALID_END_USER");
  });

  it("show a required key only its own end user in the list", async () => {
    const res = await req("/end-users", { headers: { "x-test-required": "true", "Anlyon-End-User": "alice" } });
    const body = (await res.json()) as { data: Array<{ endUserId: string }>; pagination: { nextCursor: string | null } };
    expect(body.data.map((u) => u.endUserId)).toEqual(["alice"]);
    expect(body.pagination.nextCursor).toBeNull();
  });

  it("let a console session decide an end user's approval by path, and never by header", async () => {
    expect((await req("/end-users/alice/approvals/apr_9/decide", { method: "POST", headers: { "x-test-auth": "session" }, body: { decision: "deny" } })).status).toBe(200);
    expect(calls.deny).toHaveBeenCalledWith("ws_1", "apr_9", expect.objectContaining({ endUserId: "alice", deciderUserId: "user_1" }), "env_1");
  });
});
