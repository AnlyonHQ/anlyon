import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

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

async function seedScope(pool: Pool, envSvc: typeof import("../src/core/environments/service.ts")) {
  const ws = await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('WS', $1) RETURNING id`, [
    `ws-${randomUUID().slice(0, 8)}`,
  ]);
  const workspaceId = ws.rows[0].id;
  const env = await envSvc.ensureDefaultEnvironment(workspaceId);
  return { workspaceId, environmentId: env.id };
}

async function seedMember(pool: Pool, workspaceId: string, role = "member") {
  const id = `user_${randomUUID()}`;
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'U', $2, false, now(), now())`,
    [id, `${id}@test.dev`],
  );
  await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [workspaceId, id, role]);
  return id;
}

const KEY_A = randomUUID();
const KEY_B = randomUUID();
const KEY_C = randomUUID();

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("approval policy engine (real Postgres)", () => {
  let pool: Pool;
  let svc: typeof import("../src/core/approvals/service.ts");
  let policySvc: typeof import("../src/core/approvals/policy.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    svc = await import("../src/core/approvals/service.ts");
    policySvc = await import("../src/core/approvals/policy.ts");
    envSvc = await import("../src/core/environments/service.ts");
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  it("blocks a key from deciding its own request by default", async () => {
    const scope = await seedScope(pool, envSvc);
    const approval = await svc.createApproval(
      scope.workspaceId,
      { title: "self" },
      { requestedByKeyId: KEY_A, environmentId: scope.environmentId },
    );
    await expect(
      svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: KEY_A }),
    ).rejects.toThrow(/cannot decide an approval it requested/i);
  });

  it("blocks an OAuth client and its user from deciding the client's request, from any surface", async () => {
    const scope = await seedScope(pool, envSvc);
    const agent = { userId: await seedMember(pool, scope.workspaceId), clientId: `client_${randomUUID()}` };
    const colleague = await seedMember(pool, scope.workspaceId);
    const create = (title: string) =>
      svc.createApproval(scope.workspaceId, { title }, { requestedByOAuth: agent, environmentId: scope.environmentId });

    const own = await create("oauth-self");
    await expect(
      svc.approveApproval(scope.workspaceId, own.id, { deciderUserId: agent.userId, deciderOAuthClientId: agent.clientId }),
    ).rejects.toThrow(/app cannot decide an approval it requested/i);
    await expect(
      svc.denyApproval(scope.workspaceId, own.id, { deciderUserId: agent.userId, deciderOAuthClientId: agent.clientId }),
    ).rejects.toThrow(/app cannot decide an approval it requested/i);

    const viaDashboard = await create("oauth-dashboard");
    await expect(
      svc.approveApproval(scope.workspaceId, viaDashboard.id, { deciderUserId: agent.userId }),
    ).rejects.toThrow(/an app acting for you requested it.*another member who can decide/i);
    await expect(
      svc.approveApproval(scope.workspaceId, viaDashboard.id, { deciderUserId: agent.userId, deciderOAuthClientId: `client_${randomUUID()}` }),
    ).rejects.toThrow(/an app acting for you requested it/i);

    await expect(
      svc.approveApproval(scope.workspaceId, viaDashboard.id, { deciderUserId: colleague }),
    ).resolves.toMatchObject({ approval: { status: "approved" } });
    const viaOtherUser = await create("oauth-other-user");
    await expect(
      svc.approveApproval(scope.workspaceId, viaOtherUser.id, { deciderUserId: colleague, deciderOAuthClientId: agent.clientId }),
    ).resolves.toMatchObject({ approval: { status: "approved" } });

    const [row] = (await pool.query(
      `SELECT requested_by_user_id, requested_by_oauth_client_id, requested_by_key_id FROM approvals WHERE approval_id = $1`,
      [own.id],
    )).rows;
    expect(row).toMatchObject({ requested_by_user_id: agent.userId, requested_by_oauth_client_id: agent.clientId, requested_by_key_id: null });
  });

  it("no policy can permit a key to decide its own request", async () => {
    const scope = await seedScope(pool, envSvc);
    await policySvc.createPolicy(scope.workspaceId, {
      matchKind: "any",
      environmentId: scope.environmentId,
      name: "trusted-self",
      priority: 1,
      effect: "require_approval",
    });
    const approval = await svc.createApproval(
      scope.workspaceId,
      { title: "self-ok" },
      { requestedByKeyId: KEY_A, environmentId: scope.environmentId },
    );
    await expect(
      svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: KEY_A }),
    ).rejects.toThrow(/cannot decide an approval it requested/i);

    const decided = await svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: KEY_B });
    expect(decided.approval.status).toBe("approved");
  });

  it("auto-approves and auto-denies by policy effect", async () => {
    const scope = await seedScope(pool, envSvc);
    await policySvc.createPolicy(scope.workspaceId, {
      matchKind: "any",
      environmentId: scope.environmentId,
      name: "auto-approve-low",
      priority: 10,
      effect: "auto_approve",
      conditions: { risk: "low" },
    });
    await policySvc.createPolicy(scope.workspaceId, {
      matchKind: "any",
      acknowledgeBroadScope: true,
      environmentId: scope.environmentId,
      name: "auto-deny-high",
      priority: 20,
      effect: "auto_deny",
      conditions: { risk: "high" },
    });

    const approved = await svc.createApproval(
      scope.workspaceId,
      { title: "low", payload: { risk: "low" } },
      { requestedByKeyId: KEY_A, environmentId: scope.environmentId },
    );
    expect(approved.status).toBe("approved");
    expect(approved.matchedPolicyId).toBeTruthy();

    const denied = await svc.createApproval(
      scope.workspaceId,
      { title: "high", payload: { risk: "high" } },
      { requestedByKeyId: KEY_A, environmentId: scope.environmentId },
    );
    expect(denied.status).toBe("denied");
  });

  it("evaluates by ascending priority, first match wins (deterministic)", async () => {
    const scope = await seedScope(pool, envSvc);
    await policySvc.createPolicy(scope.workspaceId, {
      matchKind: "any",
      environmentId: scope.environmentId,
      name: "catch-all",
      priority: 1000,
      effect: "auto_approve",
    });
    await policySvc.createPolicy(scope.workspaceId, {
      matchKind: "any",
      environmentId: scope.environmentId,
      name: "sensitive-first",
      priority: 1,
      effect: "require_approval",
      conditions: { sensitive: true },
    });

    const sensitive = await svc.createApproval(
      scope.workspaceId,
      { title: "s", payload: { sensitive: true } },
      { environmentId: scope.environmentId },
    );
    expect(sensitive.status).toBe("pending");
    expect(sensitive.policyExplanation).toContain("sensitive-first");
  });

  it("requires N distinct approvers (N-of-M) and finalizes only on the Nth", async () => {
    const scope = await seedScope(pool, envSvc);
    await policySvc.createPolicy(scope.workspaceId, {
      matchKind: "any",
      environmentId: scope.environmentId,
      name: "two-approvers",
      requiredApprovals: 2,
    });
    const approval = await svc.createApproval(
      scope.workspaceId,
      { title: "big" },
      { requestedByKeyId: KEY_A, environmentId: scope.environmentId },
    );

    const first = await svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: KEY_B });
    expect(first.approval.status).toBe("pending");

    const second = await svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: KEY_C });
    expect(second.approval.status).toBe("approved");
  });

  it("lets any single deny block an N-of-M approval", async () => {
    const scope = await seedScope(pool, envSvc);
    await policySvc.createPolicy(scope.workspaceId, {
      matchKind: "any",
      environmentId: scope.environmentId,
      name: "two-approvers-b",
      requiredApprovals: 2,
    });
    const approval = await svc.createApproval(
      scope.workspaceId,
      { title: "big" },
      { environmentId: scope.environmentId },
    );
    await svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: KEY_B });
    const denied = await svc.denyApproval(scope.workspaceId, approval.id, { deciderKeyId: KEY_C });
    expect(denied.approval.status).toBe("denied");
  });

  it("rejects a second vote from the same decider", async () => {
    const scope = await seedScope(pool, envSvc);
    await policySvc.createPolicy(scope.workspaceId, {
      matchKind: "any",
      environmentId: scope.environmentId,
      name: "three-approvers",
      requiredApprovals: 3,
    });
    const approval = await svc.createApproval(
      scope.workspaceId,
      { title: "big" },
      { environmentId: scope.environmentId },
    );
    await svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: KEY_B });
    await expect(
      svc.approveApproval(scope.workspaceId, approval.id, { deciderKeyId: KEY_B }),
    ).rejects.toThrow(/already decided/i);
  });

  it("scopes policies to their environment and bumps version on update", async () => {
    const a = await seedScope(pool, envSvc);
    const otherRow = await pool.query(
      `INSERT INTO environments (workspace_id, name, slug, kind, is_default) VALUES ($1, 'Staging', 'staging', 'staging', false) RETURNING id`,
      [a.workspaceId],
    );
    const other = { id: otherRow.rows[0].id as string };
    const policy = await policySvc.createPolicy(a.workspaceId, {
      matchKind: "any",
      environmentId: a.environmentId,
      name: "env-scoped",
      effect: "auto_approve",
    });
    expect(policy.version).toBe(1);

    const inOther = await svc.createApproval(
      a.workspaceId,
      { title: "other" },
      { environmentId: other.id },
    );
    expect(inOther.status).toBe("pending");

    const updated = await policySvc.updatePolicy(a.workspaceId, policy.id, { priority: 5 });
    expect(updated.version).toBe(2);
  });
});
