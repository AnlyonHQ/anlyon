import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client) };
});
vi.mock("../src/lib/redis.ts", () => ({
  redis: { del: vi.fn(async () => 1) },
  RedisKeys: { apiKey: (hash: string) => `apikey:${hash}`, apiKeyPrevious: (id: string) => `apikey:${id}:previous` },
}));
vi.mock("../src/core/auth/oauth-grants.ts", () => ({ revokeGrant: vi.fn(async () => undefined) }));
vi.mock("../src/core/edition/features.ts", () => ({ isFeatureEnabled: () => true }));

const members = await import("../src/core/workspace/members.ts");
const { adminChangeRefusal, LastAdminError } = await import("../src/core/workspace/admin-invariants.ts");

const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  state.client!.query<T>(text, params).then((r) => r.rows);

let seq = 0;
async function workspace(people: Array<[string, string, boolean?]>): Promise<string> {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'W', $2)", [id, `admin-role-${seq}`]);
  for (const [userId, role, emergency] of people) {
    await sql(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $1, $2, true, now(), now()) ON CONFLICT DO NOTHING`,
      [userId, `${userId}@example.com`],
    );
    await sql(
      "INSERT INTO workspace_members (workspace_id, user_id, role, emergency_access) VALUES ($1, $2, $3, $4)",
      [id, userId, role, emergency ?? false],
    );
  }
  return id;
}

const memberOf = async (workspaceId: string, userId: string) =>
  (await sql<{ role: string; emergency_access: boolean }>(
    "SELECT role, emergency_access FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  ))[0];

beforeAll(async () => {
  await import("../src/db/index.ts");
}, 120_000);

describe("adminChangeRefusal", () => {
  const ea = (userId: string) => ({ userId, emergencyAccess: true });
  const plain = (userId: string) => ({ userId, emergencyAccess: false });

  it("refuses to leave a workspace with no admin", () => {
    expect(adminChangeRefusal([plain("a")], { userId: "a", admin: false, emergencyAccess: false })?.code).toBe("LAST_ADMIN");
  });

  it("refuses to leave a workspace with no emergency-access admin once it has one", () => {
    expect(adminChangeRefusal([ea("a"), plain("b")], { userId: "a", admin: true, emergencyAccess: false })?.code)
      .toBe("LAST_EMERGENCY_ACCESS_ADMIN");
  });

  it("does not block a workspace that never had an emergency-access admin", () => {
    expect(adminChangeRefusal([plain("a"), plain("b")], { userId: "a", admin: false, emergencyAccess: false })).toBeNull();
  });

  it("caps emergency access at two", () => {
    expect(adminChangeRefusal([ea("a"), ea("b"), plain("c")], { userId: "c", admin: true, emergencyAccess: true })?.code)
      .toBe("EMERGENCY_ACCESS_LIMIT");
    expect(adminChangeRefusal([ea("a"), plain("b")], { userId: "b", admin: true, emergencyAccess: true })).toBeNull();
  });
});

describe("the last admin", () => {
  it("cannot be demoted, removed or leave", async () => {
    const ws = await workspace([["solo_admin", "admin"], ["solo_member", "member"]]);
    await expect(members.updateMemberRole(ws, "solo_admin", "solo_admin", "member")).rejects.toBeInstanceOf(LastAdminError);
    await expect(members.leaveWorkspace(ws, "solo_admin")).rejects.toBeInstanceOf(LastAdminError);
    expect(await memberOf(ws, "solo_admin")).toEqual({ role: "admin", emergency_access: false });
  });

  it("can step down once another admin exists", async () => {
    const ws = await workspace([["pair_a", "admin"], ["pair_b", "member"]]);
    await members.updateMemberRole(ws, "pair_a", "pair_b", "admin");
    await members.updateMemberRole(ws, "pair_b", "pair_a", "member");
    expect(await memberOf(ws, "pair_a")).toEqual({ role: "member", emergency_access: false });
    await expect(members.removeMember(ws, "pair_b", "pair_b")).rejects.toBeInstanceOf(LastAdminError);
  });

  it("never stops a member leaving, even where nobody is an admin", async () => {
    const ws = await workspace([["orphan_member", "member"]]);
    await members.leaveWorkspace(ws, "orphan_member");
    expect(await memberOf(ws, "orphan_member")).toBeUndefined();
  });

  it("refuses the database-level owner role outright", async () => {
    const ws = await workspace([["db_admin", "admin", true], ["db_member", "member"]]);
    await expect(sql("UPDATE workspace_members SET role = 'owner' WHERE user_id = 'db_member'")).rejects.toThrow(/no_owner_role/);
    await expect(sql("UPDATE workspace_members SET role = 'member' WHERE user_id = 'db_admin'")).rejects.toThrow(/emergency_access_admin/);
  });
});

describe("emergency access", () => {
  it("is refused to an admin who does not hold it", async () => {
    const ws = await workspace([["ea_creator", "admin", true], ["ea_plain", "admin"]]);
    await expect(members.setEmergencyAccess(ws, "ea_plain", "ea_plain", true)).rejects.toThrow(/Only an admin with emergency access/);
    expect((await memberOf(ws, "ea_plain")).emergency_access).toBe(false);
  });

  it("can be granted by any admin only when nobody holds it", async () => {
    const ws = await workspace([["none_a", "admin"], ["none_b", "admin"]]);
    await expect(members.setEmergencyAccess(ws, "none_a", "none_b", false)).rejects.toThrow(/Only an admin with emergency access/);
    await members.setEmergencyAccess(ws, "none_a", "none_a", true);
    expect((await memberOf(ws, "none_a")).emergency_access).toBe(true);
    await expect(members.setEmergencyAccess(ws, "none_b", "none_b", true)).rejects.toThrow(/Only an admin with emergency access/);
  });

  it("is granted by someone who holds it, at most twice, and recorded", async () => {
    const ws = await workspace([["grant_a", "admin", true], ["grant_b", "admin"], ["grant_c", "admin"], ["grant_m", "member"]]);
    await members.setEmergencyAccess(ws, "grant_a", "grant_b", true);
    expect((await memberOf(ws, "grant_b")).emergency_access).toBe(true);
    await expect(members.setEmergencyAccess(ws, "grant_a", "grant_c", true)).rejects.toMatchObject({ code: "EMERGENCY_ACCESS_LIMIT" });
    await expect(members.setEmergencyAccess(ws, "grant_a", "grant_m", true)).rejects.toThrow(/for admins/);
    const [record] = await sql<{ type: string; actor_id: string; resource_id: string }>(
      "SELECT type, actor_id, resource_id FROM audit_events WHERE workspace_id = $1 ORDER BY seq",
      [ws],
    );
    expect(record).toEqual({ type: "member.emergency_access_granted", actor_id: "grant_a", resource_id: "grant_b" });
  });

  it("cannot be given up by the last who holds it", async () => {
    const ws = await workspace([["last_ea", "admin", true], ["last_other", "admin"]]);
    await expect(members.setEmergencyAccess(ws, "last_ea", "last_ea", false)).rejects.toMatchObject({ code: "LAST_EMERGENCY_ACCESS_ADMIN" });
    await expect(members.leaveWorkspace(ws, "last_ea")).rejects.toMatchObject({ code: "LAST_EMERGENCY_ACCESS_ADMIN" });
  });

  it("protects its holder from removal and demotion by an ordinary admin", async () => {
    const ws = await workspace([["prot_ea", "admin", true], ["prot_admin", "admin"]]);
    await expect(members.removeMember(ws, "prot_admin", "prot_ea")).rejects.toThrow(/emergency access/);
    await expect(members.updateMemberRole(ws, "prot_admin", "prot_ea", "member")).rejects.toThrow(/emergency access/);
    expect(await memberOf(ws, "prot_ea")).toEqual({ role: "admin", emergency_access: true });
  });

  it("is handed over by the former transfer-ownership call, making the new holder an admin", async () => {
    const ws = await workspace([["hand_from", "admin", true], ["hand_to", "member"]]);
    await members.handOverEmergencyAccess(ws, "hand_from", "hand_to");
    expect(await memberOf(ws, "hand_to")).toEqual({ role: "admin", emergency_access: true });
    expect(await memberOf(ws, "hand_from")).toEqual({ role: "admin", emergency_access: false });
    const types = (await sql<{ type: string }>("SELECT type FROM audit_events WHERE workspace_id = $1 ORDER BY seq", [ws])).map((r) => r.type);
    expect(types).toEqual(["member.role_changed", "member.emergency_access_granted", "member.emergency_access_removed"]);
  });
});
