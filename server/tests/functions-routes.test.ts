import { Hono, type Context, type Next } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  feature: { enabled: true },
  create: vi.fn(),
  archive: vi.fn(),
  list: vi.fn(),
  publish: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
  handle: vi.fn(),
  versions: vi.fn(),
  version: vi.fn(),
  runs: vi.fn(),
}));

vi.mock("../src/lib/redis.ts", () => ({ RedisKeys: {}, redis: {} }));
vi.mock("../src/api/middleware/auth.ts", async (original) => {
  const { readEndUserHeader } = await import("../src/api/end-user-context.ts");
  return {
    ...await original<typeof import("../src/api/middleware/auth.ts")>(),
    requireApiKey: async (c: Context, next: Next) => {
      c.set("authType", "apiKey");
      c.set("workspaceId", "ws_1");
      c.set("environmentId", "env_1");
      c.set("apiKeyId", "00000000-0000-4000-8000-00000000000a");
      c.set("apiKeyScopes", (c.req.header("x-test-scopes") ?? "").split(",").filter(Boolean));
      c.set("endUserRequired", c.req.header("x-test-required") === "true");
      const endUserId = readEndUserHeader(c);
      if (endUserId) c.set("endUserId", endUserId);
      await next();
    },
    requirePermission: () => async (_c: Context, next: Next) => next(),
  };
});
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/halt.ts", () => ({ haltGuard: () => async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/expensive-work.ts", () => ({ requireCostAdmission: async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/feature-gate.ts", async () => {
  const { NotFoundError } = await import("../src/utils/errors.ts");
  return {
    requireFeature: () => async (_c: Context, next: Next) => {
      if (!calls.feature.enabled) throw new NotFoundError("Endpoint");
      await next();
    },
  };
});
vi.mock("../src/core/functions/service.ts", () => ({
  createFunction: calls.create,
  archiveFunction: calls.archive,
  listFunctions: calls.list,
  publishVersion: calls.publish,
  listVersions: calls.versions,
  getVersion: calls.version,
}));
vi.mock("../src/core/functions/runs.ts", () => ({ startRun: calls.start, getRun: calls.get, listRuns: calls.runs, MAX_LISTED_RUNS: 100 }));
vi.mock("../src/core/functions/calls.ts", () => ({ handleFunctionCall: calls.handle, MAX_CALL_BODY_BYTES: 300 * 1024 }));
vi.mock("../src/api/audit-caller.ts", () => ({ auditRequest: vi.fn(), auditCaller: () => ({ actor: { type: "api_key", id: "k" }, context: {} }) }));

const routes = await import("../src/api/routes/functions.ts");
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/functions", routes.default);
app.route("/function-runs", routes.functionRunsRouter);
app.route("/internal/function-runs", routes.internalFunctionRunsRouter);

