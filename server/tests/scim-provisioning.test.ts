import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));
const redisDel = vi.hoisted(() => vi.fn(async () => 1));
const audit = vi.hoisted(() => vi.fn());
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
vi.mock("../src/core/workspace/membership-audit.ts", () => ({ logMembershipEvent: audit }));
vi.mock("../src/core/auth/oauth-grants.ts", () => ({ revokeGrant }));
vi.mock("../src/core/scim/users.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/core/scim/users.ts")>();
  return {
    ...original,
    createPerson: vi.fn(async ({ email, name }: { email: string; name: string }) => {
      const id = `usr_${Math.random().toString(36).slice(2, 12)}`;
      await state.client!.query(
        `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $2, $3, false, now(), now())`,
        [id, name, email],
      );
      return { id, name, email };
    }),
  };
});

const { default: scimRouter } = await import("../src/api/routes/scim.ts");
const { issueScimToken, replaceRoleMappings } = await import("../src/core/scim/settings.ts");
const { streamStillAuthorized } = await import("../src/core/workspace/access-revocation.ts");

const ws = "00000000-0000-4000-8000-0000000a5001";
const otherWs = "00000000-0000-4000-8000-0000000a5009";
const owner = "user_owner_a5";
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  state.client!.query<T>(text, params).then((r) => r.rows);

let token = "";
let environmentId = "";

async function call(method: string, path: string, body?: unknown, bearer: string | null = token) {
  const headers: Record<string, string> = { "Content-Type": "application/scim+json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await scimRouter.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type"), challenge: res.headers.get("www-authenticate"), body: text ? JSON.parse(text) : null };
}

const role = async (userId: string) =>
  (await sql<{ role: string }>("SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [ws, userId]))[0]?.role ?? null;

const oktaUser = (email: string, externalId: string, active = true) => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
  userName: email,
  name: { givenName: "Jane", familyName: "Doe" },
  emails: [{ primary: true, value: email, type: "work" }],
  displayName: "Jane Doe",
  externalId,
  active,
});
const patchOp = (...Operations: unknown[]) => ({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations });
const events = () => audit.mock.calls.map(([event]) => event);

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Acme', 'acme-a5'), ($2, 'Side', 'side-a5')", [ws, otherWs]);
  [{ id: environmentId }] = await sql<{ id: string }>(
    "INSERT INTO environments (workspace_id, name, slug, is_default) VALUES ($1, 'Production', 'production-a5', true) RETURNING id",
    [ws],
  );
  await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Owner', 'owner@acme.com', true, now(), now())`, [owner]);
  await sql("INSERT INTO workspace_members (workspace_id, user_id, role, emergency_access) VALUES ($1, $2, 'admin', true)", [ws, owner]);
  await sql(
    `INSERT INTO sso_provider (id, issuer, provider_id, organization_id, domain, domain_verified) VALUES ('sp1', 'https://acme.okta.com', 'anlyon-a5', $1, 'acme.com', true)`,
    [ws],
  );
  await sql(
    `INSERT INTO workspace_sso_connections (workspace_id, provider_id, protocol, domains, domain_verification_token, domains_verified_at)
     VALUES ($1, 'anlyon-a5', 'oidc', '["acme.com"]', 'tok', now())`,
    [ws],
  );
  ({ token } = await issueScimToken(ws, owner));
  await replaceRoleMappings(ws, owner, [
    { groupName: "Anlyon Admins", role: "admin", priority: 10 },
    { groupName: "Engineering", role: "member", priority: 0 },
  ]);
}, 120_000);

beforeEach(() => {
  audit.mockClear();
  redisDel.mockClear();
  revokeGrant.mockClear();
});

describe("authentication", () => {
  it("refuses a missing or wrong token with a SCIM error", async () => {
    for (const bearer of [null, "anlyon_scim_wrong", "anlyon_live_xxx"]) {
      const res = await call("GET", "/Users", undefined, bearer);
      expect(res.status).toBe(401);
      expect(res.contentType).toContain("application/scim+json");
      expect(res.challenge).toBe('Bearer realm="anlyon-scim"');
      expect(res.body).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" });
    }
  });

  it("stores only the token's hash", async () => {
    const [config] = await sql<{ token_hash: string; token_prefix: string }>(
      "SELECT token_hash, token_prefix FROM workspace_scim_configs WHERE workspace_id = $1",
      [ws],
    );
    expect(config.token_hash).not.toContain(token);
    expect(config.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.startsWith(config.token_prefix)).toBe(true);
  });

  it("serves discovery", async () => {
    const res = await call("GET", "/ServiceProviderConfig");
    expect(res.status).toBe(200);
    expect(res.body.patch.supported).toBe(true);
  });
});

