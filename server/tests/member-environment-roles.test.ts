import { beforeEach, describe, expect, it, vi } from "vitest";

const results = vi.hoisted(() => ({ queue: [] as unknown[][], leftJoined: 0, audit: [] as Array<Record<string, unknown>> }));
const edition = vi.hoisted(() => ({ enabled: true }));

vi.mock("../src/core/edition/features.ts", () => ({ isFeatureEnabled: () => edition.enabled }));
vi.mock("../src/db/index.ts", () => {
  const chain = (): any => {
    const next = () => Promise.resolve(results.queue.shift() ?? []);
    let pending: unknown;
    const node: any = {
      from: () => node,
      leftJoin: () => { results.leftJoined += 1; return node; },
      where: () => node,
      limit: () => next(),
      values: (v: unknown) => { pending = v; return node; },
      onConflictDoUpdate: () => node,
      onConflictDoNothing: () => {
        results.audit.push(...(pending as Array<Record<string, unknown>>));
        return Promise.resolve([]);
      },
      returning: () => next(),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => next().then(resolve, reject),
    };
    return node;
  };
  const db: any = { select: chain, insert: chain, delete: chain };
  db.transaction = (fn: (tx: unknown) => unknown) => fn(db);
  return { db };
});

const roles = await import("../src/core/workspace/roles.ts");
const { AuthorizationError, NotFoundError, ValidationError } = await import("../src/utils/errors.ts");

beforeEach(() => {
  results.queue = [];
  results.leftJoined = 0;
  results.audit = [];
  edition.enabled = true;
});

describe("resolveMemberRole", () => {
  it("applies a grant in its environment", async () => {
    results.queue.push([{ workspaceRole: "viewer", grantRole: "approver" }]);
    expect(await roles.resolveMemberRole("ws", "u", "env_prod")).toEqual({
      workspaceRole: "viewer", role: "approver", grantedInEnvironmentId: "env_prod", emergencyAccess: false,
    });
  });

  it("falls back to the workspace role without a grant", async () => {
    results.queue.push([{ workspaceRole: "member", grantRole: null }]);
    expect((await roles.resolveMemberRole("ws", "u", "env_prod"))?.role).toBe("member");
  });

  it("never overrides an admin with emergency access", async () => {
    results.queue.push([{ workspaceRole: "admin", emergencyAccess: true, grantRole: "viewer" }]);
    expect(await roles.resolveMemberRole("ws", "u", "env_prod")).toEqual({
      workspaceRole: "admin", role: "admin", grantedInEnvironmentId: null, emergencyAccess: true,
    });
  });

  it("overrides an admin without emergency access", async () => {
    results.queue.push([{ workspaceRole: "admin", emergencyAccess: false, grantRole: "viewer" }]);
    expect((await roles.resolveMemberRole("ws", "u", "env_prod"))?.role).toBe("viewer");
  });

  it("ignores grants when the edition does not have them", async () => {
    edition.enabled = false;
    results.queue.push([{ workspaceRole: "member" }]);
    expect((await roles.resolveMemberRole("ws", "u", "env_prod"))?.role).toBe("member");
    expect(results.leftJoined).toBe(0);
  });

  it("does not look for a grant without an environment", async () => {
    results.queue.push([{ workspaceRole: "admin" }]);
    expect((await roles.resolveMemberRole("ws", "u"))?.role).toBe("admin");
    expect(results.leftJoined).toBe(0);
  });

  it("returns null for someone who is not a member", async () => {
    results.queue.push([]);
    expect(await roles.resolveMemberRole("ws", "u", "env_prod")).toBeNull();
  });
});

