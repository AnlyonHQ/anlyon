import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("roles and environment grants (real Postgres)", () => {
  let pool: Pool;
  let approvalsSvc: typeof import("../src/core/approvals/service.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");
  let roles: typeof import("../src/core/workspace/roles.ts");
  let errors: typeof import("../src/utils/errors.ts");

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    approvalsSvc = await import("../src/core/approvals/service.ts");
    envSvc = await import("../src/core/environments/service.ts");
    roles = await import("../src/core/workspace/roles.ts");
    errors = await import("../src/utils/errors.ts");
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  async function user(role: string, workspaceId: string, emergencyAccess = false) {
    const id = `usr_${randomUUID().slice(0, 12)}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $1, $2, true, now(), now())`,
      [id, `${id}@example.com`],
    );
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, emergency_access) VALUES ($1, $2, $3, $4)`,
      [workspaceId, id, role, emergencyAccess],
    );
    return id;
  }

  async function scope() {
    const ws = await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('R', $1) RETURNING id`, [`ws-${randomUUID().slice(0, 8)}`]);
    const workspaceId = ws.rows[0].id as string;
    const production = await envSvc.ensureDefaultEnvironment(workspaceId);
    const staging = await envSvc.createEnvironment(workspaceId, { name: "Staging", slug: `staging-${randomUUID().slice(0, 6)}`, kind: "staging" });
    const owner = await user("admin", workspaceId, true);
    return { workspaceId, production: production.id, staging: staging.id, owner };
  }

  const approvalIn = (workspaceId: string, environmentId: string) =>
    approvalsSvc.createApproval(workspaceId, { title: "refund" }, { requestedByKeyId: randomUUID(), environmentId });

  it("an approver in production only decides production approvals", async () => {
    const s = await scope();
    const viewer = await user("viewer", s.workspaceId);
    await roles.setEnvironmentRole(s.workspaceId, s.owner, viewer, s.production, "approver");

    const prod = await approvalIn(s.workspaceId, s.production);
    const staging = await approvalIn(s.workspaceId, s.staging);

    await expect(approvalsSvc.denyApproval(s.workspaceId, staging.id, { deciderUserId: viewer }, s.staging))
      .rejects.toThrow(errors.AuthorizationError);
    const decided = await approvalsSvc.denyApproval(s.workspaceId, prod.id, { deciderUserId: viewer }, s.production);
    expect(decided.approval.status).toBe("denied");
  });

  it("a member made read-only in production cannot decide there", async () => {
    const s = await scope();
    const member = await user("member", s.workspaceId);
    await roles.setEnvironmentRole(s.workspaceId, s.owner, member, s.production, "viewer");
    const prod = await approvalIn(s.workspaceId, s.production);
    await expect(approvalsSvc.denyApproval(s.workspaceId, prod.id, { deciderUserId: member }, s.production))
      .rejects.toThrow(errors.AuthorizationError);
    const staging = await approvalIn(s.workspaceId, s.staging);
    expect((await approvalsSvc.denyApproval(s.workspaceId, staging.id, { deciderUserId: member }, s.staging)).approval.status).toBe("denied");
  });

  it("removing a member removes their grants", async () => {
    const s = await scope();
    const member = await user("member", s.workspaceId);
    await roles.setEnvironmentRole(s.workspaceId, s.owner, member, s.production, "approver");
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [s.workspaceId, member]);
    const left = await pool.query(`SELECT 1 FROM member_environment_roles WHERE workspace_id = $1 AND user_id = $2`, [s.workspaceId, member]);
    expect(left.rowCount).toBe(0);
  });

  it("an admin with emergency access cannot be overridden", async () => {
    const s = await scope();
    await expect(roles.setEnvironmentRole(s.workspaceId, s.owner, s.owner, s.production, "viewer")).rejects.toThrow(/cannot be overridden/);
  });

  it("the creator of the requesting key decides it only as the environment's only approver, marked self-approved", async () => {
    const s = await scope();
    const keys = await import("../src/core/auth/api-keys.ts");
    await keys.createApiKey(s.workspaceId, s.owner, "agent", undefined, ["approvals:write"], s.production);
    const keyId = (await pool.query(`SELECT id FROM api_keys WHERE workspace_id = $1 AND name = 'agent'`, [s.workspaceId])).rows[0].id;
    const fromKey = (environmentId: string) =>
      approvalsSvc.createApproval(s.workspaceId, { title: "refund" }, { requestedByKeyId: keyId, environmentId });
    const selfApprovedVote = async (approvalId: string) =>
      (await pool.query(
        `SELECT d.self_approved FROM approval_decisions d JOIN approvals a ON a.id = d.approval_id WHERE a.approval_id = $1`,
        [approvalId],
      )).rows[0]?.self_approved;

    const solo = await fromKey(s.production);
    const soloDecision = await approvalsSvc.approveApproval(s.workspaceId, solo.id, { deciderUserId: s.owner }, s.production);
    expect(soloDecision).toMatchObject({ selfApproved: true, approval: { status: "approved" } });
    expect(await selfApprovedVote(solo.id)).toBe(true);

    const approver = await user("viewer", s.workspaceId);
    await roles.setEnvironmentRole(s.workspaceId, s.owner, approver, s.production, "approver");
    const prod = await fromKey(s.production);
    await expect(approvalsSvc.approveApproval(s.workspaceId, prod.id, { deciderUserId: s.owner }, s.production))
      .rejects.toThrow(errors.SelfApprovalError);
    const staging = await fromKey(s.staging);
    await expect(approvalsSvc.approveApproval(s.workspaceId, staging.id, { deciderUserId: s.owner }, s.staging))
      .resolves.toMatchObject({ selfApproved: true });

    const decided = await approvalsSvc.approveApproval(s.workspaceId, prod.id, { deciderUserId: approver }, s.production);
    expect(decided).toMatchObject({ selfApproved: false, approval: { status: "approved" } });
    expect(await selfApprovedVote(prod.id)).toBe(false);
  });

  it("describes the caller's role in each environment", async () => {
    const s = await scope();
    const viewer = await user("viewer", s.workspaceId);
    await roles.setEnvironmentRole(s.workspaceId, s.owner, viewer, s.production, "approver");
    const described = await roles.describeCallerPermissions(s.workspaceId, viewer);
    expect(described.role).toBe("viewer");
    const prod = described.environments.find((e) => e.environmentId === s.production);
    const staging = described.environments.find((e) => e.environmentId === s.staging);
    expect(prod).toMatchObject({ role: "approver", granted: true });
    expect(prod?.permissions).toContain("approvals.decide");
    expect(staging).toMatchObject({ role: "viewer", granted: false });
    expect(staging?.permissions).not.toContain("approvals.decide");
  });
});
