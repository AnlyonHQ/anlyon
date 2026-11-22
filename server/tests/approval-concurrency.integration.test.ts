import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

vi.mock("../src/lib/safe-http.ts", () => {
  class SsrfBlockedError extends Error {}
  return {
    SsrfBlockedError,
    safeFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
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

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("concurrent approval decisions (real Postgres)", () => {
  let pool: Pool;
  let svc: typeof import("../src/core/approvals/service.ts");
  let policySvc: typeof import("../src/core/approvals/policy.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");
  let redisLib: typeof import("../src/lib/redis.ts");
  let actionsSvc: typeof import("../src/core/actions/service.ts");
  let safeHttp: { safeFetch: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    svc = await import("../src/core/approvals/service.ts");
    policySvc = await import("../src/core/approvals/policy.ts");
    envSvc = await import("../src/core/environments/service.ts");
    redisLib = await import("../src/lib/redis.ts");
    actionsSvc = await import("../src/core/actions/service.ts");
    safeHttp = (await import("../src/lib/safe-http.ts")) as unknown as {
      safeFetch: ReturnType<typeof vi.fn>;
    };
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  async function quorumScope(requiredApprovals: number) {
    const ws = await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('Q', $1) RETURNING id`, [
      `ws-${randomUUID().slice(0, 8)}`,
    ]);
    const workspaceId = ws.rows[0].id as string;
    const environment = await envSvc.ensureDefaultEnvironment(workspaceId);
    await policySvc.createPolicy(workspaceId, {
      matchKind: "any",
      environmentId: environment.id,
      name: `quorum-${randomUUID().slice(0, 8)}`,
      requiredApprovals,
    });
    return { workspaceId, environmentId: environment.id };
  }

  const newApproval = async (scope: { workspaceId: string; environmentId: string }, title = "big") =>
    svc.createApproval(
      scope.workspaceId,
      { title },
      { requestedByKeyId: randomUUID(), environmentId: scope.environmentId },
    );

  async function persisted(approvalId: string) {
    const row = await pool.query(
      `SELECT id, status, approved_count, required_approvals FROM approvals WHERE approval_id = $1`,
      [approvalId],
    );
    const votes = await pool.query(
      `SELECT decision FROM approval_decisions WHERE approval_id = $1`,
      [row.rows[0].id],
    );
    return {
      status: row.rows[0].status as string,
      approvedCount: row.rows[0].approved_count as number,
      requiredApprovals: row.rows[0].required_approvals as number,
      approveVotes: votes.rows.filter((v) => v.decision === "approve").length,
      denyVotes: votes.rows.filter((v) => v.decision === "deny").length,
    };
  }

  it("finalizes a 2-of-M quorum when both votes arrive together", async () => {
    const scope = await quorumScope(2);
    const approvals = await Promise.all(
      Array.from({ length: 10 }, (_, i) => newApproval(scope, `race-${i}`)),
    );

    for (const approval of approvals) {
      const [a, b] = await Promise.allSettled([
        svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: randomUUID() }),
        svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: randomUUID() }),
      ]);
      expect([a.status, b.status]).toEqual(["fulfilled", "fulfilled"]);

      const state = await persisted(approval.id);
      expect(state.approveVotes).toBe(2);
      expect(state.status).toBe("approved");
      expect(state.approvedCount).toBe(2);
    }
  });

  it("finalizes exactly once, so the pending counter is decremented once", async () => {
    const scope = await quorumScope(2);
    const approval = await newApproval(scope, "counter");
    const pendingKey = redisLib.RedisKeys.approvalsPendingCount(scope.workspaceId);
    await redisLib.redis.set(pendingKey, "1");

    const results = await Promise.allSettled([
      svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: randomUUID() }),
      svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: randomUUID() }),
    ]);

    const finalized = results.filter(
      (r) => r.status === "fulfilled" && r.value.approval.status === "approved",
    );
    expect(finalized).toHaveLength(1);
    expect(await redisLib.redis.get(pendingKey)).toBe("0");
  });

  it("lets a deny win a race with an approve, and never both", async () => {
    const scope = await quorumScope(2);

    for (let i = 0; i < 10; i++) {
      const approval = await newApproval(scope, `deny-race-${i}`);
      await Promise.allSettled([
        svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: randomUUID() }),
        svc.denyApproval(scope.workspaceId, approval.id, { deciderKeyId: randomUUID() }),
      ]);

      const state = await persisted(approval.id);
      expect(state.status).toBe("denied");
      expect(state.denyVotes).toBe(1);
    }
  });

  it("does not let three concurrent votes overshoot a quorum of two", async () => {
    const scope = await quorumScope(2);
    const approval = await newApproval(scope, "overshoot");

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: randomUUID() }),
      ),
    );

    const state = await persisted(approval.id);
    expect(state.status).toBe("approved");
    expect(state.approveVotes).toBe(2);
    expect(state.approvedCount).toBe(2);
    expect(
      results.filter((r) => r.status === "fulfilled" && r.value.approval.status === "approved"),
    ).toHaveLength(1);

    const late = results.filter((r) => r.status === "rejected");
    expect(late).toHaveLength(1);
    expect(String((late[0] as PromiseRejectedResult).reason)).toMatch(/already approved/i);
  });

  it("refuses a vote on an approval that expired, even under concurrency", async () => {
    const scope = await quorumScope(2);
    const approval = await svc.createApproval(
      scope.workspaceId,
      { title: "expiring", expiresInSeconds: 1 },
      { requestedByKeyId: randomUUID(), environmentId: scope.environmentId },
    );
    await pool.query(`UPDATE approvals SET expires_at = now() - interval '1 minute' WHERE approval_id = $1`, [
      approval.id,
    ]);

    const results = await Promise.allSettled([
      svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: randomUUID() }),
      svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: randomUUID() }),
    ]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    const state = await persisted(approval.id);
    expect(state.status).toBe("expired");
    expect(state.approveVotes).toBe(0);
  });

  it("resumes an approved invocation whose dispatch never happened, exactly once", async () => {
    const ws = await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('R', $1) RETURNING id`, [
      `ws-${randomUUID().slice(0, 8)}`,
    ]);
    const workspaceId = ws.rows[0].id as string;
    const environment = await envSvc.ensureDefaultEnvironment(workspaceId);

    const action = await actionsSvc.createAction(
      workspaceId,
      {
        name: `gated-${randomUUID().slice(0, 8)}`,
        urlTemplate: "https://example.com/gated",
        method: "POST",
        requiresApproval: true,
      },
      actionsSvc.UNSCOPED_AUTHORITY,
      environment.id,
    );
    const gated = await actionsSvc.invokeAction(
      workspaceId,
      action.id,
      {},
      { environmentId: environment.id, requestedByKeyId: randomUUID() },
    );
    expect(gated.pendingApproval).toBe(true);
    expect(gated.approvalId).not.toBeNull();

    await pool.query(
      `UPDATE approvals SET status = 'approved', decided_at = now() - interval '5 minutes'
       WHERE approval_id = $1`,
      [gated.approvalId],
    );
    safeHttp.safeFetch.mockClear();

    const [first, second] = await Promise.all([
      svc.resumeApprovedInvocations(50, 60_000, { workspaceId }),
      svc.resumeApprovedInvocations(50, 60_000, { workspaceId }),
    ]);

    expect(first + second).toBe(1);
    expect(safeHttp.safeFetch).toHaveBeenCalledTimes(1);

    const invocation = await pool.query(
      `SELECT status FROM action_invocations WHERE invocation_id = $1`,
      [gated.id],
    );
    expect(invocation.rows[0].status).toBe("succeeded");

    expect(await svc.resumeApprovedInvocations(50, 60_000, { workspaceId })).toBe(0);
    expect(safeHttp.safeFetch).toHaveBeenCalledTimes(1);
  });

  it("records a timed-out dispatch as unknown rather than failed", async () => {
    const ws = await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('U', $1) RETURNING id`, [
      `ws-${randomUUID().slice(0, 8)}`,
    ]);
    const workspaceId = ws.rows[0].id as string;
    const environment = await envSvc.ensureDefaultEnvironment(workspaceId);

    const action = await actionsSvc.createAction(
      workspaceId,
      {
        name: `timeout-${randomUUID().slice(0, 8)}`,
        urlTemplate: "https://example.com/slow",
        method: "POST",
      },
      actionsSvc.UNSCOPED_AUTHORITY,
      environment.id,
    );

    safeHttp.safeFetch.mockRejectedValueOnce(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );
    const invocation = await actionsSvc.invokeAction(
      workspaceId, action.id, {}, { environmentId: environment.id },
    );

    expect(invocation.status).toBe("unknown");
    expect(invocation.error).toMatch(/may have received this request/i);

    const row = await pool.query(
      `SELECT status FROM action_invocations WHERE invocation_id = $1`,
      [invocation.id],
    );
    expect(row.rows[0].status).toBe("unknown");

    safeHttp.safeFetch.mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
      }),
    );
    const refused = await actionsSvc.invokeAction(
      workspaceId, action.id, {}, { environmentId: environment.id },
    );
    expect(refused.status).toBe("failed");
  });
});