const ALL = "functions:read,functions:write,functions:run,actions:invoke";
const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  app.request(path, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "x-test-scopes": ALL, ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

beforeEach(() => {
  calls.feature.enabled = true;
  for (const fn of [calls.create, calls.archive, calls.list, calls.publish, calls.start, calls.get, calls.handle, calls.versions, calls.version, calls.runs]) fn.mockReset();
  calls.create.mockResolvedValue({ id: "fn_1", name: "refund" });
  calls.archive.mockResolvedValue({ id: "fn_1", name: "refund" });
  calls.list.mockResolvedValue([]);
  calls.publish.mockResolvedValue({ function: { id: "fn_1", name: "refund" }, version: { id: "fnv_1", version: 1, language: "javascript", digest: "sha256:x", allowedActions: [], budgets: {} } });
  calls.start.mockResolvedValue({ id: "frn_1", status: "succeeded", endUserId: "alice" });
  calls.get.mockResolvedValue({ id: "frn_1", status: "succeeded", endUserId: "bob" });
  calls.handle.mockResolvedValue({ status: 200, body: { ok: true, result: { id: "inv_1" } } });
  calls.versions.mockResolvedValue([]);
  calls.version.mockResolvedValue({ id: "fnv_1", version: 1, current: true, source: "export default async function run() {}" });
  calls.runs.mockResolvedValue([]);
});

describe("scopes", () => {
  it.each([
    ["POST", "/functions", { name: "refund" }, "functions:write"],
    ["GET", "/functions", undefined, "functions:read"],
    ["DELETE", "/functions/refund", undefined, "functions:write"],
    ["POST", "/functions/refund/versions", { language: "javascript", source: "x", allowedActions: [] }, "functions:write"],
    ["POST", "/functions/refund/runs", { input: {} }, "functions:run"],
    ["GET", "/functions/refund/versions", undefined, "functions:read"],
    ["GET", "/functions/refund/versions/current", undefined, "functions:read"],
    ["GET", "/functions/refund/runs", undefined, "functions:read"],
    ["GET", "/function-runs/frn_1", undefined, "functions:read"],
  ])("%s %s needs %s", async (method, path, body, scope) => {
    const without = ALL.split(",").filter((s) => s !== scope).join(",");
    const refused = await req(path, { method, body, headers: { "x-test-scopes": without } });
    expect(refused.status).toBe(403);
    const allowed = await req(path, { method, body });
    expect(allowed.status).toBeLessThan(300);
  });

  it("running also needs actions:invoke, since every call is an action invocation", async () => {
    const res = await req("/functions/refund/runs", { method: "POST", body: {}, headers: { "x-test-scopes": "functions:run" } });
    expect(res.status).toBe(403);
    expect(calls.start).not.toHaveBeenCalled();
  });

  it("keeps all three out of the default set", async () => {
    const { DEFAULT_API_KEY_SCOPES, PRIVILEGED_API_KEY_SCOPES } = await import("../src/core/auth/api-key-scopes.ts");
    for (const scope of ["functions:read", "functions:write", "functions:run"] as const) {
      expect(PRIVILEGED_API_KEY_SCOPES).toContain(scope);
      expect(DEFAULT_API_KEY_SCOPES).not.toContain(scope);
    }
  });
});

describe("reading a source before publishing", () => {
  it("answers what the source calls, and stores nothing", async () => {
    const res = await req("/functions/analysis", { method: "POST", body: { language: "javascript", source: 'export default async function run(i, a) { await a.invoke("refund", {}); }' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { proposedAllowedActions: string[] } };
    expect(body.data.proposedAllowedActions).toEqual(["refund"]);
    expect(calls.publish).not.toHaveBeenCalled();
  });

  it("refuses an unknown language", async () => {
    expect((await req("/functions/analysis", { method: "POST", body: { language: "ruby", source: "x" } })).status).toBe(400);
  });
});

describe("the end user a run acts for", () => {
  it("is the Anlyon-End-User header, passed to the run", async () => {
    const res = await req("/functions/refund/runs", { method: "POST", body: { input: { amount: 5 } }, headers: { "Anlyon-End-User": "alice" } });
    expect(res.status).toBe(200);
    expect(calls.start).toHaveBeenCalledWith(
      { workspaceId: "ws_1", environmentId: "env_1" },
      "refund",
      { amount: 5 },
      expect.objectContaining({ endUser: { endUserId: "alice", required: false }, requestedByKeyId: "00000000-0000-4000-8000-00000000000a" }),
    );
  });

  it("is required by a key created with endUserRequired", async () => {
    const res = await req("/functions/refund/runs", { method: "POST", body: {}, headers: { "x-test-required": "true" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("END_USER_REQUIRED");
  });

  it("limits such a key to its own end user's runs", async () => {
    const res = await req("/function-runs/frn_1", { headers: { "x-test-required": "true", "Anlyon-End-User": "alice" } });
    expect(res.status).toBe(404);
    const own = await req("/function-runs/frn_1", { headers: { "x-test-required": "true", "Anlyon-End-User": "bob" } });
    expect(own.status).toBe(200);
  });

  it("tells such a key with no end user that it needs one, rather than that the run does not exist", async () => {
    const res = await req("/function-runs/frn_1", { headers: { "x-test-required": "true" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("END_USER_REQUIRED");
  });

  it("plans by default, and passes an apply run's plan through", async () => {
    await req("/functions/refund/runs", { method: "POST", body: { input: { amount: 5 } } });
    expect(calls.start).toHaveBeenLastCalledWith(expect.anything(), "refund", { amount: 5 }, expect.objectContaining({ mode: "plan" }));
    await req("/functions/refund/runs", { method: "POST", body: { mode: "apply", planRunId: "frn_plan" } });
    expect(calls.start).toHaveBeenLastCalledWith(expect.anything(), "refund", undefined, expect.objectContaining({ mode: "apply", planRunId: "frn_plan" }));
  });

  it("refuses an apply without its plan, a plan id on any other run, and an unknown mode", async () => {
    for (const body of [{ mode: "apply" }, { mode: "plan", planRunId: "frn_plan" }, { mode: "dry_run" }]) {
      const res = await req("/functions/refund/runs", { method: "POST", body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(calls.start).not.toHaveBeenCalled();
  });
});

describe("deleting a function", () => {
  it("archives it and answers what was deleted", async () => {
    const res = await req("/functions/refund", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ deleted: true, id: "fn_1", name: "refund" });
    expect(calls.archive).toHaveBeenCalledWith({ workspaceId: "ws_1", environmentId: "env_1" }, "refund");
  });
});

describe("a function's history", () => {
  it("reads a version by number or as current, and refuses anything else", async () => {
    expect((await req("/functions/refund/versions/3")).status).toBe(200);
    expect(calls.version).toHaveBeenLastCalledWith({ workspaceId: "ws_1", environmentId: "env_1" }, "refund", 3);
    expect((await req("/functions/refund/versions/current")).status).toBe(200);
    expect(calls.version).toHaveBeenLastCalledWith({ workspaceId: "ws_1", environmentId: "env_1" }, "refund", "current");
    for (const bad of ["0", "-1", "1.5", "latest", "01"]) {
      expect((await req(`/functions/refund/versions/${bad}`)).status).toBe(400);
    }
    expect(calls.version).toHaveBeenCalledTimes(2);
  });

  it("lists runs with a limit, and refuses one out of range", async () => {
    expect((await req("/functions/refund/runs?limit=20")).status).toBe(200);
    expect(calls.runs).toHaveBeenLastCalledWith({ workspaceId: "ws_1", environmentId: "env_1" }, "refund", { limit: 20 });
    for (const bad of ["0", "101", "abc", "-5"]) {
      expect((await req(`/functions/refund/runs?limit=${bad}`)).status).toBe(400);
    }
  });

  it("narrows runs to the end user asked for, and a key that requires one to its own", async () => {
    await req("/functions/refund/runs?endUserId=carol");
    expect(calls.runs).toHaveBeenLastCalledWith(expect.anything(), "refund", { endUserId: "carol" });
    await req("/functions/refund/runs?endUserId=carol", { headers: { "x-test-required": "true", "Anlyon-End-User": "alice" } });
    expect(calls.runs).toHaveBeenLastCalledWith(expect.anything(), "refund", { endUserId: "alice" });
    const without = await req("/functions/refund/runs", { headers: { "x-test-required": "true" } });
    expect(without.status).toBe(400);
  });
});

describe("the feature gate", () => {
  it("answers 404 on every route while functions are switched off", async () => {
    calls.feature.enabled = false;
    for (const [method, path] of [["GET", "/functions"], ["POST", "/functions/refund/runs"], ["GET", "/function-runs/frn_1"], ["POST", "/internal/function-runs/frn_1/calls"]]) {
      expect((await req(path!, { method, body: method === "POST" ? {} : undefined })).status, path).toBe(404);
    }
  });
});

describe("the internal calls route", () => {
  it("passes the runner's token, signature and the signed path to the calls handler, and answers with its JSON", async () => {
    const body = JSON.stringify({ kind: "invoke", action: "refund", input: {}, execution: "exec-1234" });
    const res = await app.request("/internal/function-runs/frn_1/calls", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer frt_v1.a.b", "Anlyon-Runner-Signature": "t=1,v1=ab" },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { id: "inv_1" } });
    expect(calls.handle).toHaveBeenCalledWith({
      runId: "frn_1",
      token: "frt_v1.a.b",
      signature: "t=1,v1=ab",
      path: "/api/internal/function-runs/frn_1/calls",
      body,
    });
  });

  it("answers a refusal with its status", async () => {
    calls.handle.mockResolvedValue({ status: 403, body: { ok: false, error: { code: "ACTION_NOT_ALLOWED", message: "no" } } });
    const res = await app.request("/internal/function-runs/frn_1/calls", { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
  });
});
