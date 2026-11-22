import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  process.env.FUNCTION_RUNNER_URL = "https://runner.anlyon.test";
  process.env.RUNNER_SHARED_SECRET = "test-runner-shared-secret-at-least-32-chars";
  return {
    client: undefined as PGlite | undefined,
    store: new Map<string, string>(),
    sent: [] as Array<{ url: string; method: string }>,
  };
});

vi.mock("../src/lib/safe-http.ts", async (original) => ({
  ...await original<typeof import("../src/lib/safe-http.ts")>(),
  safeFetch: async (url: string, init: { method?: string }) => {
    state.sent.push({ url, method: init.method ?? "GET" });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  },
}));
vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client), pool: { end: async () => {} } };
});
vi.mock("../src/lib/redis.ts", () => {
  const redis = {
    async set(key: string, value: string) { state.store.set(key, value); return "OK"; },
    async get(key: string) { return state.store.get(key) ?? null; },
    async getdel(key: string) { const value = state.store.get(key) ?? null; state.store.delete(key); return value; },
    async del(key: string) { return state.store.delete(key) ? 1 : 0; },
    async incr(key: string) { const next = Number(state.store.get(key) ?? 0) + 1; state.store.set(key, String(next)); return next; },
    async decr() { return 0; },
    async expire() { return 1; },
    async pttl() { return -2; },
    async exists() { return 0; },
    async hgetall() { return {}; },
    async eval() { return null; },
  };
  const RedisKeys = new Proxy({}, { get: (_t, name) => (...parts: unknown[]) => `${String(name)}:${parts.join(":")}` });
  return { redis, redisBlocking: redis, RedisKeys, createBlockingConnection: () => redis };
});
vi.mock("../src/core/events/emitter.ts", () => ({ emitEvent: vi.fn() }));
vi.mock("../src/core/notifications/notification-service.ts", () => ({ createAndSendNotification: vi.fn() }));
vi.mock("../src/core/assistant/service.ts", async (original) => ({
  getAssistantSettings: (await original<typeof import("../src/core/assistant/service.ts")>()).getAssistantSettings,
  onApprovalAnnounced: async () => false,
}));
vi.mock("../src/lib/product-events.ts", () => ({ captureMilestoneOnce: vi.fn() }));
vi.mock("../src/core/assistant/usage.ts", async (original) => ({
  ...await original<typeof import("../src/core/assistant/usage.ts")>(),
  admitPlatformReview: async () => ({ period: "test" }),
  releasePlatformReview: async () => {},
}));

const { env } = await import("../src/config/env.ts");
const service = await import("../src/core/functions/service.ts");
const runs = await import("../src/core/functions/runs.ts");
const { handleFunctionCall } = await import("../src/core/functions/calls.ts");
const { signRunnerRequest } = await import("../src/core/functions/runner-signing.ts");
const { mintRunToken } = await import("../src/core/functions/run-token.ts");
const { sendRun, RunnerTimeoutError } = await import("../src/core/functions/runner-client.ts");
type RunnerRunRequest = import("../src/core/functions/runner-client.ts").RunnerRunRequest;
type RunnerRunResponse = import("../src/core/functions/runner-client.ts").RunnerRunResponse;

const ws = "00000000-0000-4000-8000-0000000000a1";
const envId = "00000000-0000-4000-8000-0000000000b1";
const keyId = "00000000-0000-4000-8000-0000000000c1";
const scope = { workspaceId: ws, environmentId: envId };
const actor = { type: "api_key" as const, id: keyId };
const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);

type CallAnswer = { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string; budget?: string } };
interface FakeAnlyon {
  invoke(action: string, input?: Record<string, unknown>): Promise<CallAnswer>;
  read(action: string, input?: Record<string, unknown>): Promise<CallAnswer>;
  raw(kind: "invoke" | "read", action: string, input: Record<string, unknown>, override?: { runId?: string; token?: string; execution?: string; signature?: string }): Promise<CallAnswer>;
  request: RunnerRunRequest;
}
type Script = (input: Record<string, unknown>, anlyon: FakeAnlyon) => Promise<unknown>;

const scripts = new Map<string, Script>();
let scriptCounter = 0;
function script(fn: Script, source?: string): string {
  const key = `// script ${++scriptCounter}\n${source ?? "export default async function run() {}"}`;
  scripts.set(key, fn);
  return key;
}

function fakeRunner(options: { checkAllowList?: boolean; answer?: (request: RunnerRunRequest) => RunnerRunResponse } = {}) {
  const requests: RunnerRunRequest[] = [];
  const send = async (request: RunnerRunRequest): Promise<RunnerRunResponse> => {
    requests.push(request);
    if (options.answer) return options.answer(request);
    const execution = randomUUID();
    const raw: FakeAnlyon["raw"] = async (kind, action, input, override = {}) => {
      const runId = override.runId ?? request.runId;
      const body = JSON.stringify({ kind, action, input, execution: override.execution ?? execution });
      const path = `/api/internal/function-runs/${runId}/calls`;
      const answer = await handleFunctionCall({
        runId,
        token: override.token ?? request.runToken,
        signature: override.signature ?? signRunnerRequest(env.RUNNER_SHARED_SECRET!, "POST", path, body),
        path,
        body,
      });
      return answer.body as CallAnswer;
    };
    const call = (kind: "invoke" | "read") => async (action: string, input: Record<string, unknown> = {}) => {
      if (options.checkAllowList !== false && !request.allowedActions.includes(action)) {
        return { ok: false, error: { code: "ACTION_NOT_ALLOWED", message: "refused in the runner" } };
      }
      return raw(kind, action, input);
    };
    try {
      const output = await scripts.get(request.source)!(request.input as Record<string, unknown>, { invoke: call("invoke"), read: call("read"), raw, request });
      return { status: "succeeded", output: output ?? null, logs: [], durationMs: 1 };
    } catch (error) {
      return { status: "failed", error: { code: "FUNCTION_THREW", message: (error as Error).message }, logs: [], durationMs: 1 };
    }
  };
  return { send, requests };
}

let nameCounter = 0;
async function publish(
  source: string,
  allowedActions: string[],
  budgets: Record<string, number> = {},
  straightThrough: { actions: string[]; maxWrites: number } | null = null,
) {
  const name = `fn-${++nameCounter}`;
  await service.createFunction(scope, { name });
  await service.publishVersion(scope, name, { language: "javascript", source, allowedActions, budgets, straightThrough }, { keyId, userId: null });
  return name;
}

function run(
  name: string,
  send: (request: RunnerRunRequest) => Promise<RunnerRunResponse>,
  input: Record<string, unknown> = {},
  endUserId: string | null = null,
  mode: "plan" | "straight_through" = "straight_through",
) {
  return runs.startRun(scope, name, input, {
    mode,
    endUser: { endUserId, required: false },
    requestedByKeyId: keyId,
    actor,
    send,
  });
}