describe("approvalDecidersIn", () => {
  it("counts each member's role in the environment, a grant included", async () => {
    results.queue.push([
      { userId: "user_1", workspaceRole: "admin", emergencyAccess: true, grantRole: null },
      { userId: "user_2", workspaceRole: "viewer", grantRole: "approver" },
      { userId: "user_3", workspaceRole: "member", grantRole: "viewer" },
    ]);
    expect(await roles.approvalDecidersIn("ws", "env_prod")).toEqual(["user_1", "user_2"]);
  });

  it("does not count a grant held in another environment", async () => {
    results.queue.push([
      { userId: "user_1", workspaceRole: "admin", emergencyAccess: true, grantRole: null },
      { userId: "user_2", workspaceRole: "viewer", grantRole: null },
    ]);
    expect(await roles.approvalDecidersIn("ws", "env_staging")).toEqual(["user_1"]);
  });

  it("never lets a grant take an emergency-access admin out, and ignores grants without the feature", async () => {
    results.queue.push([{ userId: "user_1", workspaceRole: "admin", emergencyAccess: true, grantRole: "viewer" }]);
    expect(await roles.approvalDecidersIn("ws", "env_prod")).toEqual(["user_1"]);
    edition.enabled = false;
    results.queue.push([{ userId: "user_1", workspaceRole: "admin" }, { userId: "user_2", workspaceRole: "approver" }]);
    expect(await roles.approvalDecidersIn("ws", "env_prod")).toEqual(["user_1", "user_2"]);
    expect(results.leftJoined).toBe(1);
  });
});

describe("setEnvironmentRole", () => {
  it("answers 404 when the edition does not have grants", async () => {
    edition.enabled = false;
    await expect(roles.setEnvironmentRole("ws", "admin_1", "u", "env", "approver")).rejects.toThrow(NotFoundError);
  });

  it("refuses the retired owner role as a grant", async () => {
    await expect(roles.setEnvironmentRole("ws", "admin_1", "u", "env", "owner")).rejects.toThrow(ValidationError);
  });

  it("refuses an actor who cannot manage members", async () => {
    results.queue.push([{ workspaceRole: "member" }]);
    await expect(roles.setEnvironmentRole("ws", "member_1", "u", "env", "approver")).rejects.toThrow(AuthorizationError);
  });

  it("refuses to override an admin with emergency access", async () => {
    results.queue.push([{ workspaceRole: "admin" }], [{ role: "admin", emergencyAccess: true }]);
    await expect(roles.setEnvironmentRole("ws", "admin_1", "admin_2", "env", "viewer")).rejects.toThrow(/cannot be overridden/);
  });

  it("refuses an environment outside the workspace", async () => {
    results.queue.push([{ workspaceRole: "admin" }], [{ role: "member" }], []);
    await expect(roles.setEnvironmentRole("ws", "admin_1", "u", "env_other", "approver")).rejects.toThrow(NotFoundError);
  });

  it("grants a role in one environment, with its audit record in the same transaction", async () => {
    const now = new Date();
    results.queue.push(
      [{ workspaceRole: "admin" }],
      [{ role: "member" }],
      [{ id: "env_prod" }],
      [{ role: "viewer" }],
      [{ environmentId: "env_prod", role: "approver", grantedBy: "admin_1", createdAt: now, updatedAt: now }],
    );
    expect(await roles.setEnvironmentRole("ws", "admin_1", "u", "env_prod", "approver", { ip: "203.0.113.7" })).toEqual({
      environmentId: "env_prod", role: "approver", grantedBy: "admin_1", createdAt: now, updatedAt: now,
    });
    expect(results.audit).toEqual([
      expect.objectContaining({
        type: "member.environment_role_granted",
        category: "access",
        workspaceId: "ws",
        environmentId: "env_prod",
        actorType: "user",
        actorId: "admin_1",
        resourceType: "member",
        resourceId: "u",
        data: expect.objectContaining({ userId: "u", environmentId: "env_prod", role: "approver", previousRole: "viewer" }),
        context: { ip: "203.0.113.7" },
      }),
    ]);
  });
});

describe("removeEnvironmentRole", () => {
  it("answers 404 when there was no grant, and records nothing", async () => {
    results.queue.push([{ workspaceRole: "admin" }], [{ role: "member" }], [{ id: "env_prod" }], []);
    await expect(roles.removeEnvironmentRole("ws", "admin_1", "u", "env_prod")).rejects.toThrow(NotFoundError);
    expect(results.audit).toEqual([]);
  });

  it("records the removal with the role that was removed", async () => {
    results.queue.push([{ workspaceRole: "admin" }], [{ role: "member" }], [{ id: "env_prod" }], [{ id: "grant_1", role: "approver" }]);
    await roles.removeEnvironmentRole("ws", "admin_1", "u", "env_prod");
    expect(results.audit).toEqual([
      expect.objectContaining({
        type: "member.environment_role_removed",
        environmentId: "env_prod",
        actorId: "admin_1",
        resourceId: "u",
        data: expect.objectContaining({ previousRole: "approver" }),
      }),
    ]);
  });
});
