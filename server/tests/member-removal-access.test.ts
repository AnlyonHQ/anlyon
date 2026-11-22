import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));
const redisDel = vi.hoisted(() => vi.fn(async () => 1));
const revokeGrant = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client) };
});
vi.mock("../src/lib/redis.ts", () => ({
  redis: { del: redisDel },
  RedisKeys: { apiKey: (hash: string) => `apikey:${hash}`, apiKeyPrevious: (id: string) => `apikey:${id}:previous` },
}));
vi.mock("../src/core/auth/oauth-grants.ts", () => ({ revokeGrant }));
vi.mock("../src/core/edition/features.ts", () => ({ isFeatureEnabled: () => true }));

const { leaveWorkspace, removeMember } = await import("../src/core/workspace/members.ts");

const ws = "00000000-0000-4000-8000-0000000a7101";
const otherWs = "00000000-0000-4000-8000-0000000a7102";
const owner = "user_owner_rm";
const admin = "user_admin_rm";
const leaver = "user_leaver_rm";
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  state.client!.query<T>(text, params).then((r) => r.rows);

let environmentId = "";
let otherEnvironmentId = "";

async function addKey(workspaceId: string, envId: string, name: string, hash: string, createdBy: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO api_keys (workspace_id, environment_id, name, key_hash, key_prefix, created_by, is_active)
     VALUES ($1, $2, $3, $4, 'anlyon_live_xxx', $5, 'true') RETURNING id`,
    [workspaceId, envId, name, hash, createdBy],
  );
  return row.id;
}

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Acme', 'acme-rm'), ($2, 'Side', 'side-rm')", [ws, otherWs]);
  [{ id: environmentId }] = await sql<{ id: string }>(
    "INSERT INTO environments (workspace_id, name, slug, is_default) VALUES ($1, 'Production', 'production-rm', true) RETURNING id",
    [ws],
  );
  [{ id: otherEnvironmentId }] = await sql<{ id: string }>(
    "INSERT INTO environments (workspace_id, name, slug, is_default) VALUES ($1, 'Production', 'production-rm-side', true) RETURNING id",
    [otherWs],
  );
  for (const [id, email] of [[owner, "owner@acme.com"], [admin, "admin@acme.com"], [leaver, "leaver@acme.com"]]) {
    await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $1, $2, true, now(), now())`, [id, email]);
  }
  await sql(
    "INSERT INTO workspace_members (workspace_id, user_id, role, emergency_access) VALUES ($1, $2, 'admin', true), ($1, $3, 'admin', false), ($1, $4, 'member', false), ($5, $4, 'member', false)",
    [ws, owner, admin, leaver, otherWs],
  );
  await sql(`INSERT INTO oauth_client (id, client_id, redirect_uris) VALUES ('oc-rm', 'client-rm', ARRAY['https://example.com/cb'])`);
  await sql(
    "INSERT INTO oauth_workspace_binding (id, user_id, client_id, workspace_id, environment_id) VALUES ('b-rm', $1, 'client-rm', $2, $3)",
    [leaver, ws, environmentId],
  );
}, 120_000);

