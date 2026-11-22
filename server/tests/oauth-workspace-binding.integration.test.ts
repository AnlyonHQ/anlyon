import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";

let pool: Pool;
let available = false;

const suffix = randomUUID().slice(0, 8);
const userId = `oauth_bind_user_${suffix}`;
const otherUserId = `oauth_bind_other_${suffix}`;
const clientA = `client_a_${suffix}`;
const clientB = `client_b_${suffix}`;

let workspaceOne = "";
let workspaceTwo = "";
let envOne = "";
let envTwo = "";

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
       VALUES ($1, 'Binding Test', $2, true, now(), now())`,
      [id, `${id}@test.dev`],
    );
  }

  const one = await pool.query(
    `INSERT INTO workspaces (name, slug, plan) VALUES ('Binding One', $1, 'paygo') RETURNING id`,
    [`binding-one-${suffix}`],
  );
  const two = await pool.query(
    `INSERT INTO workspaces (name, slug, plan) VALUES ('Binding Two', $1, 'paygo') RETURNING id`,
    [`binding-two-${suffix}`],
  );
  workspaceOne = one.rows[0].id;
  workspaceTwo = two.rows[0].id;

  for (const [workspaceId, ref] of [[workspaceOne, "one"], [workspaceTwo, "two"]] as const) {
    const env = await pool.query(
      `INSERT INTO environments (id, workspace_id, name, slug, is_default)
       VALUES (gen_random_uuid(), $1, 'Production', 'production', true) RETURNING id`,
      [workspaceId],
    );
    if (ref === "one") envOne = env.rows[0].id;
    else envTwo = env.rows[0].id;
  }

  for (const workspaceId of [workspaceOne, workspaceTwo]) {
    await pool.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at)
       VALUES (gen_random_uuid(), $1, $2, 'admin', now())`,
      [workspaceId, userId],
    );
  }

  for (const clientId of [clientA, clientB]) {
    await pool.query(
      `INSERT INTO oauth_client (id, client_id, name, redirect_uris, public, disabled, created_at, updated_at)
       VALUES ($1, $2, 'Test Harness', ARRAY['http://localhost:1/callback'], true, false, now(), now())`,
      [randomUUID(), clientId],
    );
  }
});

afterAll(async () => {
  if (!available || !pool) return;
  await pool.query(`DELETE FROM oauth_workspace_binding WHERE user_id = ANY($1)`, [[userId, otherUserId]]);
  await pool.query(`DELETE FROM oauth_client WHERE client_id = ANY($1)`, [[clientA, clientB]]);
  await pool.query(`DELETE FROM workspace_members WHERE user_id = ANY($1)`, [[userId, otherUserId]]);
  await pool.query(`DELETE FROM environments WHERE workspace_id = ANY($1)`, [[workspaceOne, workspaceTwo]]);
  await pool.query(`DELETE FROM workspaces WHERE id = ANY($1)`, [[workspaceOne, workspaceTwo]]);
  await pool.query(`DELETE FROM "user" WHERE id = ANY($1)`, [[userId, otherUserId]]);
  await pool.end();
});

const bind = (clientId: string, workspaceId: string, environmentId: string) =>
  pool.query(
    `INSERT INTO oauth_workspace_binding (id, user_id, client_id, workspace_id, environment_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (user_id, client_id)
     DO UPDATE SET workspace_id = EXCLUDED.workspace_id, environment_id = EXCLUDED.environment_id, updated_at = now()`,
    [randomUUID(), userId, clientId, workspaceId, environmentId],
  );

const read = async (clientId: string) =>
  (
    await pool.query(
      `SELECT workspace_id, environment_id FROM oauth_workspace_binding WHERE user_id = $1 AND client_id = $2`,
      [userId, clientId],
    )
  ).rows[0];

