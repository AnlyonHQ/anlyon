import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const suffix = randomUUID().slice(0, 8);
const userId = `oauth_budget_user_${suffix}`;
const clientId = `oauth_budget_client_${suffix}`;
const SCOPES = "openid anlyon:actions";

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("budgets for OAuth connections", () => {
  let pool: Pool;
  let server: { close: (cb?: () => void) => void } | undefined;
  let token = "";
  let workspaceId = "";
  let origin = "";

  const invoke = () =>
    fetch(`${origin}/api/v2/actions/update-ticket-priority/invoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ input: { ticketId: "T-1042" } }),
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Budget', $2, true, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (await pool.query(
      `INSERT INTO workspaces (name, slug, plan) VALUES ('OAuth budget', $1, 'paygo') RETURNING id`,
      [`oauth-budget-${suffix}`],
    )).rows[0].id;
    const environmentId = (await pool.query(
      `INSERT INTO environments (id, workspace_id, name, slug, is_default) VALUES (gen_random_uuid(), $1, 'Production', 'production', true) RETURNING id`,
      [workspaceId],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at) VALUES (gen_random_uuid(), $1, $2, 'admin', now())`,
      [workspaceId, userId],
    );
    await pool.query(
      `INSERT INTO oauth_client (id, client_id, name, redirect_uris, public, disabled, created_at, updated_at)
       VALUES ($1, $2, $2, ARRAY['http://127.0.0.1:33418/callback'], true, false, now(), now())`,
      [randomUUID(), clientId],
    );
    await pool.query(
      `INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), clientId, userId, SCOPES.split(" ")],
    );
    await pool.query(
      `INSERT INTO oauth_workspace_binding (id, user_id, client_id, workspace_id, environment_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [randomUUID(), userId, clientId, workspaceId, environmentId],
    );

    const { createAction, UNSCOPED_AUTHORITY } = await import("../src/core/actions/service.ts");
    await createAction(
      workspaceId,
      { name: "update-ticket-priority", description: "Change a ticket priority.", method: "PATCH", urlTemplate: "https://support.example.com/tickets", requiresApproval: true },
      UNSCOPED_AUTHORITY,
      environmentId,
    );

    const { auth, MCP_RESOURCE_URL, OAUTH_ISSUER } = await import("../src/utils/auth.ts");
    const now = Math.floor(Date.now() / 1000);
    ({ token } = await auth.api.signJWT({
      body: { payload: { sub: userId, azp: clientId, scope: SCOPES, aud: MCP_RESOURCE_URL, iss: OAUTH_ISSUER, iat: now, exp: now + 900 } },
    }));
    origin = new URL(OAUTH_ISSUER).origin;

    const app = (await import("../src/api/index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
    const { serve } = await import("@hono/node-server");
    const started = serve({ fetch: app.fetch, port: Number(new URL(OAUTH_ISSUER).port), hostname: "127.0.0.1" });
    await new Promise((ready, fail) => {
      (started as unknown as NodeJS.EventEmitter).once("listening", ready);
      (started as unknown as NodeJS.EventEmitter).once("error", fail);
    });
    server = started as unknown as { close: (cb?: () => void) => void };
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (!pool) return;
    await pool.query(`DELETE FROM approvals WHERE workspace_id = $1`, [workspaceId]).catch(() => {});
    await pool.query(`DELETE FROM oauth_workspace_binding WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM oauth_consent WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM oauth_client WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]).catch(() => {});
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
    await pool.end();
  });

  it("records the connection's operations against its own principal, and a cap refuses the next one", async () => {
    const first = await invoke();
    expect(first.status, (await first.clone().text()).slice(0, 300)).toBeLessThan(300);

    const principals = await pool.query(
      `SELECT k.id, k.key_prefix, k.scopes, b.enabled FROM api_keys k JOIN key_budgets b ON b.api_key_id = k.id
       WHERE k.workspace_id = $1 AND k.budget_principal IS NOT NULL`,
      [workspaceId],
    );
    expect(principals.rows).toEqual([{ id: expect.any(String), key_prefix: "oauth", scopes: [], enabled: true }]);

    await pool.query(`UPDATE key_budgets SET dimension_caps = '{"actionInvokes": 1}'::jsonb WHERE api_key_id = $1`, [principals.rows[0].id]);
    const { redis } = await import("../src/lib/redis.ts");
    for (const key of await redis.keys(`*${principals.rows[0].id}*`)) await redis.del(key);

    const second = await invoke();
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("BUDGET_EXCEEDED");
  });
});
