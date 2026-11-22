import { Hono, type Context, type Next } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
const spies = vi.hoisted(() => ({
  invoke: vi.fn(), replay: vi.fn(), admission: vi.fn(), budget: vi.fn(),
}));

vi.mock("../src/lib/redis.ts", () => ({
  RedisKeys: { idempotency: (w: string, e: string, k: string) => `idem:${w}:${e}:${k}` },
  redis: {
    set: async (key: string, value: string) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    get: async (key: string) => store.get(key) ?? null,
    eval: async (_script: string, _n: number, key: string, token: string, completed?: string) => {
      const current = store.get(key);
      if (!current) return 0;
      const parsed = JSON.parse(current);
      if (parsed.state !== "pending" || parsed.token !== token) return 0;
      if (completed) store.set(key, completed);
      else store.delete(key);
      return 1;
    },
  },
}));
vi.mock("../src/api/middleware/auth.ts", async (original) => ({
  ...await original<typeof import("../src/api/middleware/auth.ts")>(),
  requireApiKey: async (c: Context, next: Next) => {
    c.set("authType", c.req.header("Test-Auth") ?? "apiKey");
    c.set("apiKeyId", "key_agent");
    c.set("userId", "usr_owner");
    c.set("workspaceId", "ws_1");
    c.set("environmentId", "env_prod");
    c.set("apiKeyScopes", (c.req.header("Test-Scopes") ?? "actions:invoke").split(","));
    await next();
  },
}));
vi.mock("../src/core/workspace/roles.ts", () => ({
  resolveMemberRole: async () => ({ workspaceRole: "member", role: "member", grantedInEnvironmentId: null }),
}));
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/halt.ts", () => ({ haltGuard: () => async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/expensive-work.ts", () => ({
  requireCostAdmission: async (_c: Context, next: Next) => { spies.admission(); await next(); },
}));
vi.mock("../src/api/middleware/budget.ts", () => ({
  budgetGuard: () => async (_c: Context, next: Next) => { spies.budget(); await next(); },
}));
vi.mock("../src/core/actions/import.ts", () => ({ importActionsFromOpenApi: vi.fn() }));
vi.mock("../src/core/actions/service.ts", () => ({
  invokeAction: spies.invoke, replayInvocationForKey: spies.replay,
  createAction: vi.fn(), listActionVersions: vi.fn(), deleteAction: vi.fn(), getAction: vi.fn(),
  getInvocation: vi.fn(), listActions: vi.fn(), listInvocations: vi.fn(), updateAction: vi.fn(),
}));

const router = (await import("../src/api/routes/actions.ts")).default;
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/actions", router);

const invoke = (headers: Record<string, string> = {}, input: unknown = { amount: 10 }) => app.request("/actions/refund_order/invoke", {
  method: "POST",
  headers: { "content-type": "application/json", "Idempotency-Key": "idem_1", ...headers },
  body: JSON.stringify({ input }),
});
const invocation = (status: string) => ({ id: "inv_1", actionName: "refund_order", status, pendingApproval: status === "pending_approval" });

beforeEach(() => {
  store.clear();
  for (const spy of Object.values(spies)) spy.mockReset();
  spies.replay.mockResolvedValue(null);
  spies.invoke.mockResolvedValue(invocation("succeeded"));
});