describe("removing a member in the console", () => {
  it("revokes the keys they created here, keeps everyone else's and their other workspaces', and records it", async () => {
    const theirs = await addKey(ws, environmentId, "leaver key", "hash-leaver", leaver);
    const adminsKey = await addKey(ws, environmentId, "admin key", "hash-admin", admin);
    const elsewhere = await addKey(otherWs, otherEnvironmentId, "side key", "hash-side", leaver);

    await removeMember(ws, admin, leaver, { ip: "203.0.113.5" });

    expect(await sql("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [ws, leaver])).toEqual([]);
    expect(await sql("SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [otherWs, leaver])).toEqual([{ role: "member" }]);
    const active = async (id: string) => (await sql<{ is_active: string }>("SELECT is_active FROM api_keys WHERE id = $1", [id]))[0].is_active;
    expect(await active(theirs)).toBe("false");
    expect(await active(adminsKey)).toBe("true");
    expect(await active(elsewhere)).toBe("true");
    expect(redisDel).toHaveBeenCalledWith("apikey:hash-leaver", `apikey:${theirs}:previous`);
    expect(redisDel).not.toHaveBeenCalledWith("apikey:hash-admin", expect.anything());
    expect(revokeGrant).toHaveBeenCalledWith(leaver, "client-rm");

    const records = await sql<{ type: string; actor_id: string; resource_id: string; data: Record<string, unknown>; context: Record<string, unknown> }>(
      "SELECT type, actor_id, resource_id, data, context FROM audit_events WHERE workspace_id = $1 ORDER BY seq",
      [ws],
    );
    expect(records).toEqual([
      expect.objectContaining({ type: "member.removed", actor_id: admin, resource_id: leaver, data: expect.objectContaining({ role: "member", apiKeysRevoked: 1 }), context: { ip: "203.0.113.5" } }),
      expect.objectContaining({ type: "api_key.revoked", actor_id: admin, resource_id: theirs, data: expect.objectContaining({ reason: "member_removed", createdBy: leaver }) }),
    ]);
  });

  it("refuses to remove an admin with emergency access, and revokes nothing", async () => {
    const ownersKey = await addKey(ws, environmentId, "owner key", "hash-owner", owner);
    await expect(removeMember(ws, admin, owner)).rejects.toThrow(/emergency access/);
    expect((await sql<{ is_active: string }>("SELECT is_active FROM api_keys WHERE id = $1", [ownersKey]))[0].is_active).toBe("true");
  });
});

describe("leaving, when Redis or a grant revocation fails", () => {
  const active = async (id: string) => (await sql<{ is_active: string }>("SELECT is_active FROM api_keys WHERE id = $1", [id]))[0].is_active;
  const isMember = async (userId: string) =>
    (await sql("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [ws, userId])).length > 0;
  async function addMember(id: string) {
    await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $1, $2, true, now(), now())`, [id, `${id}@acme.com`]);
    await sql("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws, id]);
  }

  it("a cache failure before commit changes nothing, so leaving can simply be tried again", async () => {
    await addMember("user_cache_before");
    const key = await addKey(ws, environmentId, "before key", "hash-before", "user_cache_before");
    redisDel.mockRejectedValueOnce(new Error("Connection is closed."));
    await expect(leaveWorkspace(ws, "user_cache_before")).rejects.toThrow(/Connection is closed/);
    expect(await isMember("user_cache_before")).toBe(true);
    expect(await active(key)).toBe("true");

    redisDel.mockClear();
    await leaveWorkspace(ws, "user_cache_before");
    expect(await isMember("user_cache_before")).toBe(false);
    expect(await active(key)).toBe("false");
    expect(redisDel).toHaveBeenCalledWith("apikey:hash-before", `apikey:${key}:previous`);
  });

  it("a failure after commit is logged, not thrown: the person has left and their keys are revoked", async () => {
    await addMember("user_cache_after");
    const key = await addKey(ws, environmentId, "after key", "hash-after", "user_cache_after");
    await sql(
      "INSERT INTO oauth_workspace_binding (id, user_id, client_id, workspace_id, environment_id) VALUES ('b-after', $1, 'client-rm', $2, $3)",
      ["user_cache_after", ws, environmentId],
    );
    redisDel.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("Connection is closed."));
    revokeGrant.mockRejectedValueOnce(new Error("Connection terminated"));
    await leaveWorkspace(ws, "user_cache_after");
    expect(await isMember("user_cache_after")).toBe(false);
    expect(await active(key)).toBe("false");
    const [revoked] = await sql<{ data: Record<string, unknown> }>(
      "SELECT data FROM audit_events WHERE type = 'api_key.revoked' AND resource_id = $1",
      [key],
    );
    expect(revoked.data).toMatchObject({ reason: "member_left" });
  });
});
