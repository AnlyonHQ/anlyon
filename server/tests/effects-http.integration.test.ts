import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { providerFetch } from "./support/effects/provider-fetch.ts";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});

const { EffectScope, loadEffectModules } = await import("./support/effects/fixture.ts");

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("governed effects over HTTP (real Postgres)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let m: Awaited<ReturnType<typeof loadEffectModules>>;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let budgets: typeof import("../src/core/billing/budgets.ts");
  let s: InstanceType<typeof EffectScope>;

  beforeAll(async () => {
    await pool.query("SELECT 1");
    m = await loadEffectModules();
    app = (await import("../src/api/index.ts")).default as typeof app;
    budgets = await import("../src/core/billing/budgets.ts");
  });
  beforeEach(async () => { s = await new EffectScope(pool, m).seed(); });
  afterEach(async () => { await s.cleanup(); });
  afterAll(async () => { await pool.end(); });

  const call = (key: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`/api/v2${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("an operation-key replay answers from the existing effect and holds no second budget reservation", async () => {
    await s.refundAction();
    const agent = await s.apiKey("agent");
    await budgets.putBudget(s.workspaceId, agent.id, { monthlyCostCentsCap: 100_000, enabled: true });
    const body = { input: s.refund(1500), operationKey: "order-9-refund" };
    const first = await call(agent.key, "POST", "/actions/refund/invoke", body, { "Idempotency-Key": "k-1" });
    const second = await call(agent.key, "POST", "/actions/refund/invoke", body, { "Idempotency-Key": "k-2" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const [a, b] = [(await first.json()).data, (await second.json()).data];
    expect(b.effectId).toBe(a.effectId);
    expect(s.stripe.refunds).toHaveLength(1);
    const { rows } = await pool.query("SELECT state FROM budget_reservations WHERE api_key_id = $1", [agent.id]);
    expect(rows.filter((r) => r.state === "reserved")).toHaveLength(0);
    expect(rows).toHaveLength(2);
  });

  it("GET /actions/effects reports hasMore from the offset, not from a page number", async () => {
    await s.refundAction();
    const agent = await s.apiKey("agent");
    for (const pi of ["pi_order1", "pi_order2", "pi_order3"]) await s.invoke("refund", s.refund(100, pi));
    const list = async (query: string) => (await (await call(agent.key, "GET", `/actions/effects?${query}`)).json());
    const tail = await list("offset=1&limit=2");
    expect(tail.data).toHaveLength(2);
    expect(tail.pagination).toMatchObject({ total: 3, limit: 2, hasMore: false });
    const head = await list("offset=0&limit=2");
    expect(head.pagination).toMatchObject({ total: 3, limit: 2, page: 1, totalPages: 2, hasMore: true });
    const middle = await list("offset=1&limit=1");
    expect(middle.pagination).toMatchObject({ total: 3, hasMore: true });
  });

  it("recovery stays available during a halt; new work and replays do not", async () => {
    await s.refundAction();
    const agent = await s.apiKey("agent");
    const operator = await s.apiKey("operator", ["actions:read", "actions:invoke", "actions:resolve"]);
    s.stripe.fault("write", "lose_response_after_commit");
    const invoked = await (await call(agent.key, "POST", "/actions/refund/invoke", { input: s.refund(900) })).json();
    const effectId = invoked.data.effectId as string;
    expect(invoked.data.status).toBe("unknown");

    await m.halt.haltEnvironment(s.workspaceId, s.environmentId, { reason: "incident" });
    try {
      expect((await call(agent.key, "POST", "/actions/refund/invoke", { input: s.refund(100) })).status).toBeGreaterThanOrEqual(400);
      expect((await call(operator.key, "POST", `/actions/effects/${effectId}/replay`)).status).toBe(409);
      expect((await call(operator.key, "POST", `/actions/effects/${effectId}/notes`, { note: "Checked during the incident." })).status).toBe(201);
      const reconciled = await call(operator.key, "POST", `/actions/effects/${effectId}/reconcile`);
      expect(reconciled.status).toBe(200);
      expect((await reconciled.json()).data.outcome).toBe("succeeded");
    } finally {
      await m.halt.resumeEnvironment(s.workspaceId, s.environmentId, {});
    }
    expect(s.stripe.refunds).toHaveLength(1);
  });

  it("the API returns a grade on every effect", async () => {
    await s.refundAction();
    await s.refundAction("gated-refund", { requiresApproval: true });
    await s.declaredAction("send-email", { verify: false });
    const agent = await s.apiKey("agent");
    const operator = await s.apiKey("operator", ["actions:read", "actions:invoke", "actions:resolve", "impact-limits:read", "impact-limits:write"]);
    const invoke = async (action: string, input: unknown) => (await (await call(agent.key, "POST", `/actions/${action}/invoke`, { input })).json()).data;

    const confirmed = await invoke("refund", s.refund(100, "pi_order1"));
    const acknowledged = await invoke("send-email", s.email("welcome-1", ["a@example.com"]));
    s.stripe.fault("write", "lose_response_after_commit");
    const unknown = await invoke("refund", s.refund(100, "pi_order2"));
    const pending = await invoke("gated-refund", s.refund(100, "pi_order3"));
    const denied = await invoke("gated-refund", s.refund(200, "pi_order3"));
    await m.approvals.denyApproval(s.workspaceId, denied.approvalId, { deciderKeyId: randomUUID() }, s.environmentId);
    const failed = await invoke("refund", s.refund(60_000, "pi_order1"));
    expect((await call(operator.key, "POST", "/impact-limits", { name: "Small refunds", dimension: "money", currency: "usd", period: "day", amount: 50 })).status).toBe(201);
    const refused = await invoke("refund", s.refund(100, "pi_order1"));

    expect([confirmed.grade, acknowledged.grade, unknown.grade, pending.grade, failed.grade, refused.grade])
      .toEqual(["confirmed", "acknowledged", "unknown", "pending", "failed", "refused"]);

    const expected: Record<string, string> = {
      [confirmed.effectId]: "confirmed",
      [acknowledged.effectId]: "acknowledged",
      [unknown.effectId]: "unknown",
      [pending.effectId]: "pending",
      [denied.effectId]: "denied",
      [refused.effectId]: "refused",
      [failed.effectId]: "failed",
    };
    const listed = await (await call(agent.key, "GET", "/actions/effects?limit=100")).json();
    expect(listed.data).toHaveLength(Object.keys(expected).length);
    for (const effect of listed.data) expect(effect.grade, effect.id).toBe(expected[effect.id]);
    for (const [effectId, grade] of Object.entries(expected)) {
      const detail = (await (await call(agent.key, "GET", `/actions/effects/${effectId}`)).json()).data;
      expect(detail.grade, effectId).toBe(grade);
    }
    const onlyRefused = await (await call(agent.key, "GET", "/actions/effects?grade=refused")).json();
    expect(onlyRefused.data.map((e: { id: string }) => e.id)).toEqual([refused.effectId]);
    expect((await call(agent.key, "GET", "/actions/effects?grade=excellent")).status).toBe(400);
    const resolved = await call(operator.key, "POST", `/actions/effects/${unknown.effectId}/resolve`,
      { outcome: "succeeded", reason: "Checked the Stripe dashboard: the refund exists." });
    expect((await resolved.json()).data).toMatchObject({ outcome: "succeeded", grade: "acknowledged", verification: "manual" });
    const invocation = (await (await call(agent.key, "GET", `/actions/invocations/${confirmed.id}`)).json()).data;
    expect(invocation.grade).toBe("confirmed");
  });

  it("the requesting agent cannot resolve its own effect, and operator routes need actions:resolve", async () => {
    await s.refundAction();
    const agent = await s.apiKey("agent", ["actions:read", "actions:invoke", "actions:resolve"]);
    const plain = await s.apiKey("plain");
    s.stripe.fault("write", "timeout_before_commit");
    const invoked = await (await call(agent.key, "POST", "/actions/refund/invoke", { input: s.refund(900) })).json();
    const effectId = invoked.data.effectId as string;
    const resolve = { outcome: "failed", reason: "I am sure it did not happen, trust me." };
    expect((await call(plain.key, "POST", `/actions/effects/${effectId}/resolve`, resolve)).status).toBe(403);
    expect((await call(agent.key, "POST", `/actions/effects/${effectId}/resolve`, resolve)).status).toBe(403);
    expect((await call(plain.key, "GET", `/actions/effects/${effectId}`)).status).toBe(200);
  });

  it("another environment's key cannot see or act on an effect", async () => {
    await s.refundAction();
    const agent = await s.apiKey("agent");
    const invoked = await (await call(agent.key, "POST", "/actions/refund/invoke", { input: s.refund(100) })).json();
    const staging = (await pool.query(
      "INSERT INTO environments (workspace_id, name, slug, kind, is_default) VALUES ($1, 'Staging', 'staging', 'staging', false) RETURNING id",
      [s.workspaceId],
    )).rows[0].id as string;
    const created = await m.keys.createApiKey(s.workspaceId, s.userId, "staging-operator", undefined,
      ["actions:read", "actions:invoke", "actions:resolve"] as never, staging);
    for (const [method, path] of [
      ["GET", `/actions/effects/${invoked.data.effectId}`],
      ["POST", `/actions/effects/${invoked.data.effectId}/reconcile`],
      ["GET", `/actions/previews/${(await s.effect(invoked.data.effectId)).previewId}`],
    ] as const) {
      expect((await call(created.key, method, path)).status, path).toBe(404);
    }
    const listed = await (await call(created.key, "GET", "/actions/effects")).json();
    expect(listed.data).toEqual([]);
  });

  it("agents read impact limits by default; only a key granted impact-limits:write changes them", async () => {
    const agent = await s.apiKey("agent", ["actions:read", "actions:invoke", "impact-limits:read"]);
    const operator = await s.apiKey("operator", ["impact-limits:read", "impact-limits:write"]);
    const limit = { name: "Refunds", dimension: "money", currency: "usd", period: "day", amount: 10_000 };
    expect((await call(agent.key, "POST", "/impact-limits", limit)).status).toBe(403);
    const created = await call(operator.key, "POST", "/impact-limits", limit);
    expect(created.status).toBe(201);
    const listed = await (await call(agent.key, "GET", "/impact-limits")).json();
    expect(listed.data[0]).toMatchObject({ name: "Refunds", limit: 10_000, consumed: 0, reserved: 0, unknownExposure: 0, available: 10_000 });
    expect((await call(agent.key, "PATCH", `/impact-limits/${listed.data[0].id}`, { amount: 1 })).status).toBe(403);
  });

  it("previews and effects round-trip through the public contract", async () => {
    await s.fileAction();
    const agent = await s.apiKey("agent");
    const preview = await call(agent.key, "POST", "/actions/update-file/previews", { input: s.file("a.txt", "new\n"), ttlSeconds: 600 });
    expect(preview.status).toBe(201);
    const p = (await preview.json()).data;
    const invoked = await call(agent.key, "POST", "/actions/update-file/invoke", { input: s.file("a.txt", "new\n"), previewId: p.id });
    const inv = (await invoked.json()).data;
    expect(inv).toMatchObject({ status: "succeeded", effectId: expect.stringMatching(/^eff_/) });
    const effect = (await (await call(agent.key, "GET", `/actions/effects/${inv.effectId}`)).json()).data;
    expect(effect).toMatchObject({ previewId: p.id, bindingDigest: p.bindingDigest, verification: "provider" });
    const mismatch = await call(agent.key, "POST", "/actions/update-file/invoke", { input: s.file("a.txt", "other\n"), previewId: p.id });
    expect(mismatch.status).toBe(409);
  });
});
