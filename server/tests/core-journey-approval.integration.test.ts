import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const destination = vi.fn();
vi.mock("../src/api/governance-gate.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), signOffIfLoosening: async () => null }));
vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return {
    ...actual,
    safeFetch: (...args: unknown[]) => {
      destination(...args);
      return Promise.resolve(new Response(JSON.stringify({ refunded: true }), { status: 200 }));
    },
  };
});

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";

let available = false;

beforeAll(async () => {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    await probe.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.end().catch(() => {});
  }
});

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("core journey: governed action, independent decision, visible outcome", () => {
  let pool: Pool;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let keys: typeof import("../src/core/auth/api-keys.ts");
  let scopes: typeof import("../src/core/auth/api-key-scopes.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");

  let userId: string;
  let workspaceId: string;
  let environmentId: string;
  let agentKey: string;
  let operatorKey: string;
  let approverKey: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = (await import("../src/api/index.ts")).default as typeof app;
    keys = await import("../src/core/auth/api-keys.ts");
    scopes = await import("../src/core/auth/api-key-scopes.ts");
    envSvc = await import("../src/core/environments/service.ts");

    userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'T', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('Core', $1) RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    environmentId = (await envSvc.ensureDefaultEnvironment(workspaceId)).id;

    operatorKey = (
      await keys.createApiKey(workspaceId, userId, "operator", undefined, [
        ...scopes.DEFAULT_API_KEY_SCOPES,
        "actions:write",
      ], environmentId)
    ).key;
    agentKey = (
      await keys.createApiKey(workspaceId, userId, "agent", undefined, [
        ...scopes.DEFAULT_API_KEY_SCOPES,
        "approvals:decide",
      ], environmentId)
    ).key;
    approverKey = (
      await keys.createApiKey(workspaceId, userId, "approver", undefined, [
        ...scopes.DEFAULT_API_KEY_SCOPES,
        "approvals:decide",
      ], environmentId)
    ).key;
  }, 60_000);

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    }
    await pool?.end().catch(() => {});
  });

  const authed = (key: string, init: RequestInit = {}) => ({
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

  it("a new user can define a governed action, have it decided independently, and see what happened", async () => {
    destination.mockClear();
    const actionName = `refund-${randomUUID().slice(0, 8)}`;

    const created = await app.request(
      "/api/v2/actions",
      authed(operatorKey, {
        method: "POST",
        body: JSON.stringify({
          name: actionName,
          method: "POST",
          urlTemplate: "https://payments.test/refunds",
          bodyTemplate: { charge: "{{input.charge}}" },
          requiresApproval: true,
        }),
      }),
    );
    expect(created.status).toBe(201);

    const run = await app.request(
      "/api/v2/runs",
      authed(agentKey, { method: "POST", body: JSON.stringify({ name: "refund-agent" }) }),
    );
    expect(run.status).toBe(201);
    const runId = (await run.json()).data.id as string;

    const invoked = await app.request(
      `/api/v2/actions/${actionName}/invoke`,
      authed(agentKey, { method: "POST", body: JSON.stringify({ input: { charge: "ch_1" }, runId }) }),
    );

    expect(invoked.status).toBe(202);
    const pending = (await invoked.json()).data as { id: string; approvalId: string; pendingApproval: boolean };
    expect(pending.pendingApproval).toBe(true);
    expect(pending.approvalId).toBeTruthy();
    expect(destination).not.toHaveBeenCalled();

    const selfDecision = await app.request(
      `/api/v2/approvals/${pending.approvalId}/approve`,
      authed(agentKey, { method: "POST", body: JSON.stringify({}) }),
    );
    expect(selfDecision.status).toBe(403);
    expect(destination).not.toHaveBeenCalled();

    const decision = await app.request(
      `/api/v2/approvals/${pending.approvalId}/approve`,
      authed(approverKey, { method: "POST", body: JSON.stringify({ note: "verified with the customer" }) }),
    );
    expect(decision.status).toBe(200);
    expect((await decision.json()).data.approval.status).toBe("approved");

    expect(destination).toHaveBeenCalledTimes(1);
    const [url, init] = destination.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("https://payments.test/refunds");
    expect(JSON.parse(init.body)).toEqual({ charge: "ch_1" });

    const invocation = await app.request(`/api/v2/actions/invocations/${pending.id}`, authed(agentKey));
    expect(invocation.status).toBe(200);
    const record = (await invocation.json()).data as { status: string; responseStatus: number };
    expect(record.status).toBe("succeeded");
    expect(record.responseStatus).toBe(200);

    const trace = await app.request(`/api/v2/runs/${runId}`, authed(agentKey));
    const spans = (await trace.json()).data.spans as { type: string; status: string; children?: unknown[] }[];
    const flatten = (nodes: typeof spans): typeof spans =>
      nodes.flatMap((node) => [node, ...flatten((node.children ?? []) as typeof spans)]);
    const all = flatten(spans);
    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "action_call", status: "succeeded" }),
        expect.objectContaining({ type: "approval_wait", status: "succeeded" }),
        expect.objectContaining({ type: "approval_decision", status: "succeeded" }),
      ]),
    );
  });

  it("a denied request never reaches the destination, and says so", async () => {
    destination.mockClear();
    const actionName = `payout-${randomUUID().slice(0, 8)}`;
    await app.request(
      "/api/v2/actions",
      authed(operatorKey, {
        method: "POST",
        body: JSON.stringify({
          name: actionName,
          method: "POST",
          urlTemplate: "https://payments.test/payouts",
          requiresApproval: true,
        }),
      }),
    );

    const invoked = await app.request(
      `/api/v2/actions/${actionName}/invoke`,
      authed(agentKey, { method: "POST", body: JSON.stringify({ input: {} }) }),
    );
    const pending = (await invoked.json()).data as { id: string; approvalId: string };

    const denied = await app.request(
      `/api/v2/approvals/${pending.approvalId}/deny`,
      authed(approverKey, { method: "POST", body: JSON.stringify({ note: "not this one" }) }),
    );
    expect(denied.status).toBe(200);

    expect(destination).not.toHaveBeenCalled();
    const invocation = await app.request(`/api/v2/actions/invocations/${pending.id}`, authed(agentKey));
    expect((await invocation.json()).data.status).toBe("denied");
  });

  it.each([
    ["approve", "approved", "succeeded", 1],
    ["deny", "denied", "denied", 0],
  ] as const)("a gated call waits on ?waitSeconds and %s settles it", async (verb, approvalStatus, invocationStatus, sent) => {
    destination.mockClear();
    const actionName = `wait-${verb}-${randomUUID().slice(0, 8)}`;
    const created = await app.request(
      "/api/v2/actions",
      authed(operatorKey, {
        method: "POST",
        body: JSON.stringify({ name: actionName, method: "POST", urlTemplate: "https://payments.test/wait", requiresApproval: true }),
      }),
    );
    expect(created.status).toBe(201);
    const invoked = await app.request(
      `/api/v2/actions/${actionName}/invoke`,
      authed(agentKey, { method: "POST", body: JSON.stringify({ input: {} }) }),
    );
    expect(invoked.status).toBe(202);
    const pending = (await invoked.json()).data as { id: string; approvalId: string };

    let settled = false;
    const waiting = app
      .request(`/api/v2/approvals/${pending.approvalId}?waitSeconds=20`, authed(agentKey))
      .then((res) => { settled = true; return res; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    expect(destination).not.toHaveBeenCalled();

    const decided = await app.request(
      `/api/v2/approvals/${pending.approvalId}/${verb}`,
      authed(approverKey, { method: "POST", body: JSON.stringify({}) }),
    );
    expect(decided.status).toBe(200);

    const started = Date.now();
    const res = await waiting;
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe(approvalStatus);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(destination).toHaveBeenCalledTimes(sent);
    const invocation = await app.request(`/api/v2/actions/invocations/${pending.id}`, authed(agentKey));
    expect((await invocation.json()).data.status).toBe(invocationStatus);
  });
});
