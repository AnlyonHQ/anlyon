import { Hono, type Context, type Next } from "hono";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  listInvocations: vi.fn(),
  listEffects: vi.fn(),
  listApprovals: vi.fn(),
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
        c.set("apiKeyScopes", (c.req.header("x-test-scopes") ?? "actions:read,approvals:read").split(","));
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
vi.mock("../src/api/middleware/idempotency.ts", () => ({ idempotencyMiddleware: async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/halt.ts", () => ({ haltGuard: () => async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/feature-gate.ts", () => ({ requireFeature: () => async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/expensive-work.ts", () => ({ requireCostAdmission: async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/budget.ts", () => ({ budgetGuard: () => async (_c: Context, next: Next) => next() }));
vi.mock("../src/core/actions/service.ts", async (original) => ({
  ...await original<typeof import("../src/core/actions/service.ts")>(),
  listInvocations: calls.listInvocations,
}));
vi.mock("../src/core/effects/service.ts", async (original) => ({
  ...await original<typeof import("../src/core/effects/service.ts")>(),
  listEffects: calls.listEffects,
}));
vi.mock("../src/core/approvals/service.ts", async (original) => ({
  ...await original<typeof import("../src/core/approvals/service.ts")>(),
  listApprovals: calls.listApprovals,
}));
vi.mock("../src/core/assistant/service.ts", async (original) => ({
  ...await original<typeof import("../src/core/assistant/service.ts")>(),
  adviceByPublicId: async () => new Map(),
}));

const actionsRouter = (await import("../src/api/routes/actions.ts")).default;
const approvalsRouter = (await import("../src/api/routes/approvals.ts")).default;
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const { actingForCondition } = await import("../src/core/end-users/acting-for.ts");
const { actionInvocations } = await import("../src/db/schema/actions.ts");
const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/actions", actionsRouter);
app.route("/approvals", approvalsRouter);

const req = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockReset();
  calls.listInvocations.mockResolvedValue({ invocations: [], total: 0 });
  calls.listEffects.mockResolvedValue({ effects: [], total: 0, limit: 20, offset: 0 });
  calls.listApprovals.mockResolvedValue({ approvals: [], total: 0 });
});

describe("?actingFor= on the activity lists", () => {
  it("reaches the invocation list, on the log and on one action's log", async () => {
    expect((await req("/actions/invocations?actingFor=workspace")).status).toBe(200);
    expect(calls.listInvocations).toHaveBeenLastCalledWith("ws_1", expect.objectContaining({ actingFor: "workspace" }));
    expect((await req("/actions/send/invocations?actingFor=end_users")).status).toBe(200);
    expect(calls.listInvocations).toHaveBeenLastCalledWith("ws_1", expect.objectContaining({ actingFor: "end_users", actionRef: "send" }));
  });

  it("reaches the receipt list", async () => {
    expect((await req("/actions/effects?actingFor=end_users")).status).toBe(200);
    expect(calls.listEffects).toHaveBeenLastCalledWith("ws_1", "env_1", expect.objectContaining({ actingFor: "end_users" }));
  });

  it("is absent unless asked, and refuses anything else", async () => {
    await req("/actions/invocations");
    expect(calls.listInvocations.mock.calls[0][1].actingFor).toBeUndefined();
    expect((await req("/actions/invocations?actingFor=everyone")).status).toBe(400);
    expect((await req("/actions/effects?actingFor=users")).status).toBe(400);
    expect((await req("/approvals?actingFor=team")).status).toBe(400);
    expect(calls.listEffects).not.toHaveBeenCalled();
    expect(calls.listApprovals).not.toHaveBeenCalled();
  });

  it("never widens a key that requires an end user", async () => {
    const headers = { "x-test-required": "true", "Anlyon-End-User": "alice" };
    await req("/actions/invocations?actingFor=workspace&endUserId=bob", headers);
    expect(calls.listInvocations).toHaveBeenLastCalledWith("ws_1", expect.objectContaining({ endUserId: "alice", actingFor: "workspace" }));
    await req("/actions/effects?actingFor=end_users", headers);
    expect(calls.listEffects).toHaveBeenLastCalledWith("ws_1", "env_1", expect.objectContaining({ endUserId: "alice" }));
    await req("/approvals?decider=end_user", { ...headers, "x-test-scopes": "approvals:read,end-users:approvals" });
    expect(calls.listApprovals).toHaveBeenLastCalledWith("ws_1", expect.objectContaining({ endUserId: "alice", decider: "end_user" }));
  });
});

describe("the approval list", () => {
  it("is the team's inbox unless the end users' approvals are asked for", async () => {
    await req("/approvals?status=pending", { "x-test-auth": "session" });
    expect(calls.listApprovals.mock.calls[0][1].decider).toBeUndefined();
    await req("/approvals?status=pending&decider=end_user&actingFor=end_users", { "x-test-auth": "session" });
    expect(calls.listApprovals).toHaveBeenLastCalledWith("ws_1", expect.objectContaining({ decider: "end_user", actingFor: "end_users", status: "pending" }));
    expect((await req("/approvals?decider=anyone")).status).toBe(400);
  });

  it("refuses the end users' approvals to a key with approvals:read alone", async () => {
    const res = await req("/approvals?decider=end_user");
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("end-users:approvals");
    expect(calls.listApprovals).not.toHaveBeenCalled();
    expect((await req("/approvals?decider=team")).status).toBe(200);
  });

  it("lists them for a key with end-users:approvals", async () => {
    const res = await req("/approvals?decider=end_user", { "x-test-scopes": "approvals:read,end-users:approvals" });
    expect(res.status).toBe(200);
    expect(calls.listApprovals).toHaveBeenLastCalledWith("ws_1", expect.objectContaining({ decider: "end_user" }));
  });

  it("keeps a key that requires an end user to its own, with the scope", async () => {
    const headers = { "x-test-required": "true", "Anlyon-End-User": "alice", "x-test-scopes": "approvals:read,end-users:approvals" };
    expect((await req("/approvals?decider=end_user&endUserId=bob", headers)).status).toBe(200);
    expect(calls.listApprovals).toHaveBeenLastCalledWith("ws_1", expect.objectContaining({ endUserId: "alice", decider: "end_user" }));
  });
});

describe("actingForCondition", () => {
  const dialect = new PgDialect();
  const sqlOf = (side: "workspace" | "end_users") => {
    const condition = actingForCondition(actionInvocations.endUserId, side);
    if (!condition) throw new Error("expected a condition");
    return dialect.sqlToQuery(condition).sql;
  };

  it("is null for the workspace, not null for end users, and nothing for both", () => {
    expect(sqlOf("workspace")).toMatch(/"end_user_id" is null$/);
    expect(sqlOf("end_users")).toMatch(/"end_user_id" is not null$/);
    expect(actingForCondition(actionInvocations.endUserId, undefined)).toBeUndefined();
  });
});