describe("users", () => {
  let jane = { scimId: "", userId: "" };

  it("creates a person and a membership with the default role (Okta create)", async () => {
    const res = await call("POST", "/Users", oktaUser("jane@acme.com", "00u-jane"));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ userName: "jane@acme.com", externalId: "00u-jane", active: true });
    jane = {
      scimId: res.body.id,
      userId: (await sql<{ user_id: string }>("SELECT user_id FROM workspace_scim_users WHERE id = $1", [res.body.id]))[0].user_id,
    };
    expect(await role(jane.userId)).toBe("member");
    expect(audit).toHaveBeenCalledWith("member.provisioned", expect.objectContaining({ workspaceId: ws, userId: jane.userId, source: "scim" }));
  });

  it("finds the user by the filter providers send before creating, and refuses a duplicate", async () => {
    const found = await call("GET", `/Users?filter=${encodeURIComponent('userName eq "JANE@acme.com"')}`);
    expect(found.body.totalResults).toBe(1);
    const duplicate = await call("POST", "/Users", oktaUser("jane@acme.com", "00u-other"));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.scimType).toBe("uniqueness");
  });

  it("provisions an address only on a verified domain, with the same refusal whether or not an account exists", async () => {
    await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('user_ext', 'Ext', 'pat@gmail.com', true, now(), now())`);
    await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('user_acme', 'Lee', 'lee@acme.com', true, now(), now())`);
    const existing = await call("POST", "/Users", oktaUser("pat@gmail.com", "00u-pat"));
    const absent = await call("POST", "/Users", oktaUser("nobody@gmail.com", "00u-nobody"));
    expect(existing.status).toBe(400);
    expect(absent.status).toBe(400);
    expect(existing.body).toEqual(absent.body);
    expect(absent.body).toMatchObject({ scimType: "invalidValue", detail: expect.stringMatching(/domain verified for this workspace's single sign-on/) });
    expect(await role("user_ext")).toBeNull();
    expect(await sql(`SELECT id FROM "user" WHERE email = 'nobody@gmail.com'`)).toHaveLength(0);
    const linked = await call("POST", "/Users", oktaUser("lee@acme.com", "00u-lee"));
    expect(linked.status).toBe(201);
    expect(await role("user_acme")).toBe("member");
  });

  it("maps a group to a role, and back when the person leaves it (Entra ID group PATCH)", async () => {
    const group = await call("POST", "/Groups", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "Anlyon Admins",
      members: [{ value: jane.scimId }],
    });
    expect(group.status).toBe(201);
    expect(await role(jane.userId)).toBe("admin");
    expect(audit).toHaveBeenCalledWith("member.role_changed", expect.objectContaining({ oldRole: "member", newRole: "admin" }));

    const removed = await call("PATCH", `/Groups/${group.body.id}`, patchOp({ op: "Remove", path: "members", value: [{ value: jane.scimId }] }));
    expect(removed.status).toBe(204);
    expect(await role(jane.userId)).toBe("member");
  });

  it("re-applies roles when the mappings change", async () => {
    const group = await call("POST", "/Groups", { displayName: "Engineering", members: [{ value: jane.scimId }] });
    await replaceRoleMappings(ws, owner, [{ groupName: "engineering", role: "admin", priority: 1 }]);
    const { reapplyDirectoryRoles } = await import("../src/core/scim/service.ts");
    await reapplyDirectoryRoles(ws);
    expect(await role(jane.userId)).toBe("admin");
    await call("DELETE", `/Groups/${group.body.id}`);
    expect(await role(jane.userId)).toBe("member");
  });

  it("deactivation ends access to this workspace now, and only this one (Entra ID PATCH)", async () => {
    await sql("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [otherWs, jane.userId]);
    await sql(
      `INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES ('sess-jane', now() + interval '1 day', 'tok-jane', now(), now(), $1)`,
      [jane.userId],
    );
    const [key] = await sql<{ id: string }>(
      `INSERT INTO api_keys (workspace_id, environment_id, name, key_hash, key_prefix, created_by, is_active)
       VALUES ($1, $2, 'jane key', 'hash-jane', 'anlyon_live_xxx', $3, 'true') RETURNING id`,
      [ws, environmentId, jane.userId],
    );
    await sql(
      `INSERT INTO api_keys (workspace_id, environment_id, name, key_hash, key_prefix, created_by, is_active)
       VALUES ($1, $2, 'owner key', 'hash-owner', 'anlyon_live_yyy', $3, 'true')`,
      [ws, environmentId, owner],
    );
    await sql(`INSERT INTO oauth_client (id, client_id, redirect_uris) VALUES ('oc1', 'client-1', ARRAY['https://example.com/cb'])`);
    await sql(
      `INSERT INTO oauth_workspace_binding (id, user_id, client_id, workspace_id, environment_id) VALUES ('b1', $1, 'client-1', $2, $3)`,
      [jane.userId, ws, environmentId],
    );

    const res = await call("PATCH", `/Users/${jane.scimId}`, patchOp({ op: "Replace", path: "active", value: "False" }));
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);

    expect(await role(jane.userId)).toBeNull();
    expect(await sql("SELECT id FROM session WHERE user_id = $1", [jane.userId])).toEqual([{ id: "sess-jane" }]);
    expect(await streamStillAuthorized({ authType: "session", workspaceId: otherWs, userId: jane.userId, sessionId: "sess-jane" })).toBe(true);
    expect(await streamStillAuthorized({ authType: "session", workspaceId: ws, userId: jane.userId, sessionId: "sess-jane" })).toBe(false);
    expect(await streamStillAuthorized({ authType: "apiKey", workspaceId: ws, apiKeyId: key.id })).toBe(false);
    expect(await sql("SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [otherWs, jane.userId])).toEqual([{ role: "member" }]);
    expect(await sql("SELECT is_active FROM api_keys WHERE id = $1", [key.id])).toEqual([{ is_active: "false" }]);
    expect(await sql("SELECT is_active FROM api_keys WHERE key_hash = 'hash-owner'")).toEqual([{ is_active: "true" }]);
    expect(redisDel).toHaveBeenCalledWith("apikey:hash-jane", `apikey:${key.id}:previous`);
    expect(revokeGrant).toHaveBeenCalledWith(jane.userId, "client-1");
    expect(audit).toHaveBeenCalledWith(
      "member.deactivated",
      expect.objectContaining({ workspaceId: ws, userId: jane.userId, source: "scim", membershipRemoved: true, apiKeysRevoked: 1, oauthGrantsRevoked: 1 }),
    );
  });

  it("reactivation restores the membership with the role the groups give (Okta PUT)", async () => {
    const res = await call("PUT", `/Users/${jane.scimId}`, oktaUser("jane@acme.com", "00u-jane", true));
    expect(res.status).toBe(200);
    expect(await role(jane.userId)).toBe("member");
    expect(events()).toContain("member.reactivated");
  });

  it("never deactivates, deletes or re-roles an admin with emergency access", async () => {
    const res = await call("POST", "/Users", oktaUser("owner@acme.com", "00u-owner"));
    expect(res.status).toBe(201);
    expect(await role(owner)).toBe("admin");
    const deactivate = await call("PATCH", `/Users/${res.body.id}`, patchOp({ op: "replace", value: { active: false } }));
    expect(deactivate.status).toBe(400);
    expect(deactivate.body.scimType).toBe("mutability");
    expect((await call("DELETE", `/Users/${res.body.id}`)).status).toBe(400);
    expect(await role(owner)).toBe("admin");
    expect(await sql("SELECT emergency_access FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [ws, owner]))
      .toEqual([{ emergency_access: true }]);
  });

  it("deletion removes the membership and the SCIM record, and keeps the account", async () => {
    const res = await call("DELETE", `/Users/${jane.scimId}`);
    expect(res.status).toBe(204);
    expect(await role(jane.userId)).toBeNull();
    expect(await sql("SELECT id FROM workspace_scim_users WHERE id = $1", [jane.scimId])).toEqual([]);
    expect(await sql(`SELECT id FROM "user" WHERE id = $1`, [jane.userId])).toHaveLength(1);
    expect(events()).toContain("member.deprovisioned");
    expect((await call("GET", `/Users/${jane.scimId}`)).status).toBe(404);
  });

  it("a rotated token stops working at once", async () => {
    const old = token;
    ({ token } = await issueScimToken(ws, owner));
    expect((await call("GET", "/Users", undefined, old)).status).toBe(401);
    expect((await call("GET", "/Users")).status).toBe(200);
  });
});

describe("audit trail", () => {
  it("records every directory change in the audit stream, not only the log", async () => {
    const rows = await sql<{ type: string; category: string; actor_type: string; resource_type: string | null; data: Record<string, unknown> }>(
      "SELECT type, category, actor_type, resource_type, data FROM audit_events WHERE workspace_id = $1 ORDER BY seq",
      [ws],
    );
    const types = new Set(rows.map((row) => row.type));
    for (const type of [
      "scim.token_created",
      "scim.role_mappings_replaced",
      "member.provisioned",
      "member.role_changed",
      "group.created",
      "group.updated",
      "group.deleted",
      "member.deactivated",
      "member.reactivated",
      "member.deprovisioned",
      "api_key.revoked",
    ]) {
      expect(types, type).toContain(type);
    }
    expect(rows.every((row) => row.category === "access")).toBe(true);

    expect(rows.find((row) => row.type === "member.provisioned")).toMatchObject({ actor_type: "system", resource_type: "member", data: expect.objectContaining({ source: "scim" }) });
    expect(rows.find((row) => row.type === "scim.token_created")).toMatchObject({ actor_type: "user" });

    const revoked = rows.filter((row) => row.type === "api_key.revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ resource_type: "api_key", data: expect.objectContaining({ name: "jane key", reason: "member_deprovisioned" }) });
    expect(rows.find((row) => row.type === "member.deactivated")?.data).toMatchObject({ membershipRemoved: true, apiKeysRevoked: 1 });
  });
});
