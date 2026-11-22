import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const safeFetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: safeFetchMock };
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

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("gated action invoke honors the policy decision (real Postgres)", () => {
  let pool: Pool;
  let actionSvc: typeof import("../src/core/actions/service.ts");
  let policySvc: typeof import("../src/core/approvals/policy.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");
  let runsSvc: typeof import("../src/core/runs/service.ts");

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    actionSvc = await import("../src/core/actions/service.ts");
    policySvc = await import("../src/core/approvals/policy.ts");
    envSvc = await import("../src/core/environments/service.ts");
    runsSvc = await import("../src/core/runs/service.ts");
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  async function seedScope() {
    const ws = await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('WS', $1) RETURNING id`, [
      `ws-${randomUUID().slice(0, 8)}`,
    ]);
    const workspaceId = ws.rows[0].id as string;
    const env = await envSvc.ensureDefaultEnvironment(workspaceId);
    return { workspaceId, environmentId: env.id };
  }

  async function gatedAction(workspaceId: string, name: string) {
    return actionSvc.createAction(workspaceId, {
      name,
      method: "POST",
      urlTemplate: "https://api.example.com/webhook",
      requiresApproval: true,
    }, actionSvc.UNSCOPED_AUTHORITY);
  }

  it("auto-approve policy naming the action: runs the invocation, pendingApproval=false", async () => {
    const scope = await seedScope();
        const action = await gatedAction(scope.workspaceId, "notify");
await policySvc.createPolicy(scope.workspaceId, {
      matchKind: "action",
      environmentId: scope.environmentId,
      name: "auto-approve-notify",
      matchActionName: "notify",
      effect: "auto_approve",
    });

    safeFetchMock.mockClear();
    const result = await actionSvc.invokeAction(scope.workspaceId, action.name, { x: 1 }, {
      environmentId: scope.environmentId,
    });

    expect(result.pendingApproval).toBe(false);
    expect(result.status).not.toBe("pending_approval");
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("catch-all auto-approve does not clear a gated action's approval floor", async () => {
    const scope = await seedScope();
    await policySvc.createPolicy(scope.workspaceId, {
      matchKind: "any",
      environmentId: scope.environmentId,
      name: "auto-approve-all",
      effect: "auto_approve",
    });
    const action = await gatedAction(scope.workspaceId, "notify");

    safeFetchMock.mockClear();
    const result = await actionSvc.invokeAction(scope.workspaceId, action.name, { x: 1 }, {
      environmentId: scope.environmentId,
    });

    expect(result.pendingApproval).toBe(true);
    expect(result.status).toBe("pending_approval");
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("auto-instruments a correlated action span when given a run context", async () => {
    const scope = await seedScope();
        const action = await gatedAction(scope.workspaceId, "traceable-notify");
await policySvc.createPolicy(scope.workspaceId, {
      matchKind: "action",
      environmentId: scope.environmentId, name: "auto-approve-traceable",
      matchActionName: "traceable-notify", effect: "auto_approve",
    });
    const run = await runsSvc.startRun(scope, { name: "agent" });
    const result = await actionSvc.invokeAction(scope.workspaceId, action.name, { x: 1 }, {
      environmentId: scope.environmentId, traceRunId: run.id,
    });
    const trace = await runsSvc.getRunWithTree(scope, run.id);
    expect(result.status).toBe("succeeded");
    const actionSpan = trace.spans.find((span) => span.type === "action_call");
    const approvalWait = trace.spans.find((span) => span.type === "approval_wait");
    expect(actionSpan).toMatchObject({ type: "action_call", name: "traceable-notify", status: "succeeded" });
    expect((actionSpan!.attributes as Record<string, unknown>).invocationId).toBe(result.id);
    expect(approvalWait).toMatchObject({ type: "approval_wait", status: "succeeded" });
    expect(approvalWait!.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "approval_decision", status: "succeeded" }),
    ]));
  });

  it("retains action trace context through a human approval resume", async () => {
    const scope = await seedScope();
    const action = await gatedAction(scope.workspaceId, "approved-notify");
    const run = await runsSvc.startRun(scope, { name: "agent" });
    const pending = await actionSvc.invokeAction(scope.workspaceId, action.name, { x: 1 }, {
      environmentId: scope.environmentId, traceRunId: run.id,
    });
    expect(pending.pendingApproval).toBe(true);
    await (await import("../src/core/approvals/service.ts")).approveApproval(
      scope.workspaceId,
      pending.approvalId!,
      { deciderKeyId: randomUUID() },
    );
    const trace = await runsSvc.getRunWithTree(scope, run.id);
    const actionSpan = trace.spans.find((span) => span.type === "action_call");
    const approvalWait = trace.spans.find((span) => span.type === "approval_wait");
    expect(actionSpan).toMatchObject({ type: "action_call", name: "approved-notify", status: "succeeded" });
    expect((actionSpan!.attributes as Record<string, unknown>).invocationId).toBe(pending.id);
    expect(approvalWait).toMatchObject({ type: "approval_wait", status: "succeeded" });
    expect(approvalWait!.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "approval_decision", status: "succeeded" }),
    ]));
  });

  it("auto-deny policy: denies the invocation, pendingApproval=false, never executes", async () => {
    const scope = await seedScope();
    await policySvc.createPolicy(scope.workspaceId, {
      matchKind: "any",
      acknowledgeBroadScope: true,
      environmentId: scope.environmentId,
      name: "auto-deny-all",
      effect: "auto_deny",
    });
    const action = await gatedAction(scope.workspaceId, "notify");

    safeFetchMock.mockClear();
    const result = await actionSvc.invokeAction(scope.workspaceId, action.name, { x: 1 }, {
      environmentId: scope.environmentId,
    });

    expect(result.pendingApproval).toBe(false);
    expect(result.status).toBe("denied");
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("no auto-decision: parks the invocation, pendingApproval=true", async () => {
    const scope = await seedScope();
    const action = await gatedAction(scope.workspaceId, "notify");

    safeFetchMock.mockClear();
    const result = await actionSvc.invokeAction(scope.workspaceId, action.name, { x: 1 }, {
      environmentId: scope.environmentId,
    });

    expect(result.pendingApproval).toBe(true);
    expect(result.status).toBe("pending_approval");
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});
