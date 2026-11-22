import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { LEGACY_TOOL_NAMES } from "@anlyonhq/mcp-server";

const suffix = randomUUID().slice(0, 8);
const userId = `mcp_profile_user_${suffix}`;
const chatgptClient = `mcp_profile_chatgpt_${suffix}`;
const codingClient = `mcp_profile_coding_${suffix}`;
const SCOPES = "openid anlyon:memory anlyon:actions";

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("hosted /mcp presentation by OAuth client", () => {
  let pool: Pool;
  let server: { close: (cb?: () => void) => void } | undefined;
  let mcpUrl = "";
  let workspaceId = "";
  const tokens: Record<string, string> = {};

  async function rpc(client: string, method: string, params: Record<string, unknown> = {}) {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens[client]}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const raw = await response.text();
    expect(response.status, raw.slice(0, 300)).toBe(200);
    const json = raw.startsWith("{") ? raw : raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return JSON.parse(json as string).result;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Profile', $2, true, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (await pool.query(
      `INSERT INTO workspaces (name, slug, plan) VALUES ('Profile', $1, 'paygo') RETURNING id`,
      [`profile-${suffix}`],
    )).rows[0].id;
    const environmentId = (await pool.query(
      `INSERT INTO environments (id, workspace_id, name, slug, is_default) VALUES (gen_random_uuid(), $1, 'Production', 'production', true) RETURNING id`,
      [workspaceId],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at) VALUES (gen_random_uuid(), $1, $2, 'admin', now())`,
      [workspaceId, userId],
    );
    const redirects: Record<string, string> = {
      [chatgptClient]: "https://chatgpt.com/connector/oauth/cb_profile_test",
      [codingClient]: "http://127.0.0.1:33418/callback",
    };
    for (const [clientId, redirect] of Object.entries(redirects)) {
      await pool.query(
        `INSERT INTO oauth_client (id, client_id, name, redirect_uris, public, disabled, created_at, updated_at)
         VALUES ($1, $2, $2, ARRAY[$3], true, false, now(), now())`,
        [randomUUID(), clientId, redirect],
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
    }

    const { createAction, UNSCOPED_AUTHORITY } = await import("../src/core/actions/service.ts");
    await createAction(
      workspaceId,
      { name: "update-ticket-priority", description: "Change a ticket priority.", method: "PATCH", urlTemplate: "https://support.example.com/tickets", requiresApproval: true },
      UNSCOPED_AUTHORITY,
      environmentId,
    );

    const { auth, MCP_RESOURCE_URL, OAUTH_ISSUER } = await import("../src/utils/auth.ts");
    const now = Math.floor(Date.now() / 1000);
    for (const clientId of [chatgptClient, codingClient]) {
      ({ token: tokens[clientId] } = await auth.api.signJWT({
        body: { payload: { sub: userId, azp: clientId, scope: SCOPES, aud: MCP_RESOURCE_URL, iss: OAUTH_ISSUER, iat: now, exp: now + 900 } },
      }));
    }
    mcpUrl = MCP_RESOURCE_URL;

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
    await pool.query(`DELETE FROM actions WHERE workspace_id = $1`, [workspaceId]).catch(() => {});
    await pool.query(`DELETE FROM oauth_workspace_binding WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM oauth_consent WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM oauth_client WHERE client_id = ANY($1)`, [[chatgptClient, codingClient]]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM environments WHERE workspace_id = $1`, [workspaceId]).catch(() => {});
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]).catch(() => {});
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
    await pool.end();
  });

  it("shows ChatGPT the same tools, with its descriptions and _meta security schemes", async () => {
    const chatgpt = (await rpc(chatgptClient, "tools/list")).tools;
    const coding = (await rpc(codingClient, "tools/list")).tools;

    const names = chatgpt.map((t: { name: string }) => t.name);
    expect(names).toEqual(coding.map((t: { name: string }) => t.name));
    expect(names).toEqual(expect.arrayContaining(["list_actions", "invoke_action", "request_approval", "action_update-ticket-priority"]));
    for (const legacy of LEGACY_TOOL_NAMES) expect(names).not.toContain(legacy);

    const invoke = (tools: Array<{ name: string; description: string; _meta?: unknown }>) => tools.find((t) => t.name === "invoke_action");
    expect(invoke(chatgpt)?.description).toMatch(/Anlyon makes the request with credentials it holds/);
    expect(invoke(coding)?.description).not.toMatch(/Anlyon makes the request with credentials it holds/);
    expect(invoke(chatgpt)?._meta).toEqual({ securitySchemes: [{ type: "oauth2", scopes: ["anlyon:actions"] }] });
    expect(invoke(coding)?._meta).toBeUndefined();
  });

  it("trims ChatGPT's outputs and leaves the other client's whole", async () => {
    const call = async (client: string) =>
      JSON.parse((await rpc(client, "tools/call", { name: "list_actions", arguments: {} })).content[0].text)[0];

    const chatgpt = await call(chatgptClient);
    const coding = await call(codingClient);
    expect(chatgpt).not.toHaveProperty("urlTemplate");
    expect(chatgpt).toMatchObject({ name: "update-ticket-priority", requiresApproval: true });
    expect(coding).toHaveProperty("urlTemplate", "https://support.example.com/tickets");
  });
});