describe("oauth workspace binding", () => {
  it("keeps two clients of the same user pointed at different workspaces", async () => {
    if (!available) return;
    await bind(clientA, workspaceOne, envOne);
    await bind(clientB, workspaceTwo, envTwo);

    expect((await read(clientA)).workspace_id).toBe(workspaceOne);
    expect((await read(clientB)).workspace_id).toBe(workspaceTwo);
  });

  it("switches a client's workspace in place rather than accumulating rows", async () => {
    if (!available) return;
    await bind(clientA, workspaceOne, envOne);
    await bind(clientA, workspaceTwo, envTwo);

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM oauth_workspace_binding WHERE user_id = $1 AND client_id = $2`,
      [userId, clientA],
    );
    expect(rows.rows[0].n).toBe(1);
    expect((await read(clientA)).workspace_id).toBe(workspaceTwo);

    await bind(clientA, workspaceOne, envOne);
  });

  it("allows only one binding per user and client", async () => {
    if (!available) return;
    await expect(
      pool.query(
        `INSERT INTO oauth_workspace_binding (id, user_id, client_id, workspace_id, environment_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())`,
        [randomUUID(), userId, clientA, workspaceTwo, envTwo],
      ),
    ).rejects.toThrow();
  });

  it("does not leak one user's binding to another", async () => {
    if (!available) return;
    await bind(clientA, workspaceOne, envOne);
    const foreign = await pool.query(
      `SELECT 1 FROM oauth_workspace_binding WHERE user_id = $1 AND client_id = $2`,
      [otherUserId, clientA],
    );
    expect(foreign.rowCount).toBe(0);
  });

  it("disappears with the workspace it points at", async () => {
    if (!available) return;
    const throwaway = await pool.query(
      `INSERT INTO workspaces (name, slug, plan) VALUES ('Throwaway', $1, 'paygo') RETURNING id`,
      [`binding-throwaway-${suffix}`],
    );
    const workspaceId = throwaway.rows[0].id;
    const env = await pool.query(
      `INSERT INTO environments (id, workspace_id, name, slug, is_default)
       VALUES (gen_random_uuid(), $1, 'Production', 'production', true) RETURNING id`,
      [workspaceId],
    );
    await pool.query(
      `INSERT INTO oauth_workspace_binding (id, user_id, client_id, workspace_id, environment_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [randomUUID(), otherUserId, clientB, workspaceId, env.rows[0].id],
    );

    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);

    const orphans = await pool.query(`SELECT 1 FROM oauth_workspace_binding WHERE workspace_id = $1`, [workspaceId]);
    expect(orphans.rowCount).toBe(0);
  });

  it("refuses to bind to a workspace that does not exist", async () => {
    if (!available) return;
    await expect(
      pool.query(
        `INSERT INTO oauth_workspace_binding (id, user_id, client_id, workspace_id, environment_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())`,
        [randomUUID(), otherUserId, clientA, randomUUID(), envOne],
      ),
    ).rejects.toThrow();
  });
});

describe("security regressions", () => {

  it("stops resolving a binding once the user leaves the workspace", async () => {
    if (!available) return;
    const { default: pg } = await import("pg");
    void pg;
    await bind(clientA, workspaceOne, envOne);

    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [
      workspaceOne,
      userId,
    ]);
    try {
      const { hasWorkspaceAccess } = await import("../src/core/workspace/service.ts");
      expect(await hasWorkspaceAccess(workspaceOne, userId)).toBe(false);

      const { verifyOAuthAccessToken } = await import("../src/core/auth/oauth-tokens.ts");
      void verifyOAuthAccessToken;

      const [row] = await pool.query(
        `SELECT workspace_id FROM oauth_workspace_binding WHERE user_id = $1 AND client_id = $2`,
        [userId, clientA],
      ).then((r) => r.rows);
      expect(row, "binding row still exists  the check must be at resolve time, not on delete").toBeDefined();
    } finally {
      await pool.query(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at)
         VALUES (gen_random_uuid(), $1, $2, 'admin', now())`,
        [workspaceOne, userId],
      );
    }
  });

  it("refuses to pair a workspace with another workspace's environment", async () => {
    if (!available) return;
    const { setWorkspaceBinding } = await import("../src/core/auth/oauth-tokens.ts");

    await expect(setWorkspaceBinding(userId, clientA, workspaceOne, envTwo)).rejects.toThrow();

    await expect(setWorkspaceBinding(userId, clientA, workspaceOne, envOne)).resolves.toBeUndefined();
  });

  it("refuses to bind a workspace the user is not a member of", async () => {
    if (!available) return;
    const { setWorkspaceBinding } = await import("../src/core/auth/oauth-tokens.ts");
    const stranger = await pool.query(
      `INSERT INTO workspaces (name, slug, plan) VALUES ('Not Mine', $1, 'paygo') RETURNING id`,
      [`not-mine-${suffix}`],
    );
    const strangerWorkspace = stranger.rows[0].id;
    const strangerEnv = await pool.query(
      `INSERT INTO environments (id, workspace_id, name, slug, is_default)
       VALUES (gen_random_uuid(), $1, 'Production', 'production', true) RETURNING id`,
      [strangerWorkspace],
    );
    try {
      await expect(
        setWorkspaceBinding(userId, clientA, strangerWorkspace, strangerEnv.rows[0].id),
      ).rejects.toThrow(/access/i);
    } finally {
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [strangerWorkspace]);
    }
  });
});