beforeAll(async () => {
  await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('user_fn', 'Dev', 'dev@example.test', true, now(), now())`);
  await sql("INSERT INTO workspaces (id, name, slug, plan) VALUES ($1, 'Acme Shop', 'acme-shop', 'growth')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug, is_default) VALUES ($1, $2, 'Production', 'prod', true)", [envId, ws]);
  await sql(
    `INSERT INTO api_keys (id, workspace_id, environment_id, name, key_hash, key_prefix, created_by, scopes)
       VALUES ($1, $2, $3, 'server', 'hash_fn_key', 'anlyon_l', 'user_fn', '["functions:run","actions:invoke"]'::jsonb)`,
    [keyId, ws, envId],
  );
  await sql(
    `INSERT INTO actions (workspace_id, environment_id, action_id, name, method, url_template, enabled) VALUES
       ($1, $2, 'act_lookup', 'lookup', 'GET', 'https://shop.test/orders', true),
       ($1, $2, 'act_refund', 'refund', 'POST', 'https://shop.test/refunds', true),
       ($1, $2, 'act_wipe', 'delete_customer', 'POST', 'https://shop.test/wipe', true),
       ($1, $2, 'act_off', 'switched_off', 'POST', 'https://shop.test/off', false),
       ($1, $2, 'act_email', 'email', 'POST', 'https://mail.test/send', true)`,
    [ws, envId],
  );
  await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('user_reviewer', 'Rae', 'rae@example.test', true, now(), now())`);
  await sql("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, 'user_reviewer', 'approver')", [ws]);
}, 120_000);

beforeEach(() => {
  state.sent = [];
});

