import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
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

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("policy governance (real Postgres, real HTTP)", () => {
  let pool: Pool;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let keys: typeof import("../src/core/auth/api-keys.ts");
  let scopes: typeof import("../src/core/auth/api-key-scopes.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");
  let actionSvc: typeof import("../src/core/actions/service.ts");
  let approvalSvc: typeof import("../src/core/approvals/service.ts");

  let userId: string;
  let workspaceId: string;
  let environmentId: string;
  let otherEnvironmentId: string;
  let operatorKey: string;
  let runtimeKey: string;
  let approverKey: string;
  let otherEnvOperatorKey: string;
  let runtimeKeyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = (await import("../src/api/index.ts")).default as typeof app;
    keys = await import("../src/core/auth/api-keys.ts");
    scopes = await import("../src/core/auth/api-key-scopes.ts");
    envSvc = await import("../src/core/environments/service.ts");
    actionSvc = await import("../src/core/actions/service.ts");
    approvalSvc = await import("../src/core/approvals/service.ts");

    userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'T', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('Gov', $1) RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    await pool.query(`UPDATE workspaces SET plan = 'enterprise' WHERE id = $1`, [workspaceId]);
    environmentId = (await envSvc.ensureDefaultEnvironment(workspaceId)).id;
    otherEnvironmentId = (
      await pool.query(
        `INSERT INTO environments (workspace_id, name, slug, kind, is_default)
         VALUES ($1, 'Staging', 'staging', 'staging', false) RETURNING id`,
        [workspaceId],
      )
    ).rows[0].id;

    operatorKey = (
      await keys.createApiKey(workspaceId, userId, "operator", undefined, [
        ...scopes.DEFAULT_API_KEY_SCOPES,
        "actions:write",
        "policies:read",
        "policies:write",
      ], environmentId)
    ).key;
    const runtime = await keys.createApiKey(workspaceId, userId, "runtime", undefined, [
      ...scopes.DEFAULT_API_KEY_SCOPES,
    ], environmentId);
    runtimeKey = runtime.key;
    runtimeKeyId = runtime.apiKey.id;
    approverKey = (
      await keys.createApiKey(workspaceId, userId, "approver", undefined, [
        ...scopes.DEFAULT_API_KEY_SCOPES,
        "approvals:decide",
      ], environmentId)
    ).key;
    otherEnvOperatorKey = (
      await keys.createApiKey(workspaceId, userId, "other-operator", undefined, [
        ...scopes.DEFAULT_API_KEY_SCOPES,
        "actions:write",
        "policies:read",
        "policies:write",
      ], otherEnvironmentId)
    ).key;
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    }
    await pool?.end().catch(() => {});
  });

  afterEach(() => vi.useRealTimers());

  const authed = (key: string, init: RequestInit = {}) => ({
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const call = (key: string, path: string, method = "GET", body?: unknown) =>
    app.request(path, authed(key, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const json = async (res: Response) => (await res.json()) as { success: boolean; data?: any; error?: any };
  const unique = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

  async function makeAction(key: string, name: string, extra: Record<string, unknown> = {}) {
    const res = await call(key, "/api/v2/actions", "POST", {
      name,
      method: "POST",
      urlTemplate: `https://shop.test/${name}`,
      ...extra,
    });
    expect(res.status).toBe(201);
  }

  it("a refund-only deny blocks refund_order and leaves get_order alone, and explains itself from the invocation alone", async () => {
    const refund = unique("refund_order");
    const getOrder = unique("get_order");
    await makeAction(operatorKey, refund);
    await makeAction(operatorKey, getOrder);

    const policyName = unique("refund_order_denied");
    const created = await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: policyName,
      matchKind: "action",
      matchActionName: refund,
      effect: "auto_deny",
    });
    expect(created.status).toBe(201);
    const policy = (await json(created)).data;
    expect(policy).toMatchObject({ scope: "specific_action", needsScopeReview: false, version: 1 });

    destination.mockClear();
    const ok = await call(runtimeKey, `/api/v2/actions/${getOrder}/invoke`, "POST", { input: {} });
    expect([200, 201]).toContain(ok.status);
    expect((await json(ok)).data.status).toBe("succeeded");
    expect(destination).toHaveBeenCalledTimes(1);

    destination.mockClear();
    const denied = await call(runtimeKey, `/api/v2/actions/${refund}/invoke`, "POST", { input: {} });
    const body = (await json(denied)).data;
    expect(body.status).toBe("denied");
    expect(body.pendingApproval).toBe(false);
    expect(body.responseStatus).toBeNull();
    expect(body.body).toBeNull();
    expect(destination).not.toHaveBeenCalled();
    expect(body.decision).toMatchObject({
      source: "policy",
      code: "POLICY_DENIED",
      effect: "denied",
      policy: { id: policy.id, name: policyName, version: 1 },
    });
    expect(body.decision.explanation).toContain(`Denied by policy "${policyName}", version 1`);

    const fetched = (await json(await call(runtimeKey, `/api/v2/actions/invocations/${body.id}`))).data;
    expect(fetched.decision).toEqual(body.decision);
    const listed = (await json(await call(runtimeKey, `/api/v2/actions/invocations?limit=100`))).data;
    const row = (Array.isArray(listed) ? listed : listed.invocations).find((i: any) => i.id === body.id);
    expect(row.decision).toEqual(body.decision);

    const edited = await call(operatorKey, `/api/v2/approval-policies/${policy.id}`, "PATCH", { priority: 7 });
    expect((await json(edited)).data.version).toBe(2);
    expect((await json(await call(runtimeKey, `/api/v2/actions/invocations/${body.id}`))).data.decision).toEqual(body.decision);
    expect((await call(operatorKey, `/api/v2/approval-policies/${policy.id}`, "DELETE")).status).toBe(200);
    expect((await json(await call(runtimeKey, `/api/v2/actions/invocations/${body.id}`))).data.decision).toEqual(body.decision);

    const after = await call(runtimeKey, `/api/v2/actions/${refund}/invoke`, "POST", { input: {} });
    expect((await json(after)).data.status).toBe("succeeded");
  });

  it("denial, its explanation and the released reservation are committed together", async () => {
    const name = unique("atomic");
    await makeAction(operatorKey, name);
    await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("deny"), matchKind: "action", matchActionName: name, effect: "auto_deny",
    });
    const res = await call(runtimeKey, `/api/v2/actions/${name}/invoke`, "POST", { input: {} });
    const inv = (await json(res)).data;
    const row = (await pool.query(
      `SELECT status, decision, completed_at, usage_state, approval_id FROM action_invocations WHERE invocation_id = $1`, [inv.id],
    )).rows[0];
    expect(row.status).toBe("denied");
    expect(row.decision.code).toBe("POLICY_DENIED");
    expect(row.completed_at).not.toBeNull();
    expect(row.usage_state).toBe("released");
    const approval = (await pool.query(`SELECT status, decision_origin FROM approvals WHERE approval_id = $1`, [row.approval_id])).rows[0];
    expect(approval).toMatchObject({ status: "denied", decision_origin: "policy" });
  });

  it("a runtime key cannot read, create, alter, disable or delete policy", async () => {
    const seeded = (await json(await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("guarded"), matchKind: "custom", effect: "require_approval",
    }))).data;

    for (const [method, path, body] of [
      ["GET", "/api/v2/approval-policies", undefined],
      ["GET", `/api/v2/approval-policies/${seeded.id}`, undefined],
      ["POST", "/api/v2/approval-policies", { name: unique("mine"), matchKind: "custom", effect: "auto_approve" }],
      ["PATCH", `/api/v2/approval-policies/${seeded.id}`, { enabled: false }],
      ["DELETE", `/api/v2/approval-policies/${seeded.id}`, undefined],
    ] as const) {
      const res = await call(runtimeKey, path, method, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    const still = (await json(await call(operatorKey, `/api/v2/approval-policies/${seeded.id}`))).data;
    expect(still).toMatchObject({ enabled: true, version: 1 });
  });

  it("policy scopes are privileged: never in the default set", () => {
    for (const scope of ["policies:read", "policies:write"] as const) {
      expect(scopes.DEFAULT_API_KEY_SCOPES).not.toContain(scope);
      expect(scopes.PRIVILEGED_API_KEY_SCOPES).toContain(scope);
    }
  });

  it("a credential cannot reach another environment, whatever the request says", async () => {
    const mine = (await json(await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("scoped"), matchKind: "custom", effect: "require_approval",
    }))).data;

    const withBody = await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("sneaky"), matchKind: "custom", effect: "auto_approve", environmentId: otherEnvironmentId,
    });
    expect(withBody.status).toBe(400);

    expect((await call(operatorKey, `/api/v2/approval-policies?environmentId=${otherEnvironmentId}`)).status).toBe(403);

    expect((await call(otherEnvOperatorKey, `/api/v2/approval-policies/${mine.id}`)).status).toBe(404);
    expect((await call(otherEnvOperatorKey, `/api/v2/approval-policies/${mine.id}`, "PATCH", { enabled: false })).status).toBe(404);
    expect((await call(otherEnvOperatorKey, `/api/v2/approval-policies/${mine.id}`, "DELETE")).status).toBe(404);
    const otherList = (await json(await call(otherEnvOperatorKey, "/api/v2/approval-policies"))).data;
    expect(otherList.map((p: any) => p.id)).not.toContain(mine.id);
  });

  it("targeting an action from another environment fails", async () => {
    const stagingOnly = unique("staging_only");
    await makeAction(otherEnvOperatorKey, stagingOnly);
    const res = await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("cross"), matchKind: "action", matchActionName: stagingOnly, effect: "auto_deny",
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toMatch(/No action named/);
  });

  it("requires explicit targeting and refuses contradictions", async () => {
    const noKind = await call(operatorKey, "/api/v2/approval-policies", "POST", { name: unique("nokind"), effect: "auto_deny" });
    expect(noKind.status).toBe(400);

    const actionName = unique("real_action");
    await makeAction(operatorKey, actionName);
    const contradictory = await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("contra"), matchKind: "custom", matchActionName: actionName, effect: "require_approval",
    });
    expect(contradictory.status).toBe(400);

    const empty = await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("empty"), matchKind: "action", matchActionName: "", effect: "require_approval",
    });
    expect(empty.status).toBe(400);
  });

  it("requires explicit confirmation for a broad auto-deny", async () => {
    const refused = await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("broad"), matchKind: "action", effect: "auto_deny",
    });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error.message).toMatch(/acknowledgeBroadScope/);

    const allowed = await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("broad"), matchKind: "action", effect: "auto_deny", acknowledgeBroadScope: true, enabled: false,
    });
    expect(allowed.status).toBe(201);
    expect((await json(allowed)).data.scope).toBe("all_actions");
  });

  it("PATCH: omitted means unchanged, null clears a nullable matcher, and the result must stay consistent", async () => {
    const actionName = unique("patchme");
    await makeAction(operatorKey, actionName);
    const p = (await json(await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("patch"), matchKind: "action", matchActionName: actionName, matchAgentId: "agent_1",
      minAmount: 50, tags: undefined, effect: "require_approval",
    }))).data;
    expect(p.match).toMatchObject({ actionName, agentId: "agent_1", minAmount: 50 });

    const unchanged = (await json(await call(operatorKey, `/api/v2/approval-policies/${p.id}`, "PATCH", { priority: 3 }))).data;
    expect(unchanged.match).toMatchObject({ actionName, agentId: "agent_1", minAmount: 50 });

    const cleared = (await json(await call(operatorKey, `/api/v2/approval-policies/${p.id}`, "PATCH", { minAmount: null, matchAgentId: null }))).data;
    expect(cleared.match).toMatchObject({ actionName, agentId: null, minAmount: null });

    const bad = await call(operatorKey, `/api/v2/approval-policies/${p.id}`, "PATCH", { matchKind: "custom" });
    expect(bad.status).toBe(400);
    const ok = await call(operatorKey, `/api/v2/approval-policies/${p.id}`, "PATCH", { matchKind: "custom", matchActionName: null });
    expect(ok.status).toBe(200);
    expect((await json(ok)).data.scope).toBe("custom_requests");

    const off = (await json(await call(operatorKey, `/api/v2/approval-policies/${p.id}`, "PATCH", { enabled: false }))).data;
    expect(off.enabled).toBe(false);
  });

  it("orders equal-priority policies deterministically", async () => {
    const name = unique("tie");
    await makeAction(operatorKey, name);
    const first = (await json(await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("tie_a"), matchKind: "action", matchActionName: name, effect: "auto_deny", priority: 5,
    }))).data;
    await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("tie_b"), matchKind: "action", matchActionName: name, effect: "require_approval", priority: 5,
    });
    await pool.query(`UPDATE approval_policies SET created_at = '2030-01-01' WHERE environment_id = $1 AND priority = 5 AND match_action_name = $2`, [environmentId, name]);
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const res = await call(runtimeKey, `/api/v2/actions/${name}/invoke`, "POST", { input: {} });
      seen.add((await json(res)).data.decision?.policy?.id ?? "none");
    }
    expect(seen.size).toBe(1);
    const listed = (await json(await call(operatorKey, `/api/v2/approval-policies?actionName=${name}`))).data;
    expect(listed.map((x: any) => x.id)).toContain(first.id);
  });

  it("flags legacy broad policies for review and never infers scope from the name", async () => {
    const id = `apol_${randomUUID().slice(0, 12)}`;
    await pool.query(
      `INSERT INTO approval_policies (workspace_id, environment_id, policy_id, name, match_kind, effect)
       VALUES ($1, $2, $3, 'refund_order_denied', 'any', 'auto_deny')`,
      [workspaceId, environmentId, id],
    );
    const p = (await json(await call(operatorKey, `/api/v2/approval-policies/${id}`))).data;
    expect(p).toMatchObject({ scope: "all_requests", needsScopeReview: true, scopeReviewedAt: null });
    expect(p.match.actionName).toBeNull();

    const actionName = unique("legacy_fix");
    await makeAction(operatorKey, actionName);
    const fixed = (await json(await call(operatorKey, `/api/v2/approval-policies/${id}`, "PATCH", {
      matchKind: "action", matchActionName: actionName,
    }))).data;
    expect(fixed).toMatchObject({ scope: "specific_action", needsScopeReview: false });
    await call(operatorKey, `/api/v2/approval-policies/${id}`, "DELETE");
  });

  it("100 automatic denials create no pending inbox work, and all remain auditable", async () => {
    const name = unique("bulk_deny");
    await makeAction(operatorKey, name);
    const pol = (await json(await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("bulk"), matchKind: "action", matchActionName: name, effect: "auto_deny",
    }))).data;

    const before = await approvalSvc.listApprovals(workspaceId, { environmentId, status: "pending" });
    const autoBefore = await approvalSvc.listApprovals(workspaceId, { environmentId, decisionOrigin: "policy" });
    for (let i = 0; i < 100; i++) {
      await actionSvc.invokeAction(workspaceId, name, { i }, { environmentId });
    }
    const pending = await approvalSvc.listApprovals(workspaceId, { environmentId, status: "pending" });
    expect(pending.total).toBe(before.total);
    const automated = await approvalSvc.listApprovals(workspaceId, { environmentId, decisionOrigin: "automated", limit: 100 });
    expect(automated.total - autoBefore.total).toBe(100);
    expect(automated.approvals.every((a) => a.decisionOrigin === "policy" || a.decisionOrigin === "system")).toBe(true);
    const human = await approvalSvc.listApprovals(workspaceId, { environmentId, decisionOrigin: "human" });
    expect(human.approvals.every((a) => a.decisionOrigin === "human")).toBe(true);
    await call(operatorKey, `/api/v2/approval-policies/${pol.id}`, "DELETE");
  }, 600_000);

  it("records who decided: a person, a policy or the system", async () => {
    const name = unique("gated");
    await makeAction(operatorKey, name, { requiresApproval: true });

    const parked = (await json(await call(runtimeKey, `/api/v2/actions/${name}/invoke`, "POST", { input: {} }))).data;
    expect(parked.pendingApproval).toBe(true);
    expect(parked.decision).toBeNull();

    const denied = await call(approverKey, `/api/v2/approvals/${parked.approvalId}/deny`, "POST", { note: "no" });
    expect((await json(denied)).data.approval.decisionOrigin).toBe("human");
    const humanDenied = (await json(await call(runtimeKey, `/api/v2/actions/invocations/${parked.id}`))).data;
    expect(humanDenied.status).toBe("denied");
    expect(humanDenied.decision).toMatchObject({ source: "human", code: "HUMAN_DENIED", effect: "denied", policy: null });
    expect(humanDenied.responseStatus).toBeNull();

    const second = (await json(await call(runtimeKey, `/api/v2/actions/${name}/invoke`, "POST", { input: {} }))).data;
    await pool.query(`UPDATE approvals SET expires_at = now() - interval '1 minute' WHERE approval_id = $1`, [second.approvalId]);
    const expired = await approvalSvc.getApproval(workspaceId, second.approvalId, environmentId);
    expect(expired).toMatchObject({ status: "expired", decisionOrigin: "system" });
    const expiredInv = (await json(await call(runtimeKey, `/api/v2/actions/invocations/${second.id}`))).data;
    expect(expiredInv.decision).toMatchObject({ source: "system", code: "APPROVAL_EXPIRED", effect: "expired" });

    const third = (await json(await call(runtimeKey, `/api/v2/actions/${name}/invoke`, "POST", { input: {} }))).data;
    const approved = await call(approverKey, `/api/v2/approvals/${third.approvalId}/approve`, "POST", {});
    expect((await json(approved)).data.approval.decisionOrigin).toBe("human");
    const runInv = (await json(await call(runtimeKey, `/api/v2/actions/invocations/${third.id}`))).data;
    expect(runInv.decision).toMatchObject({ source: "human", code: "HUMAN_APPROVED", effect: "approved" });
    expect(runInv.status).toBe("succeeded");
  });

  describe.each([
    ["application clock an hour BEHIND the database", -3_600_000],
    ["application clock an hour AHEAD of the database", 3_600_000],
    ["application clock a few seconds behind (the measured dev skew)", -1_200],
  ])("lifecycle order holds with the %s", (_label, offsetMs) => {
    it("creation never follows decision or completion", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + offsetMs) });
      const name = unique("skew");
      await actionSvc.createAction(
        workspaceId,
        { name, urlTemplate: "https://shop.test/x", method: "POST" },
        actionSvc.UNSCOPED_AUTHORITY,
        environmentId,
      );
      const pol = await (await import("../src/core/approvals/policy.ts")).createPolicy(workspaceId, {
        environmentId, name: unique("skew_deny"), matchKind: "action", matchActionName: name, effect: "auto_deny",
      });
      const inv = await actionSvc.invokeAction(workspaceId, name, {}, { environmentId });
      const gatedName = unique("skew_gated");
      await actionSvc.createAction(
        workspaceId,
        { name: gatedName, urlTemplate: "https://shop.test/y", method: "POST", requiresApproval: true },
        actionSvc.UNSCOPED_AUTHORITY,
        environmentId,
      );
      const parked = await actionSvc.invokeAction(workspaceId, gatedName, {}, { environmentId, requestedByKeyId: randomUUID() });
      await approvalSvc.approveApproval(workspaceId, parked.approvalId!, { deciderKeyId: randomUUID() }, environmentId);
      vi.useRealTimers();

      const rows = (await pool.query(
        `SELECT i.invocation_id, i.created_at AS inv_created, i.completed_at, a.created_at AS apr_created, a.decided_at
           FROM action_invocations i JOIN approvals a ON a.approval_id = i.approval_id
          WHERE i.invocation_id = ANY($1)`,
        [[inv.id, parked.id]],
      )).rows;
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.apr_created.getTime()).toBeLessThanOrEqual(r.decided_at.getTime());
        expect(r.inv_created.getTime()).toBeLessThanOrEqual(r.apr_created.getTime());
        if (r.completed_at) expect(r.inv_created.getTime()).toBeLessThanOrEqual(r.completed_at.getTime());
      }
      const drift = (await pool.query(
        `SELECT abs(extract(epoch from (decided_at - (now() at time zone 'utc')))) AS s FROM approvals WHERE approval_id = $1`,
        [inv.approvalId],
      )).rows[0].s;
      expect(Number(drift)).toBeLessThan(30);
      await (await import("../src/core/approvals/policy.ts")).deletePolicy(workspaceId, pol.id);
    });
  });

  it("concurrent votes are stamped in lock order, never before the approval existed", async () => {
    const name = unique("quorum");
    await makeAction(operatorKey, name, { requiresApproval: true });
    const pol = (await json(await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("two_of"), matchKind: "action", matchActionName: name, effect: "require_approval", requiredApprovals: 2,
    }))).data;
    const parked = (await json(await call(runtimeKey, `/api/v2/actions/${name}/invoke`, "POST", { input: {} }))).data;

    await Promise.all([
      approvalSvc.approveApproval(workspaceId, parked.approvalId, { deciderKeyId: randomUUID() }, environmentId),
      approvalSvc.approveApproval(workspaceId, parked.approvalId, { deciderKeyId: randomUUID() }, environmentId),
    ]);
    const a = (await pool.query(`SELECT id, created_at, decided_at, status FROM approvals WHERE approval_id = $1`, [parked.approvalId])).rows[0];
    const votes = (await pool.query(`SELECT decided_at FROM approval_decisions WHERE approval_id = $1`, [a.id])).rows;
    expect(a.status).toBe("approved");
    expect(votes).toHaveLength(2);
    for (const v of votes) {
      expect(v.decided_at.getTime()).toBeGreaterThanOrEqual(a.created_at.getTime());
      expect(v.decided_at.getTime()).toBeLessThanOrEqual(a.decided_at.getTime());
    }
    await call(operatorKey, `/api/v2/approval-policies/${pol.id}`, "DELETE");
  });

  it("GET /auth/identity reports the caller's own credential and nothing else", async () => {
    const res = await call(runtimeKey, "/api/v2/auth/identity");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = (await json(res)).data;
    expect(data).toEqual({
      credentialType: "api_key",
      apiKeyId: runtimeKeyId,
      workspaceId,
      environmentId,
      scopes: [...scopes.DEFAULT_API_KEY_SCOPES].sort(),
      expiresAt: null,
      role: null,
    });
    expect(JSON.stringify(data)).not.toContain(runtimeKey);
    expect(data.scopes).not.toContain("policies:write");

    const operator = (await json(await call(operatorKey, "/api/v2/auth/identity"))).data;
    expect(operator.scopes).toEqual(expect.arrayContaining(["policies:read", "policies:write"]));
    expect((await app.request("/api/v2/auth/identity")).status).toBe(401);
  });

  it("identity works for a key whose scopes cover nothing else", async () => {
    const bare = (await keys.createApiKey(workspaceId, userId, "bare", undefined, ["runs:read"], environmentId)).key;
    const res = await call(bare, "/api/v2/auth/identity");
    expect(res.status).toBe(200);
    expect((await json(res)).data.scopes).toEqual(["runs:read"]);
  });

  it("an expired key and a revoked key are refused by the identity endpoint, revealing nothing", async () => {
    const expiring = await keys.createApiKey(
      workspaceId, userId, "soon", new Date(Date.now() + 3_600_000), [...scopes.DEFAULT_API_KEY_SCOPES], environmentId,
    );
    expect((await call(expiring.key, "/api/v2/auth/identity")).status).toBe(200);
    await pool.query(`UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expiring.apiKey.id]);
    const { redis, RedisKeys } = await import("../src/lib/redis.ts");
    const { hashApiKey } = await import("../src/utils/crypto.ts");
    await redis.del(RedisKeys.apiKey(hashApiKey(expiring.key)));
    const expired = await call(expiring.key, "/api/v2/auth/identity");
    expect(expired.status).toBe(401);
    const expiredText = await expired.text();
    expect(expiredText).not.toContain(expiring.key);
    expect(expiredText).not.toMatch(/expired/i);

    const doomed = await keys.createApiKey(workspaceId, userId, "doomed", undefined, [...scopes.DEFAULT_API_KEY_SCOPES], environmentId);
    expect((await call(doomed.key, "/api/v2/auth/identity")).status).toBe(200);
    await keys.deleteApiKey(doomed.apiKey.id, workspaceId);
    const revoked = await call(doomed.key, "/api/v2/auth/identity");
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toMatch(/revoked|deleted/i);
  });

  it("a credential in another WORKSPACE cannot see, change or delete this workspace's policies", async () => {
    const mine = (await json(await call(operatorKey, "/api/v2/approval-policies", "POST", {
      name: unique("ws_scoped"), matchKind: "custom", effect: "require_approval",
    }))).data;

    const otherUser = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'T', $2, false, now(), now())`,
      [otherUser, `${otherUser}@test.dev`],
    );
    const otherWorkspace = (
      await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('Other', $1, 'enterprise') RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id as string;
    try {
      const otherEnv = (await envSvc.ensureDefaultEnvironment(otherWorkspace)).id;
      const foreign = (
        await keys.createApiKey(otherWorkspace, otherUser, "foreign-operator", undefined, [
          ...scopes.DEFAULT_API_KEY_SCOPES, "policies:read", "policies:write",
        ], otherEnv)
      ).key;

      expect((await call(foreign, `/api/v2/approval-policies/${mine.id}`)).status).toBe(404);
      expect((await call(foreign, `/api/v2/approval-policies/${mine.id}`, "PATCH", { enabled: false })).status).toBe(404);
      expect((await call(foreign, `/api/v2/approval-policies/${mine.id}`, "DELETE")).status).toBe(404);
      const seen = (await json(await call(foreign, "/api/v2/approval-policies"))).data.map((p: any) => p.id);
      expect(seen).not.toContain(mine.id);
      const identity = (await json(await call(foreign, "/api/v2/auth/identity"))).data;
      expect(identity.workspaceId).toBe(otherWorkspace);
      expect((await json(await call(operatorKey, `/api/v2/approval-policies/${mine.id}`))).data.enabled).toBe(true);
    } finally {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [otherWorkspace]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [otherUser]);
    }
  });

  it("a runtime key cannot acquire policy privileges by any route it can reach", async () => {
    const res = await call(runtimeKey, "/api/v2/workspaces/" + workspaceId + "/api-keys", "POST", {
      name: "escalate", scopes: ["policies:write"],
    });
    expect([401, 403, 404]).toContain(res.status);
    const identity = (await json(await call(runtimeKey, "/api/v2/auth/identity"))).data;
    expect(identity.scopes).not.toContain("policies:read");
    expect(identity.scopes).not.toContain("policies:write");
  });
});