describe("durable invoke replay", () => {
  it("reads the new state on retry without losing Redis", async () => {
    spies.invoke.mockResolvedValue(invocation("pending_approval"));
    expect((await invoke()).status).toBe(202);
    expect(store.size).toBe(0);
    spies.replay.mockResolvedValue({ ...invocation("succeeded"), replayed: true });
    const response = await invoke();
    expect((await response.json()).data.status).toBe("succeeded");
    expect(spies.invoke).toHaveBeenCalledTimes(1);
    expect(spies.budget).toHaveBeenCalledTimes(1);
  });

  it("prefers durable state over an old completed Redis entry, after checking scope", async () => {
    await invoke();
    const fingerprint = spies.invoke.mock.calls[0][3].idempotency.fingerprint;
    store.set("idem:ws_1:env_prod:idem_1", JSON.stringify({
      state: "completed", fingerprint, status: 202,
      body: JSON.stringify({ success: true, data: invocation("pending_approval") }),
    }));
    spies.replay.mockResolvedValue({ ...invocation("succeeded"), replayed: true });
    expect((await (await invoke()).json()).data.status).toBe("succeeded");
    spies.replay.mockClear();
    expect((await invoke({ "Test-Scopes": "actions:read" })).status).toBe(403);
    expect(spies.replay).not.toHaveBeenCalled();
    expect(spies.invoke).toHaveBeenCalledTimes(1);
  });

  it("preserves pre-migration cached effects when there is no durable key", async () => {
    await invoke();
    const fingerprint = spies.invoke.mock.calls[0][3].idempotency.fingerprint;
    store.set("idem:ws_1:env_prod:idem_1", JSON.stringify({
      state: "completed", fingerprint, status: 200,
      body: JSON.stringify({ success: true, data: invocation("succeeded") }),
    }));
    expect((await (await invoke()).json()).data.status).toBe("succeeded");
    expect(spies.invoke).toHaveBeenCalledTimes(1);
    expect(spies.budget).toHaveBeenCalledTimes(1);
  });
  it("records the key and caller-inclusive fingerprint with a new invocation", async () => {
    expect((await invoke()).status).toBe(200);
    const [, , , opts] = spies.invoke.mock.calls[0];
    expect(opts.idempotency).toEqual({ key: "idem_1", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(spies.replay).toHaveBeenCalledWith("ws_1", "env_prod", "idem_1", opts.idempotency.fingerprint);
  });

  it("after Redis loses the claim, answers from current state without admission, budget or execution", async () => {
    await invoke();
    const fingerprint = spies.invoke.mock.calls[0][3].idempotency.fingerprint;
    store.clear();
    spies.admission.mockClear(); spies.budget.mockClear(); spies.invoke.mockClear();
    spies.replay.mockResolvedValue({ ...invocation("pending_approval"), replayed: true });

    const response = await invoke();
    expect(response.status).toBe(202);
    expect(response.headers.get("X-Idempotent-Replay")).toBe("current-state");
    expect(await response.json()).toEqual({ success: true, data: invocation("pending_approval") });
    expect(spies.replay).toHaveBeenLastCalledWith("ws_1", "env_prod", "idem_1", fingerprint);
    expect([spies.admission, spies.budget, spies.invoke].map((s) => s.mock.calls.length)).toEqual([0, 0, 0]);
    expect(store.size).toBe(0);
  });

  it("covers dashboard sessions, which have no budget reservation to fall back on", async () => {
    spies.replay.mockResolvedValue({ ...invocation("succeeded"), replayed: true });
    const response = await invoke({ "Test-Auth": "session" });
    expect(response.status).toBe(200);
    expect(spies.invoke).not.toHaveBeenCalled();
  });

  it("marks a replay found at insert time (a lost race) the same way", async () => {
    spies.invoke.mockResolvedValue({ ...invocation("running"), replayed: true });
    const response = await invoke();
    expect(response.headers.get("X-Idempotent-Replay")).toBe("current-state");
    expect((await response.json()).data).not.toHaveProperty("replayed");
    expect(store.size).toBe(0);
  });

  it("returns the service's 409 for a key reused by another request", async () => {
    const { ApiError } = await import("../src/utils/errors.ts");
    spies.replay.mockRejectedValue(new ApiError(409, "idempotency_key_reuse", "This Idempotency-Key was already used for a different request."));
    const response = await invoke();
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("idempotency_key_reuse");
    expect(spies.invoke).not.toHaveBeenCalled();
  });

  it("never replays to a credential without actions:invoke", async () => {
    expect((await invoke({ "Test-Scopes": "actions:read" })).status).toBe(403);
    expect(spies.replay).not.toHaveBeenCalled();
  });

  it("does not consult durable replay without an Idempotency-Key", async () => {
    const response = await app.request("/actions/refund_order/invoke", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }),
    });
    expect(response.status).toBe(200);
    expect(spies.replay).not.toHaveBeenCalled();
    expect(spies.invoke.mock.calls[0][3]).not.toHaveProperty("idempotency");
  });
});