describe("publishing", () => {
  it("refuses an allowed action that does not exist or is disabled", async () => {
    await service.createFunction(scope, { name: "bad-list" });
    await expect(service.publishVersion(scope, "bad-list", { language: "javascript", source: "x", allowedActions: ["refund", "nope", "switched_off"] }, { keyId, userId: null }))
      .rejects.toMatchObject({ statusCode: 400, code: "ALLOWED_ACTION_UNAVAILABLE", details: { missing: ["nope"], disabled: ["switched_off"] } });
  });

  it("appends a version with its digest and default budgets, and makes it current", async () => {
    await service.createFunction(scope, { name: "versions" });
    const first = await service.publishVersion(scope, "versions", { language: "javascript", source: "a", allowedActions: ["refund"] }, { keyId, userId: null });
    const second = await service.publishVersion(scope, "versions", { language: "python", source: "b", allowedActions: [], budgets: { maxActionCalls: 3 } }, { keyId, userId: null });
    expect(first.version).toMatchObject({ version: 1, digest: service.sourceDigest("a"), budgets: { maxActionCalls: 50, maxCpuMs: 1000, maxSubrequests: 100, timeoutMs: 30000 } });
    expect(second.version).toMatchObject({ version: 2, language: "python", budgets: { maxActionCalls: 3, maxCpuMs: 1000 } });
    expect(second.function.currentVersion?.id).toBe(second.version.id);
    expect(second.version.id).toMatch(/^fnv_/);
  });

  it("lists versions newest first, marks the current one, and reads one with its source", async () => {
    await service.createFunction(scope, { name: "history" });
    await expect(service.getVersion(scope, "history", "current")).rejects.toMatchObject({ statusCode: 404, code: "FUNCTION_VERSION_NOT_FOUND" });
    await service.publishVersion(scope, "history", { language: "javascript", source: "first source", allowedActions: [] }, { keyId, userId: null });
    await service.publishVersion(scope, "history", { language: "javascript", source: "second source", allowedActions: [] }, { keyId, userId: null });
    const versions = await service.listVersions(scope, "history");
    expect(versions.map((v) => [v.version, v.current])).toEqual([[2, true], [1, false]]);
    expect(versions[0]).not.toHaveProperty("source");
    expect(await service.getVersion(scope, "history", "current")).toMatchObject({ version: 2, current: true, source: "second source" });
    expect(await service.getVersion(scope, "history", 1)).toMatchObject({ version: 1, current: false, source: "first source" });
    await expect(service.getVersion(scope, "history", 3)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.listVersions({ ...scope, environmentId: randomUUID() }, "history")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses a second function with the same name", async () => {
    await expect(service.createFunction(scope, { name: "versions" })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("deleting a function", () => {
  it("archives it: gone from the list, no new runs, its runs kept, its name free again", async () => {
    const name = await publish("export default async function run() { return 1; }", []);
    const done = await run(name, async (): Promise<RunnerRunResponse> => ({ status: "succeeded", output: 1, logs: [], durationMs: 1 }));
    const archived = await service.archiveFunction(scope, name);
    expect(archived.name).toBe(name);
    expect((await service.listFunctions(scope)).map((f) => f.name)).not.toContain(name);
    await expect(run(name, async (): Promise<RunnerRunResponse> => ({ status: "succeeded", output: 1, logs: [], durationMs: 1 }))).rejects.toMatchObject({ statusCode: 404 });
    expect((await runs.getRun(scope, done.id)).id).toBe(done.id);
    await expect(service.archiveFunction(scope, name)).rejects.toMatchObject({ statusCode: 404 });
    expect((await service.createFunction(scope, { name })).name).toBe(name);
    await expect(service.createFunction(scope, { name })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("a straight-through run", () => {
  it("dispatches every call through governed invoke, for the run's end user, each with its own receipt", async () => {
    const name = await publish(
      script(async (input, anlyon) => {
        const order = await anlyon.read("lookup", { id: input.order });
        const refund = await anlyon.invoke("refund", { order: input.order, amount: 500 });
        return { order: order.ok, reply: order.result?.json, refund: refund.result?.status };
      }),
      ["lookup", "refund"],
      {},
      { actions: ["refund"], maxWrites: 1 },
    );
    const runner = fakeRunner();
    const result = await run(name, runner.send, { order: "o_1" }, "alice");

    expect(result).toMatchObject({ status: "succeeded", endUserId: "alice", output: { order: true, reply: { ok: true }, refund: "succeeded" }, actionCalls: 2 });
    const listed = await runs.listRuns(scope, name);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: result.id, mode: "straight_through", status: "succeeded", endUserId: "alice", version: 1, actionCalls: 2 });
    expect(await runs.listRuns(scope, name, { endUserId: "alice" })).toHaveLength(1);
    expect(await runs.listRuns(scope, name, { endUserId: "bob" })).toEqual([]);
    expect(runner.requests[0]).toMatchObject({ mode: "straight_through", allowedActions: ["lookup", "refund"], budgets: { maxActionCalls: 50 } });
    expect(runner.requests[0]!.runToken).toMatch(/^frt_v1\./);
    expect(state.sent).toEqual([
      { url: "https://shop.test/orders", method: "GET" },
      { url: "https://shop.test/refunds", method: "POST" },
    ]);

    expect(result.calls).toMatchObject([
      { sequence: 1, action: "lookup", kind: "read", state: "dispatched" },
      { sequence: 2, action: "refund", kind: "write", state: "dispatched" },
    ]);
    const invocationIds = result.calls.map((call) => call.invocationId);
    const { rows } = await sql("SELECT invocation_id, end_user_id, status, requested_by_key_id FROM action_invocations WHERE invocation_id = ANY($1) ORDER BY created_at", [invocationIds]);
    expect(rows).toEqual([
      { invocation_id: invocationIds[0], end_user_id: "alice", status: "succeeded", requested_by_key_id: keyId },
      { invocation_id: invocationIds[1], end_user_id: "alice", status: "succeeded", requested_by_key_id: keyId },
    ]);
    expect(result.receipt).toMatchObject({
      functionVersionId: result.functionVersionId,
      digest: expect.stringMatching(/^sha256:/),
      inputDigest: result.inputDigest,
      mode: "straight_through",
      outcome: "succeeded",
      budget: null,
      calls: [
        { sequence: 1, action: "lookup", invocationId: invocationIds[0] },
        { sequence: 2, action: "refund", invocationId: invocationIds[1] },
      ],
    });
    expect(await runs.getRun(scope, result.id)).toMatchObject({ id: result.id, status: "succeeded" });
  });

  it("refuses a read of an action that changes something", async () => {
    const name = await publish(script(async (_input, anlyon) => anlyon.read("refund", {})), ["refund"]);
    const result = await run(name, fakeRunner().send);
    expect(result.output).toMatchObject({ ok: false, error: { code: "NOT_A_READ" } });
    expect(state.sent).toEqual([]);
  });

  it("validates the input against the version's schema before anything runs", async () => {
    await service.createFunction(scope, { name: "typed" });
    await service.publishVersion(scope, "typed", {
      language: "javascript",
      source: script(async () => "ran"),
      allowedActions: [],
      inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
    }, { keyId, userId: null });
    const runner = fakeRunner();
    await expect(run("typed", runner.send, { amount: "lots" })).rejects.toMatchObject({ statusCode: 400 });
    expect(runner.requests).toEqual([]);
  });

  it("refuses a key that requires an end user when the run names none", async () => {
    const name = await publish(script(async () => "ran"), []);
    await expect(runs.startRun(scope, name, {}, { endUser: { endUserId: null, required: true }, actor, send: fakeRunner().send }))
      .rejects.toMatchObject({ code: "END_USER_REQUIRED" });
  });
});

describe("the allow-list at the API", () => {
  it("refuses an action outside the allow-list even when the runner sends it", async () => {
    const name = await publish(
      script(async (_input, anlyon) => [
        await anlyon.invoke("delete_customer", { id: "c_1" }),
        await anlyon.invoke(["de", "lete_customer"].join(""), {}),
        await anlyon.invoke("act_refund", {}),
      ]),
      ["refund"],
    );
    const result = await run(name, fakeRunner({ checkAllowList: false }).send);
    expect(result.output).toEqual([
      { ok: false, error: expect.objectContaining({ code: "ACTION_NOT_ALLOWED" }) },
      { ok: false, error: expect.objectContaining({ code: "ACTION_NOT_ALLOWED" }) },
      { ok: false, error: expect.objectContaining({ code: "ACTION_NOT_ALLOWED" }) },
    ]);
    expect(state.sent).toEqual([]);
    expect(result.calls.map((call) => [call.state, call.refusal, call.invocationId])).toEqual([
      ["refused", "ACTION_NOT_ALLOWED", null],
      ["refused", "ACTION_NOT_ALLOWED", null],
      ["refused", "ACTION_NOT_ALLOWED", null],
    ]);
  });

  it("refuses an allowed action disabled after publishing", async () => {
    await sql("INSERT INTO actions (workspace_id, environment_id, action_id, name, method, url_template) VALUES ($1, $2, 'act_later', 'later_off', 'POST', 'https://shop.test/later')", [ws, envId]);
    const name = await publish(script(async (_input, anlyon) => anlyon.invoke("later_off", {})), ["later_off"]);
    await sql("UPDATE actions SET enabled = false WHERE action_id = 'act_later'");
    const result = await run(name, fakeRunner().send);
    expect(result.output).toMatchObject({ ok: false, error: { code: "ACTION_DISABLED" } });
    expect(state.sent).toEqual([]);
  });
});

describe("run tokens", () => {
  it("refuses a token for another run, a forged or expired token, and an unsigned call", async () => {
    let otherRun: { runId: string; token: string } | null = null;
    const first = await publish(script(async (_input, anlyon) => { otherRun = { runId: anlyon.request.runId, token: anlyon.request.runToken }; return "first"; }), ["refund"]);
    await run(first, fakeRunner().send);

    const second = await publish(
      script(async (_input, anlyon) => {
        const { runId } = anlyon.request;
        const expired = mintRunToken(
          { run: runId, version: anlyon.request.functionVersionId, workspace: ws, environment: envId, endUser: null, endUserRequired: false, mode: "straight_through", planDigest: null },
          60,
          Date.now() - 3_600_000,
        );
        return [
          (await anlyon.raw("invoke", "refund", {}, { token: otherRun!.token })).error?.code,
          (await anlyon.raw("invoke", "refund", {}, { runId: otherRun!.runId })).error?.code,
          (await anlyon.raw("invoke", "refund", {}, { token: `${anlyon.request.runToken.slice(0, -4)}AAAA` })).error?.code,
          (await anlyon.raw("invoke", "refund", {}, { token: expired })).error?.code,
          (await anlyon.raw("invoke", "refund", {}, { signature: "t=1,v1=00" })).error?.code,
        ];
      }),
      ["refund"],
    );
    const result = await run(second, fakeRunner().send);
    expect(result.output).toEqual(["RUN_TOKEN_MISMATCH", "RUN_TOKEN_MISMATCH", "RUN_TOKEN_INVALID", "RUN_TOKEN_EXPIRED", "INVALID_RUNNER_SIGNATURE"]);
    expect(state.sent).toEqual([]);
  });

  it("refuses calls from a replayed runner request, and any call once the run has ended", async () => {
    let ended: { runId: string; token: string } | null = null;
    const name = await publish(
      script(async (_input, anlyon) => {
        ended = { runId: anlyon.request.runId, token: anlyon.request.runToken };
        await anlyon.invoke("lookup", {});
        return (await anlyon.raw("invoke", "lookup", {}, { execution: randomUUID() })).error?.code;
      }),
      ["lookup"],
    );
    const result = await run(name, fakeRunner().send);
    expect(result.output).toBe("RUN_EXECUTION_MISMATCH");
    expect(state.sent).toHaveLength(1);

    const body = JSON.stringify({ kind: "invoke", action: "lookup", input: {}, execution: randomUUID() });
    const path = `/api/internal/function-runs/${ended!.runId}/calls`;
    const late = await handleFunctionCall({ runId: ended!.runId, token: ended!.token, signature: signRunnerRequest(env.RUNNER_SHARED_SECRET!, "POST", path, body), path, body });
    expect(late.body).toMatchObject({ ok: false, error: { code: "RUN_NOT_RUNNING" } });
  });
});

describe("budgets", () => {
  it("stops a run at maxActionCalls, with a receipt that names it", async () => {
    const name = await publish(
      script(async (_input, anlyon) => {
        const answers = [];
        for (let i = 0; i < 3; i++) answers.push((await anlyon.invoke("lookup", { i })).ok);
        return answers;
      }),
      ["lookup"],
      { maxActionCalls: 2 },
    );
    const result = await run(name, fakeRunner().send);
    expect(result).toMatchObject({ status: "budget_exceeded", budget: "maxActionCalls", actionCalls: 2 });
    expect(result.receipt).toMatchObject({ outcome: "budget_exceeded", budget: "maxActionCalls" });
    expect(state.sent).toHaveLength(2);
    expect(result.calls.at(-1)).toMatchObject({ state: "refused", refusal: "BUDGET_EXCEEDED" });
  });

  it("stops a run at maxSubrequests, counting refused calls too", async () => {
    const name = await publish(
      script(async (_input, anlyon) => {
        for (let i = 0; i < 4; i++) await anlyon.raw("invoke", "delete_customer", {});
        return "done";
      }),
      ["lookup"],
      { maxSubrequests: 3 },
    );
    const result = await run(name, fakeRunner({ checkAllowList: false }).send);
    expect(result).toMatchObject({ status: "budget_exceeded", budget: "maxSubrequests" });
    expect(result.receipt).toMatchObject({ outcome: "budget_exceeded", budget: "maxSubrequests" });
    expect(result.calls.map((call) => call.refusal)).toEqual(["ACTION_NOT_ALLOWED", "ACTION_NOT_ALLOWED", "ACTION_NOT_ALLOWED", "BUDGET_EXCEEDED"]);
  });

  it("records maxCpuMs when the runner reports Cloudflare's CPU limit", async () => {
    const name = await publish(script(async () => "never"), [], { maxCpuMs: 50 });
    const runner = fakeRunner({
      answer: () => ({ status: "budget_exceeded", budget: "maxCpuMs", error: { code: "BUDGET_EXCEEDED", message: "cpu" }, logs: [], durationMs: 60 }),
    });
    const result = await run(name, runner.send);
    expect(runner.requests[0]!.budgets.maxCpuMs).toBe(50);
    expect(result).toMatchObject({ status: "budget_exceeded", budget: "maxCpuMs", receipt: { budget: "maxCpuMs" } });
  });

  it("records timeoutMs when the runner does not answer in time", async () => {
    const name = await publish(script(async () => "never"), [], { timeoutMs: 1000 });
    const result = await run(name, async () => { throw new RunnerTimeoutError(); });
    expect(result).toMatchObject({ status: "budget_exceeded", budget: "timeoutMs", receipt: { outcome: "budget_exceeded", budget: "timeoutMs" } });
  });
});

describe("the halt switch", () => {
  it("stops a run's calls once the environment is halted", async () => {
    const name = await publish(
      script(async (_input, anlyon) => {
        const before = (await anlyon.invoke("lookup", {})).ok;
        await sql("UPDATE environments SET halted_at = now() WHERE id = $1", [envId]);
        const after = (await anlyon.invoke("lookup", {})).error?.code;
        await sql("UPDATE environments SET halted_at = NULL WHERE id = $1", [envId]);
        return [before, after];
      }),
      ["lookup"],
    );
    const result = await run(name, fakeRunner().send);
    expect(result.output).toEqual([true, "ENVIRONMENT_HALTED"]);
    expect(state.sent).toHaveLength(1);
  });
});

describe("when the runner is down", () => {
  it("answers 503 FUNCTION_RUNNER_UNAVAILABLE and records the run as failed", async () => {
    const name = await publish(script(async () => "never"), []);
    const unreachable = (request: RunnerRunRequest) => sendRun(request, { url: "http://127.0.0.1:9", secret: env.RUNNER_SHARED_SECRET! });
    await expect(run(name, unreachable)).rejects.toMatchObject({ statusCode: 503, code: "FUNCTION_RUNNER_UNAVAILABLE" });
    const { rows } = await sql("SELECT r.status, r.error FROM function_runs r JOIN functions f ON f.id = r.function_row_id WHERE f.name = $1", [name]);
    expect(rows).toEqual([{ status: "failed", error: expect.objectContaining({ code: "FUNCTION_RUNNER_UNAVAILABLE" }) }]);
  });

  it("answers 503 without recording anything when no runner is configured", async () => {
    const name = await publish(script(async () => "never"), []);
    const url = env.FUNCTION_RUNNER_URL;
    env.FUNCTION_RUNNER_URL = undefined;
    try {
      await expect(run(name, fakeRunner().send)).rejects.toMatchObject({ statusCode: 503, code: "FUNCTION_RUNNER_UNAVAILABLE" });
    } finally {
      env.FUNCTION_RUNNER_URL = url;
    }
    const { rows } = await sql("SELECT count(*)::int AS n FROM function_runs r JOIN functions f ON f.id = r.function_row_id WHERE f.name = $1", [name]);
    expect(rows[0]!.n).toBe(0);
  });
});

describe("erasing an end user", () => {
  it("keeps their function runs under the hash, and stops a run still going", async () => {
    const connections = await import("../src/core/end-users/connections.ts");
    const approvals = await import("../src/core/approvals/service.ts");
    let afterErase: string | undefined;
    const name = await publish(
      script(async (_input, anlyon) => {
        await anlyon.invoke("lookup", {});
        await connections.eraseEndUser(scope, "zoe", actor, approvals.cancelEndUserApprovals);
        afterErase = (await anlyon.invoke("lookup", {})).error?.code;
        return "done";
      }),
      ["lookup"],
    );
    const result = await run(name, fakeRunner().send, {}, "zoe");
    expect(afterErase).toBe("RUN_TOKEN_MISMATCH");
    expect(result.endUserId).toMatch(/^erased~/);
    expect(state.sent).toHaveLength(1);
  });
});

describe("plan, then apply", () => {
  const approvals = () => import("../src/core/approvals/service.ts");
  const asReviewer = { deciderUserId: "user_reviewer" };

  function refundAndEmail(amount: () => number) {
    return script(async (input, anlyon) => {
      const order = await anlyon.read("lookup", { id: input.order });
      const refund = await anlyon.invoke("refund", { order: input.order, amount: amount() });
      const email = await anlyon.invoke("email", { to: "alice@example.test", subject: "Refunded" });
      return { order: order.ok, refund: refund.result, email: email.result };
    });
  }

  function apply(name: string, planRunId: string, send: (request: RunnerRunRequest) => Promise<RunnerRunResponse>, endUserId: string | null = null, input?: Record<string, unknown>) {
    return runs.startRun(scope, name, input, { mode: "apply", planRunId, endUser: { endUserId, required: false }, requestedByKeyId: keyId, actor, send });
  }

  it("a plan run reads for real, records each write without sending it, and ends awaiting one approval of the exact writes", async () => {
    const name = await publish(refundAndEmail(() => 500), ["lookup", "refund", "email"]);
    const runner = fakeRunner();
    const plan = await run(name, runner.send, { order: "o_1" }, null, "plan");

    expect(runner.requests[0]).toMatchObject({ mode: "plan" });
    expect(state.sent).toEqual([{ url: "https://shop.test/orders", method: "GET" }]);
    expect(plan).toMatchObject({ mode: "plan", status: "awaiting_approval", output: { order: true, refund: { planned: true }, email: { planned: true } } });
    expect(plan.calls).toMatchObject([
      { sequence: 1, action: "lookup", kind: "read", state: "dispatched" },
      { sequence: 2, action: "refund", kind: "write", state: "intent", invocationId: null },
      { sequence: 3, action: "email", kind: "write", state: "intent", invocationId: null },
    ]);
    expect(plan.plan).toMatchObject({
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      writes: [
        { sequence: 2, action: "refund", input: { order: "o_1", amount: 500 } },
        { sequence: 3, action: "email", input: { to: "alice@example.test", subject: "Refunded" } },
      ],
      approval: { id: expect.stringMatching(/^apr_/), status: "pending", decider: "team" },
      appliedByRunId: null,
    });
    expect(plan.receipt).toMatchObject({ mode: "plan", outcome: "awaiting_approval", planDigest: plan.plan!.digest, approvalId: plan.plan!.approval!.id });

    const approval = await (await approvals()).getApproval(ws, plan.plan!.approval!.id, envId);
    expect(approval).toMatchObject({ kind: "function_plan", status: "pending", decider: "team", payload: { planRunId: plan.id, planDigest: plan.plan!.digest, writes: plan.plan!.writes } });
    const { rows } = await sql("SELECT binding_digest FROM approvals WHERE approval_id = $1", [approval.id]);
    expect(rows[0]!.binding_digest).toBe(plan.plan!.digest);
  });

  it("a plan approved longer ago than the apply window is refused PLAN_EXPIRED, and nothing is sent", async () => {
    const name = await publish(refundAndEmail(() => 500), ["lookup", "refund", "email"]);
    const plan = await run(name, fakeRunner().send, { order: "o_expired" }, null, "plan");
    await (await approvals()).approveApproval(ws, plan.plan!.approval!.id, asReviewer, envId);
    await sql(
      `UPDATE approvals SET decided_at = now() - make_interval(hours => $2) WHERE approval_id = $1`,
      [plan.plan!.approval!.id, runs.PLAN_APPLY_WINDOW_HOURS + 1],
    );
    state.sent = [];
    const runner = fakeRunner();
    await expect(apply(name, plan.id, runner.send)).rejects.toMatchObject({ statusCode: 409, code: "PLAN_EXPIRED" });
    expect(runner.requests).toEqual([]);
    expect(state.sent).toEqual([]);

    await sql(`UPDATE approvals SET decided_at = now() - interval '1 hour' WHERE approval_id = $1`, [plan.plan!.approval!.id]);
    expect(await apply(name, plan.id, fakeRunner().send)).toMatchObject({ status: "succeeded" });
  });

  it("an approved plan applies: each write is dispatched with its own receipt, in the approved order", async () => {
    const name = await publish(refundAndEmail(() => 500), ["lookup", "refund", "email"]);
    const plan = await run(name, fakeRunner().send, { order: "o_2" }, null, "plan");
    await expect(apply(name, plan.id, fakeRunner().send)).rejects.toMatchObject({ statusCode: 409, code: "PLAN_NOT_APPROVED" });

    await (await approvals()).approveApproval(ws, plan.plan!.approval!.id, asReviewer, envId);
    state.sent = [];
    const runner = fakeRunner();
    const applied = await apply(name, plan.id, runner.send);

    expect(runner.requests[0]).toMatchObject({ mode: "apply", input: { order: "o_2" } });
    expect(applied).toMatchObject({ mode: "apply", status: "succeeded", planRunId: plan.id, planDigest: plan.plan!.digest, approvalId: plan.plan!.approval!.id });
    expect(state.sent).toEqual([
      { url: "https://shop.test/orders", method: "GET" },
      { url: "https://shop.test/refunds", method: "POST" },
      { url: "https://mail.test/send", method: "POST" },
    ]);
    expect(applied.calls).toMatchObject([
      { action: "lookup", state: "dispatched", plannedSequence: null },
      { action: "refund", state: "dispatched", plannedSequence: 2, invocationId: expect.stringMatching(/^inv_/) },
      { action: "email", state: "dispatched", plannedSequence: 3, invocationId: expect.stringMatching(/^inv_/) },
    ]);
    expect(applied.receipt).toMatchObject({ mode: "apply", outcome: "succeeded", planRunId: plan.id, planDigest: plan.plan!.digest });
    expect((await runs.getRun(scope, plan.id)).plan).toMatchObject({ approval: { status: "approved" }, appliedByRunId: applied.id });

    await expect(apply(name, plan.id, fakeRunner().send)).rejects.toMatchObject({ statusCode: 409, code: "PLAN_ALREADY_APPLIED" });
  });

  it("a changed amount diverges: the run stops before sending it, and sends nothing after", async () => {
    let amount = 500;
    const name = await publish(refundAndEmail(() => amount), ["lookup", "refund", "email"]);
    const plan = await run(name, fakeRunner().send, { order: "o_3" }, null, "plan");
    await (await approvals()).approveApproval(ws, plan.plan!.approval!.id, asReviewer, envId);

    amount = 5000;
    state.sent = [];
    const applied = await apply(name, plan.id, fakeRunner().send);

    expect(applied).toMatchObject({ status: "diverged", error: { code: "RUN_DIVERGED" } });
    expect(applied.output).toBeNull();
    expect(state.sent).toEqual([{ url: "https://shop.test/orders", method: "GET" }]);
    expect(applied.calls).toMatchObject([
      { action: "lookup", state: "dispatched" },
      { action: "refund", state: "refused", refusal: "RUN_DIVERGED", invocationId: null },
    ]);
    expect(applied.calls).toHaveLength(2);
    expect(applied.receipt).toMatchObject({ outcome: "diverged" });
    const { flushAuditEvents } = await import("../src/core/audit/recorder.ts");
    await flushAuditEvents();
    const { rows } = await sql("SELECT type, resource_id FROM audit_events WHERE resource_id IN ($1, $2)", [plan.id, applied.id]);
    expect(rows).toEqual(expect.arrayContaining([
      { type: "function.run_planned", resource_id: plan.id },
      { type: "function.run_diverged", resource_id: applied.id },
    ]));
  });

  it("an apply run that makes fewer writes than approved ends diverged", async () => {
    let skipEmail = false;
    const name = await publish(
      script(async (_input, anlyon) => {
        await anlyon.invoke("refund", { order: "o_4", amount: 1 });
        if (!skipEmail) await anlyon.invoke("email", { to: "a@example.test" });
        return "done";
      }),
      ["refund", "email"],
    );
    const plan = await run(name, fakeRunner().send, {}, null, "plan");
    await (await approvals()).approveApproval(ws, plan.plan!.approval!.id, asReviewer, envId);
    skipEmail = true;
    const applied = await apply(name, plan.id, fakeRunner().send);
    expect(applied).toMatchObject({ status: "diverged", error: { code: "RUN_DIVERGED", message: expect.stringContaining("1 of the 2") } });
  });

  it("an action edited after its plan was approved is not sent under that approval", async () => {
    await sql(
      `INSERT INTO actions (workspace_id, environment_id, action_id, name, method, url_template, enabled, current_version_id)
       VALUES ($1, $2, 'act_payout', 'payout', 'POST', 'https://shop.test/payouts', true, 'acv_payout_1')`,
      [ws, envId],
    );
    const name = await publish(script(async (_input, anlyon) => anlyon.invoke("payout", { amount: 10 })), ["payout"]);
    const plan = await run(name, fakeRunner().send, {}, null, "plan");
    await (await approvals()).approveApproval(ws, plan.plan!.approval!.id, asReviewer, envId);

    await sql("UPDATE actions SET url_template = 'https://attacker.test/collect', current_version_id = 'acv_payout_2' WHERE action_id = 'act_payout'");
    state.sent = [];
    const applied = await apply(name, plan.id, fakeRunner().send);

    expect(state.sent).toEqual([]);
    expect(applied).toMatchObject({ status: "diverged", error: { code: "RUN_DIVERGED", message: expect.stringContaining("changed") } });
    expect(applied.calls).toMatchObject([{ action: "payout", state: "refused", refusal: "RUN_DIVERGED", invocationId: null }]);
  });

  it("a plan-only run sends nothing that changes anything, and one with no writes needs no approval", async () => {
    const writes = await publish(refundAndEmail(() => 500), ["lookup", "refund", "email"]);
    const planned = await run(writes, fakeRunner().send, { order: "o_5" }, null, "plan");
    expect(planned.status).toBe("awaiting_approval");
    expect(state.sent.filter((sent) => sent.method !== "GET")).toEqual([]);

    const readsOnly = await publish(script(async (_input, anlyon) => (await anlyon.read("lookup", {})).ok), ["lookup"]);
    const plan = await run(readsOnly, fakeRunner().send, {}, null, "plan");
    expect(plan).toMatchObject({ status: "planned", output: true, plan: { writes: [], approval: null } });
    await expect(apply(readsOnly, plan.id, fakeRunner().send)).rejects.toMatchObject({ statusCode: 409, code: "PLAN_HAS_NO_WRITES" });
  });

  it("an apply takes its plan's input, end user and version, and nothing else", async () => {
    const name = await publish(refundAndEmail(() => 500), ["lookup", "refund", "email"]);
    const plan = await run(name, fakeRunner().send, { order: "o_6" }, "alice", "plan");
    expect(plan.plan!.approval!.decider).toBe("team");
    await (await approvals()).approveApproval(ws, plan.plan!.approval!.id, asReviewer, envId);

    await expect(apply(name, plan.id, fakeRunner().send, "bob")).rejects.toMatchObject({ statusCode: 404, code: "FUNCTION_RUN_NOT_FOUND" });
    await expect(apply(name, plan.id, fakeRunner().send, "alice", { order: "o_other" })).rejects.toMatchObject({ statusCode: 409, code: "PLAN_INPUT_MISMATCH" });

    await service.publishVersion(scope, name, { language: "javascript", source: script(async () => "v2"), allowedActions: [] }, { keyId, userId: null });
    const runner = fakeRunner();
    const applied = await apply(name, plan.id, runner.send, "alice", { order: "o_6" });
    expect(applied).toMatchObject({ status: "succeeded", endUserId: "alice", functionVersionId: plan.functionVersionId });
    expect(runner.requests[0]!.functionVersionId).toBe(plan.functionVersionId);
  });

  it("an apply run's token must carry the approved plan's digest", async () => {
    let codes: Array<string | undefined> = [];
    const name = await publish(
      script(async (_input, anlyon) => {
        if (anlyon.request.mode === "apply") {
          const base = { run: anlyon.request.runId, version: anlyon.request.functionVersionId, workspace: ws, environment: envId, endUser: null, endUserRequired: false, mode: "apply" as const };
          codes = [
            (await anlyon.raw("invoke", "refund", { amount: 1 }, { token: mintRunToken({ ...base, planDigest: `sha256:${"0".repeat(64)}` }, 60) })).error?.code,
            (await anlyon.raw("invoke", "refund", { amount: 1 }, { token: mintRunToken({ ...base, planDigest: null }, 60) })).error?.code,
          ];
        }
        return anlyon.invoke("refund", { amount: 1 });
      }),
      ["refund"],
    );
    const plan = await run(name, fakeRunner().send, {}, null, "plan");
    await (await approvals()).approveApproval(ws, plan.plan!.approval!.id, asReviewer, envId);
    state.sent = [];
    const applied = await apply(name, plan.id, fakeRunner().send);
    expect(codes).toEqual(["RUN_TOKEN_MISMATCH", "RUN_TOKEN_MISMATCH"]);
    expect(applied.status).toBe("succeeded");
    expect(state.sent).toHaveLength(1);
  });

  it("frees the plan for another apply when the runner could not be reached and nothing ran", async () => {
    const name = await publish(refundAndEmail(() => 500), ["lookup", "refund", "email"]);
    const plan = await run(name, fakeRunner().send, { order: "o_7" }, null, "plan");
    await (await approvals()).approveApproval(ws, plan.plan!.approval!.id, asReviewer, envId);
    const unreachable = (request: RunnerRunRequest) => sendRun(request, { url: "http://127.0.0.1:9", secret: env.RUNNER_SHARED_SECRET! });
    await expect(apply(name, plan.id, unreachable)).rejects.toMatchObject({ statusCode: 503 });
    expect(await apply(name, plan.id, fakeRunner().send)).toMatchObject({ status: "succeeded" });
  });

  it("an end user decides their own plan, through the end-user approval path only", async () => {
    await sql(`INSERT INTO approval_policies (workspace_id, environment_id, policy_id, name, match_kind, match_action_name, effect, decided_by, required_approvals) VALUES
      ($1, $2, 'apol_fn_refund', 'Users decide refunds', 'action', 'refund', 'require_approval', 'end_user', 2),
      ($1, $2, 'apol_fn_email', 'Users decide email', 'action', 'email', 'require_approval', 'end_user', 1)`, [ws, envId]);
    try {
      const service_ = await approvals();
      const name = await publish(refundAndEmail(() => 500), ["lookup", "refund", "email"]);
      const plan = await run(name, fakeRunner().send, { order: "o_8" }, "alice", "plan");
      const approvalId = plan.plan!.approval!.id;
      expect(plan.plan!.approval).toMatchObject({ decider: "end_user" });
      expect(await service_.getApproval(ws, approvalId, envId)).toMatchObject({ endUserId: "alice", decider: "end_user", requiredApprovals: 1 });
      await expect(service_.approveApproval(ws, approvalId, asReviewer, envId)).rejects.toMatchObject({ statusCode: 404 });
      await expect(service_.approveApproval(ws, approvalId, { deciderKeyId: keyId, endUserId: "bob" }, envId)).rejects.toMatchObject({ statusCode: 404 });
      expect((await service_.listEndUserApprovals(scope, "alice")).approvals.map((approval) => approval.id)).toContain(approvalId);

      await service_.approveApproval(ws, approvalId, { deciderKeyId: keyId, endUserId: "alice" }, envId);
      state.sent = [];
      const applied = await apply(name, plan.id, fakeRunner().send, "alice");
      expect(applied).toMatchObject({ status: "succeeded", endUserId: "alice" });
      expect(state.sent.filter((sent) => sent.method === "POST")).toHaveLength(2);
      const invocationIds = applied.calls.filter((call) => call.kind === "write").map((call) => call.invocationId);
      const { rows } = await sql("SELECT end_user_id, status, approval_id, decision->>'code' AS code FROM action_invocations WHERE invocation_id = ANY($1)", [invocationIds]);
      expect(rows).toEqual([
        { end_user_id: "alice", status: "succeeded", approval_id: approvalId, code: "HUMAN_APPROVED" },
        { end_user_id: "alice", status: "succeeded", approval_id: approvalId, code: "HUMAN_APPROVED" },
      ]);
    } finally {
      await sql("DELETE FROM approval_policies WHERE policy_id IN ('apol_fn_refund', 'apol_fn_email')");
    }
  });

  it("a plan whose write a policy denies outright is denied, and cannot be applied", async () => {
    await sql(`INSERT INTO approval_policies (workspace_id, environment_id, policy_id, name, match_kind, match_action_name, effect) VALUES
      ($1, $2, 'apol_fn_deny', 'No email', 'action', 'email', 'auto_deny')`, [ws, envId]);
    try {
      const name = await publish(refundAndEmail(() => 500), ["lookup", "refund", "email"]);
      const plan = await run(name, fakeRunner().send, { order: "o_9" }, null, "plan");
      expect(plan.plan!.approval).toMatchObject({ status: "denied" });
      await expect(apply(name, plan.id, fakeRunner().send)).rejects.toMatchObject({ code: "PLAN_NOT_APPROVED" });
    } finally {
      await sql("DELETE FROM approval_policies WHERE policy_id = 'apol_fn_deny'");
    }
  });
});

describe("straight through", () => {
  it("writes only under the version's policy: its actions, up to its limit", async () => {
    const source = script(async (_input, anlyon) => [
      (await anlyon.invoke("refund", { amount: 1 })).ok,
      (await anlyon.invoke("refund", { amount: 2 })).error?.code,
      (await anlyon.invoke("email", {})).error?.code,
      (await anlyon.read("lookup", {})).ok,
    ]);
    const governed = await publish(source, ["lookup", "refund", "email"], {}, { actions: ["refund"], maxWrites: 1 });
    const result = await run(governed, fakeRunner().send);
    expect(result).toMatchObject({ mode: "straight_through", status: "succeeded", output: [true, "PLAN_REQUIRED", "PLAN_REQUIRED", true] });
    expect(state.sent).toEqual([
      { url: "https://shop.test/refunds", method: "POST" },
      { url: "https://shop.test/orders", method: "GET" },
    ]);
    expect(result.calls[0]).toMatchObject({ action: "refund", state: "dispatched", invocationId: expect.stringMatching(/^inv_/) });

    state.sent = [];
    const ungoverned = await publish(source, ["lookup", "refund", "email"]);
    const refused = await run(ungoverned, fakeRunner().send);
    expect(refused.output).toEqual([false, "PLAN_REQUIRED", "PLAN_REQUIRED", true]);
    expect(state.sent).toEqual([{ url: "https://shop.test/orders", method: "GET" }]);
  });

  it("refuses a policy that names an action the version may not call", async () => {
    await service.createFunction(scope, { name: "bad-policy" });
    await expect(service.publishVersion(scope, "bad-policy", {
      language: "javascript", source: "x", allowedActions: ["refund"], straightThrough: { actions: ["email"], maxWrites: 1 },
    }, { keyId, userId: null })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("an apply whose approved write does not go through", () => {
  it("stops the run, and sends none of the writes after it", async () => {
    const approvals = await import("../src/core/approvals/service.ts");
    const name = await publish(
      script(async (_input, anlyon) => {
        await anlyon.invoke("refund", { order: "o_10", amount: 1 });
        await anlyon.invoke("email", { to: "a@example.test" });
        return "done";
      }),
      ["refund", "email"],
    );
    const plan = await run(name, fakeRunner().send, {}, null, "plan");
    await approvals.approveApproval(ws, plan.plan!.approval!.id, { deciderUserId: "user_reviewer" }, envId);
    await sql(`INSERT INTO approval_policies (workspace_id, environment_id, policy_id, name, match_kind, match_action_name, effect, required_approvals)
      VALUES ($1, $2, 'apol_fn_two', 'Two for refunds', 'action', 'refund', 'require_approval', 2)`, [ws, envId]);
    try {
      state.sent = [];
      const applied = await runs.startRun(scope, name, undefined, { mode: "apply", planRunId: plan.id, endUser: { endUserId: null, required: false }, requestedByKeyId: keyId, actor, send: fakeRunner().send });
      expect(applied).toMatchObject({ status: "failed", error: { code: "APPLY_STOPPED" } });
      expect(state.sent).toEqual([]);
      expect(applied.calls.map((call) => call.action)).toEqual(["refund"]);
    } finally {
      await sql("DELETE FROM approval_policies WHERE policy_id = 'apol_fn_two'");
    }
  });
});

describe("AST and AI review at publish: advice, never enforcement", () => {
  const review = () => import("../src/core/functions/review.ts");
  const source = `export default async function run(input, anlyon) {
    await anlyon.read("lookup", {});
    for (const order of input.orders) await anlyon.invoke("refund", { order });
  }`;

  it("proposes the allow-list from literal calls when none is given, and stores the findings", async () => {
    await service.createFunction(scope, { name: "proposed" });
    const published = await service.publishVersion(scope, "proposed", { language: "javascript", source }, { keyId, userId: null }, { review: "off" });
    expect(published.version.allowedActions).toEqual(["lookup", "refund"]);
    expect(published.version.review).toMatchObject({
      ast: { parsed: true, proposedAllowedActions: ["lookup", "refund"], writesInLoop: [{ action: "refund", line: 3 }] },
      ai: null,
    });
  });

  it("needs a hand-written allow-list when a name is computed or the source does not parse", async () => {
    await service.createFunction(scope, { name: "computed" });
    const computed = "export default async function run(input, anlyon) { return anlyon.invoke(input.action, {}); }";
    await expect(service.publishVersion(scope, "computed", { language: "javascript", source: computed }, { keyId, userId: null }, { review: "off" }))
      .rejects.toMatchObject({ statusCode: 400, code: "ALLOWED_ACTIONS_REQUIRED" });
    await expect(service.publishVersion(scope, "computed", { language: "python", source: "def run(:" }, { keyId, userId: null }, { review: "off" }))
      .rejects.toMatchObject({ statusCode: 400, code: "ALLOWED_ACTIONS_REQUIRED" });
    const listed = await service.publishVersion(scope, "computed", { language: "javascript", source: computed, allowedActions: ["refund"] }, { keyId, userId: null }, { review: "off" });
    expect(listed.version.review?.ast.computedActionNames).toHaveLength(1);
  });

  it("publishes with the source findings alone when no model is configured", async () => {
    await service.createFunction(scope, { name: "no-model" });
    const published = await service.publishVersion(scope, "no-model", { language: "javascript", source }, { keyId, userId: null }, { review: "off" });
    const { rows } = await sql("SELECT id FROM function_versions WHERE version_id = $1", [published.version.id]);
    const ai = await (await review()).reviewVersion(rows[0]!.id as string);
    expect(ai).toMatchObject({ status: "skipped", reason: "not_configured", summary: null });
    const { rows: stored } = await sql("SELECT review FROM function_versions WHERE version_id = $1", [published.version.id]);
    expect(stored[0]!.review).toMatchObject({ ast: { proposedAllowedActions: ["lookup", "refund"] }, ai: { status: "skipped" } });
  });

  it("stores the review on the version, with a summary composed from its answers, and shows it in the plan's approval", async () => {
    const { reviewVersion } = await review();
    const key = env.TYPESAFE_API_KEY;
    env.TYPESAFE_API_KEY = "test-typesafe-key";
    await sql("INSERT INTO workspace_assistant_settings (workspace_id, enabled, consent_version) VALUES ($1, true, '2026-09-24') ON CONFLICT (workspace_id) DO UPDATE SET enabled = true, consent_version = '2026-09-24'", [ws]);
    try {
      const name = await publish(script(async (_input, anlyon) => { await anlyon.invoke("refund", { order: "o_r" }); }, source), ["lookup", "refund"]);
      const { rows } = await sql("SELECT v.id FROM function_versions v JOIN functions f ON f.id = v.function_row_id WHERE f.name = $1", [name]);
      const ask = vi.fn(async () => ({
        ok: true as const,
        latencyMs: 5,
        response: {
          model: "jev-1.13.0",
          answers: {
            purpose: { type: "choice" as const, choice: "refunds", confidence: 0.9, probabilities: { refunds: 0.9 } },
            risk: { type: "score" as const, score: 3.2, confidence: 0.8, probabilities: {} },
            writes_in_loop: { type: "noul" as const, noul: 0.95 },
            money_per_item: { type: "noul" as const, noul: 0.9 },
            amount_from_input: { type: "noul" as const, noul: 0.1 },
            unchecked_write: { type: "noul" as const, noul: 0.2 },
          },
        },
      }));
      const ai = await reviewVersion(rows[0]!.id as string, { ask });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ai).toMatchObject({ status: "reviewed", model: "vigil-1", purpose: "refunds", suggestedRiskTier: "high" });
      expect(ai.riskyPatterns.map((pattern) => pattern.pattern)).toEqual(["writes_in_loop", "money_per_item"]);
      expect(ai.summary).toContain("Writes refund.");

      const plan = await run(name, fakeRunner().send, {}, null, "plan");
      const approval = await (await import("../src/core/approvals/service.ts")).getApproval(ws, plan.plan!.approval!.id, envId);
      expect(approval.payload.review).toMatchObject({ summary: ai.summary, suggestedRiskTier: "high", writesInLoop: 1, confidence: 0.8, truncated: false });
    } finally {
      env.TYPESAFE_API_KEY = key;
      await sql("UPDATE workspace_assistant_settings SET enabled = false WHERE workspace_id = $1", [ws]);
    }
  });

  it("allows and refuses exactly the same calls whatever the review says", async () => {
    const calls = script(async (_input, anlyon) => [
      (await anlyon.read("lookup", {})).ok,
      (await anlyon.raw("invoke", "delete_customer", {})).error?.code,
    ], source);
    const reviewed = await publish(calls, ["lookup", "refund"], {}, { actions: ["refund"], maxWrites: 1 });
    const plain = await publish(calls, ["lookup", "refund"], {}, { actions: ["refund"], maxWrites: 1 });
    await sql(
      `UPDATE function_versions v SET review = $2::jsonb FROM functions f WHERE f.id = v.function_row_id AND f.name = $1`,
      [reviewed, JSON.stringify({
        ast: { parsed: true, calls: [{ kind: "invoke", action: "delete_customer", line: 1 }], proposedAllowedActions: ["delete_customer", "lookup", "refund"], computedActionNames: [], risky: [], writesInLoop: [] },
        ai: { status: "reviewed", suggestedRiskTier: "routine", riskyPatterns: [], summary: "Harmless." },
      })],
    );
    await sql("UPDATE function_versions v SET review = NULL FROM functions f WHERE f.id = v.function_row_id AND f.name = $1", [plain]);

    const outputs = [];
    for (const name of [reviewed, plain]) {
      state.sent = [];
      const result = await run(name, fakeRunner({ checkAllowList: false }).send);
      outputs.push({ output: result.output, sent: state.sent, calls: result.calls.map((call) => [call.action, call.state, call.refusal]) });
    }
    expect(outputs[0]).toEqual(outputs[1]);
    expect(outputs[0]!.output).toEqual([true, "ACTION_NOT_ALLOWED"]);
  });
});

describe("2026-10-28 review fixes at the API", () => {
  it("narrowing the starting key's scopes stops a running run at its next call", async () => {
    const name = await publish(
      script(async (_input, anlyon) => {
        const before = await anlyon.read("lookup", {});
        await sql(`UPDATE api_keys SET scopes = '["functions:run"]'::jsonb WHERE id = $1`, [keyId]);
        const after = await anlyon.read("lookup", {});
        return { before: before.ok, after: after.error?.code ?? null };
      }),
      ["lookup"],
    );
    try {
      const result = await run(name, fakeRunner().send);
      expect(result.output).toEqual({ before: true, after: "CREDENTIAL_NO_LONGER_ALLOWED" });
      expect(state.sent).toEqual([{ url: "https://shop.test/orders", method: "GET" }]);
    } finally {
      await sql(`UPDATE api_keys SET scopes = '["functions:run","actions:invoke"]'::jsonb WHERE id = $1`, [keyId]);
    }
  });

  it("removing the member who started a run stops it at its next call", async () => {
    await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('user_starter', 'Sam', 'sam@example.test', true, now(), now()) ON CONFLICT DO NOTHING`);
    await sql("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, 'user_starter', 'member') ON CONFLICT DO NOTHING", [ws]);
    const name = await publish(
      script(async (_input, anlyon) => {
        const before = await anlyon.read("lookup", {});
        await sql("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = 'user_starter'", [ws]);
        const after = await anlyon.read("lookup", {});
        return { before: before.ok, after: after.error?.code ?? null };
      }),
      ["lookup"],
    );
    const result = await runs.startRun(scope, name, {}, {
      mode: "straight_through",
      endUser: { endUserId: null, required: false },
      requestedByKeyId: null,
      requestedByUserId: "user_starter",
      actor: { type: "user" as const, id: "user_starter" },
      send: fakeRunner().send,
    });
    expect(result.output).toEqual({ before: true, after: "CREDENTIAL_NO_LONGER_ALLOWED" });
  });

  it("a call signed with the rotating secret is accepted while RUNNER_SHARED_SECRET_ROTATING is set, and only then", async () => {
    const rotating = "the-next-runner-shared-secret-0123456789";
    const name = await publish(
      script(async (_input, anlyon) => {
        const path = `/api/internal/function-runs/${anlyon.request.runId}/calls`;
        const signed = (secret: string, execution: string) => ({
          signature: signRunnerRequest(secret, "POST", path, JSON.stringify({ kind: "read", action: "lookup", input: {}, execution })),
          execution,
        });
        const before = (await anlyon.raw("read", "lookup", {}, signed(rotating, "exec-before"))).error?.code ?? "ok";
        env.RUNNER_SHARED_SECRET_ROTATING = rotating;
        const during = (await anlyon.raw("read", "lookup", {}, signed(rotating, "exec-before"))).ok;
        return { before, during };
      }),
      ["lookup"],
    );
    try {
      expect((await run(name, fakeRunner().send)).output).toEqual({ before: "INVALID_RUNNER_SIGNATURE", during: true });
    } finally {
      delete env.RUNNER_SHARED_SECRET_ROTATING;
    }
  });

  it("each end user's runs get their own isolate key, and runs without one share the version's", async () => {
    const name = await publish(script(async () => "ok"), ["lookup"]);
    const runner = fakeRunner();
    await run(name, runner.send, {}, "alice");
    await run(name, runner.send, {}, "bob");
    await run(name, runner.send, {}, "alice");
    await run(name, runner.send, {}, null);
    const keys = runner.requests.map((request) => request.isolation);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(keys[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).toBe("shared");
    expect(JSON.stringify(runner.requests.map((request) => request.isolation))).not.toMatch(/alice|bob/);
  });
});
