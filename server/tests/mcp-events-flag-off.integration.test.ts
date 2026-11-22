import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

const suffix = randomUUID().slice(0, 8);
const userId = `mcp_flagoff_user_${suffix}`;
const clientId = `mcp_flagoff_client_${suffix}`;

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("MCP Events while the mcp-events flag is off", () => {
  let pool: Pool;
  let server: { close: (cb?: () => void) => void } | undefined;
  let mcpUrl = "";
  let workspaceId = "";
  let environmentId = "";
  let sign: (scope: string) => Promise<string>;

  async function modern(token: string, method: string, params: Record<string, unknown> = {}) {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "chatgpt-test", version: "0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const raw = await response.text();
    const json = raw.startsWith("{") ? raw : raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return { status: response.status, raw, message: json ? (JSON.parse(json) as { result?: any; error?: any }) : undefined };
  }

  beforeAll(async () => {
    const { isFeatureEnabled } = await import("@anlyon/feature-flags");
    expect(isFeatureEnabled("mcp-events" as never), "this test is about the flag being off").toBe(false);

    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Flag Off', $2, true, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (await pool.query(
      `INSERT INTO workspaces (name, slug, plan) VALUES ('MCP flag off', $1, 'paygo') RETURNING id`,
      [`mcp-flagoff-${suffix}`],
    )).rows[0].id;
    environmentId = (await pool.query(
      `INSERT INTO environments (id, workspace_id, name, slug, is_default)
       VALUES (gen_random_uuid(), $1, 'Production', 'production', true) RETURNING id`,
      [workspaceId],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at) VALUES (gen_random_uuid(), $1, $2, 'admin', now())`,
      [workspaceId, userId],
    );
    await pool.query(
      `INSERT INTO oauth_client (id, client_id, name, redirect_uris, public, disabled, created_at, updated_at)
       VALUES ($1, $2, 'ChatGPT', ARRAY['https://chatgpt.com/connector/oauth/cb_test'], true, false, now(), now())`,
      [randomUUID(), clientId],
    );
    await pool.query(
      `INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at, updated_at)
       VALUES ($1, $2, $3, ARRAY['openid','anlyon:actions','anlyon:messaging'], now(), now())`,
      [randomUUID(), clientId, userId],
    );
    await pool.query(
      `INSERT INTO oauth_workspace_binding (id, user_id, client_id, workspace_id, environment_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [randomUUID(), userId, clientId, workspaceId, environmentId],
    );

    const { auth, MCP_RESOURCE_URL, OAUTH_ISSUER } = await import("../src/utils/auth.ts");
    sign = async (scope: string) => {
      const now = Math.floor(Date.now() / 1000);
      const { token } = await auth.api.signJWT({
        body: { payload: { sub: userId, azp: clientId, scope, aud: MCP_RESOURCE_URL, iss: OAUTH_ISSUER, iat: now, exp: now + 900 } },
      });
      return token;
    };

    const origin = new URL(OAUTH_ISSUER);
    const app = (await import("../src/api/index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
    const { serve } = await import("@hono/node-server");
    const started = serve({ fetch: app.fetch, port: Number(origin.port), hostname: "127.0.0.1" });
    await new Promise((ready, fail) => {
      (started as unknown as NodeJS.EventEmitter).once("listening", ready);
      (started as unknown as NodeJS.EventEmitter).once("error", fail);
    });
    expect(((started as unknown as { address: () => AddressInfo }).address()).port).toBe(Number(origin.port));
    server = started as unknown as { close: (cb?: () => void) => void };
    mcpUrl = MCP_RESOURCE_URL;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (!pool) return;
    await pool.query(`DELETE FROM event_subscriptions WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM oauth_workspace_binding WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_consent WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_client WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM environments WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
    await pool.end();
  });

  it("never serves events/list on the modern path, and events/subscribe writes no subscription", async () => {
    const token = await sign("openid anlyon:actions anlyon:messaging");

    const listed = await modern(token, "events/list");
    expect(listed.message?.result?.events, listed.raw.slice(0, 300)).toBeUndefined();
    expect(listed.status !== 200 || listed.message?.error !== undefined, listed.raw.slice(0, 300)).toBe(true);

    const subscribed = await modern(token, "events/subscribe", {
      name: "approval.requested",
      arguments: {},
      delivery: { mode: "webhook", url: "https://hooks.chatgpt.test/flag-off", secret: `whsec_${"A".repeat(43)}=` },
      ttlMs: 60_000,
    });
    expect(subscribed.message?.result?.subscriptionId, subscribed.raw.slice(0, 300)).toBeUndefined();

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM event_subscriptions WHERE workspace_id = $1 AND delivery_format = 'mcp'`,
      [workspaceId],
    );
    expect(rows.rows[0].n).toBe(0);
  });
});
