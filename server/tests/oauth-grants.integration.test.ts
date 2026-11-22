import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";

let pool: Pool;
let available = false;

const suffix = randomUUID().slice(0, 8);
const userId = `grant_user_${suffix}`;
const otherUserId = `grant_other_${suffix}`;
const clientId = `grant_client_${suffix}`;
let workspaceId = "";
let environmentId = "";

beforeAll(async () => {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    await probe.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.end();
  }
  if (!available) return;

  pool = new Pool({ connectionString: DATABASE_URL });
  for (const id of [userId, otherUserId]) {
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'Grant Test', $2, true, now(), now())`,
      [id, `${id}@test.dev`],
    );
  }
  const ws = await pool.query(
    `INSERT INTO workspaces (name, slug, plan) VALUES ('Grants', $1, 'paygo') RETURNING id`,
    [`grants-${suffix}`],
  );
  workspaceId = ws.rows[0].id;
  const env = await pool.query(
    `INSERT INTO environments (id, workspace_id, name, slug, is_default)
     VALUES (gen_random_uuid(), $1, 'Production', 'production', true) RETURNING id`,
    [workspaceId],
  );
  environmentId = env.rows[0].id;
  await pool.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at)
     VALUES (gen_random_uuid(), $1, $2, 'admin', now())`,
    [workspaceId, userId],
  );
  await pool.query(
    `INSERT INTO oauth_client (id, client_id, name, redirect_uris, public, disabled, created_at, updated_at)
     VALUES ($1, $2, 'Test App', ARRAY['http://localhost:1/cb'], true, false, now(), now())`,
    [randomUUID(), clientId],
  );
});

afterAll(async () => {
  if (!available || !pool) return;
  await pool.query(`DELETE FROM oauth_client WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM workspace_members WHERE user_id = ANY($1)`, [[userId, otherUserId]]);
  await pool.query(`DELETE FROM environments WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM "user" WHERE id = ANY($1)`, [[userId, otherUserId]]);
  await pool.end();
});

async function grant(): Promise<void> {
  await pool.query(
    `INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at, updated_at)
     VALUES ($1, $2, $3, ARRAY['openid','anlyon:messaging'], now(), now())`,
    [randomUUID(), clientId, userId],
  );
  await pool.query(
    `INSERT INTO oauth_refresh_token (id, token, client_id, user_id, scopes, expires_at, created_at)
     VALUES ($1, $2, $3, $4, ARRAY['openid'], now() + interval '7 days', now())`,
    [randomUUID(), `rt_${randomUUID()}`, clientId, userId],
  );
  await pool.query(
    `INSERT INTO oauth_workspace_binding (id, user_id, client_id, workspace_id, environment_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (user_id, client_id) DO UPDATE SET updated_at = now()`,
    [randomUUID(), userId, clientId, workspaceId, environmentId],
  );
}

const clearGrant = async () => {
  await pool.query(`DELETE FROM oauth_consent WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM oauth_refresh_token WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM oauth_workspace_binding WHERE client_id = $1`, [clientId]);
};

describe("listGrants", () => {
  it("lists an app the user connected", async () => {
    if (!available) return;
    await clearGrant();
    await grant();
    const { listGrants } = await import("../src/core/auth/oauth-grants.ts");

    const grants = await listGrants(userId);
    const mine = grants.find((entry) => entry.clientId === clientId);
    expect(mine?.name).toBe("Test App");
    expect(mine?.workspace?.id).toBe(workspaceId);
    expect(mine?.permissions.map((permission) => permission.scope)).toContain("anlyon:messaging");
    expect(mine?.active).toBe(true);
  });

  it("still lists an app whose tokens have all expired", async () => {
    if (!available) return;
    await clearGrant();
    await grant();
    await pool.query(`UPDATE oauth_refresh_token SET expires_at = now() - interval '1 day' WHERE client_id = $1`, [
      clientId,
    ]);
    const { listGrants } = await import("../src/core/auth/oauth-grants.ts");

    const mine = (await listGrants(userId)).find((entry) => entry.clientId === clientId);
    expect(mine, "a dormant app must still be listed and revocable").toBeDefined();
    expect(mine?.active).toBe(false);
  });

  it("never shows one user another user's apps", async () => {
    if (!available) return;
    await clearGrant();
    await grant();
    const { listGrants } = await import("../src/core/auth/oauth-grants.ts");
    expect(await listGrants(otherUserId)).toEqual([]);
  });
});

describe("revokeGrant", () => {
  it("removes the authority, not just the tokens", async () => {
    if (!available) return;
    await clearGrant();
    await grant();
    const { revokeGrant } = await import("../src/core/auth/oauth-grants.ts");
    const { hasActiveConsent } = await import("../src/core/auth/oauth-tokens.ts");

    expect(await hasActiveConsent(userId, clientId)).toBe(true);
    await revokeGrant(userId, clientId);

    expect(await hasActiveConsent(userId, clientId)).toBe(false);
  });

  it("stops the app renewing", async () => {
    if (!available) return;
    await clearGrant();
    await grant();
    const { revokeGrant } = await import("../src/core/auth/oauth-grants.ts");
    await revokeGrant(userId, clientId);

    const live = await pool.query(
      `SELECT count(*)::int AS n FROM oauth_refresh_token WHERE client_id = $1 AND revoked IS NULL`,
      [clientId],
    );
    expect(live.rows[0].n).toBe(0);
  });

  it("forgets the workspace, so reconnecting asks again", async () => {
    if (!available) return;
    await clearGrant();
    await grant();
    const { revokeGrant } = await import("../src/core/auth/oauth-grants.ts");
    await revokeGrant(userId, clientId);

    const bindings = await pool.query(`SELECT 1 FROM oauth_workspace_binding WHERE client_id = $1`, [clientId]);
    expect(bindings.rowCount).toBe(0);
  });

  it("refuses to revoke an app the user has not connected", async () => {
    if (!available) return;
    await clearGrant();
    await grant();
    const { revokeGrant } = await import("../src/core/auth/oauth-grants.ts");
    await expect(revokeGrant(otherUserId, clientId)).rejects.toThrow();
    const { hasActiveConsent } = await import("../src/core/auth/oauth-tokens.ts");
    expect(await hasActiveConsent(userId, clientId)).toBe(true);
  });
});

describe("revocation is enforced where it counts", () => {

  it("refuses to resolve a token once the grant is revoked", async () => {
    if (!available) return;
    await clearGrant();
    await grant();
    const { resolveBinding } = await import("../src/core/auth/oauth-tokens.ts");
    const { revokeGrant } = await import("../src/core/auth/oauth-grants.ts");

    await expect(resolveBinding(userId, clientId)).resolves.toMatchObject({ workspaceId, environmentId });

    await revokeGrant(userId, clientId);

    await expect(resolveBinding(userId, clientId)).rejects.toThrow(/no longer connected/i);
  });

  it("refuses even when the user has a single workspace to fall back on", async () => {
    if (!available) return;
    await clearGrant();
    await pool.query(
      `INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at, updated_at)
       VALUES ($1, $2, $3, ARRAY['openid'], now(), now())`,
      [randomUUID(), clientId, userId],
    );
    const { resolveBinding } = await import("../src/core/auth/oauth-tokens.ts");
    const { revokeGrant } = await import("../src/core/auth/oauth-grants.ts");
    await expect(resolveBinding(userId, clientId)).resolves.toMatchObject({ workspaceId });

    await revokeGrant(userId, clientId);
    await expect(resolveBinding(userId, clientId)).rejects.toThrow(/no longer connected/i);
  });
});
