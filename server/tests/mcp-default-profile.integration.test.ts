import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { LEGACY_TOOL_NAMES } from "@anlyonhq/mcp-server";

const SNAPSHOTS = "./__snapshots__/mcp-default-profile";
const suffix = randomUUID().slice(0, 8);
const userId = `mcp_default_user_${suffix}`;
const clientId = `mcp_default_client_${suffix}`;

const ALL_GROUPS =
  "openid profile email offline_access anlyon:memory anlyon:messaging anlyon:actions anlyon:events anlyon:approvals.decide anlyon:files anlyon:observability anlyon:integrations anlyon:secrets anlyon:workspace.switch anlyon:budgets";

function normalize(text: string, known: Record<string, string>): string {
  let out = text;
  for (const [value, label] of Object.entries(known)) out = out.split(value).join(label);
  return out
    .replace(/\b(apr|inv|act|acv|ses|evt|top|sub|mem|key|prv|eff)_[A-Za-z0-9_-]{6,}/g, "$1_<id>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>");
}

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("hosted /mcp default profile (non-ChatGPT OAuth client)", () => {
  let pool: Pool;
  let server: { close: (cb?: () => void) => void } | undefined;
  let mcpUrl = "";
  let token = "";
  let workspaceId = "";
  let environmentId = "";
  let known: Record<string, string> = {};

  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
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

  const bytes = (value: unknown) => `${normalize(JSON.stringify(value, null, 2), known)}\n`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Default Profile', $2, true, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (await pool.query(
      `INSERT INTO workspaces (name, slug, plan) VALUES ('Default Profile', $1, 'paygo') RETURNING id`,
      [`default-profile-${suffix}`],
    )).rows[0].id;
    environmentId = (await pool.query(
      `INSERT INTO environments (id, workspace_id, name, slug, is_default) VALUES (gen_random_uuid(), $1, 'Production', 'production', true) RETURNING id`,
      [workspaceId],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at) VALUES (gen_random_uuid(), $1, $2, 'admin', now())`,
      [workspaceId, userId],
    );
    await pool.query(
      `INSERT INTO oauth_client (id, client_id, name, redirect_uris, public, disabled, created_at, updated_at)
       VALUES ($1, $2, 'Claude Code', ARRAY['http://127.0.0.1:33418/callback'], true, false, now(), now())`,
      [randomUUID(), clientId],
    );
    await pool.query(
      `INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), clientId, userId, ALL_GROUPS.split(" ")],
    );
    await pool.query(
      `INSERT INTO oauth_workspace_binding (id, user_id, client_id, workspace_id, environment_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [randomUUID(), userId, clientId, workspaceId, environmentId],
    );
    known = { [workspaceId]: "<workspace>", [environmentId]: "<environment>", [userId]: "<user>", [suffix]: "<suffix>" };

    const { createAction, UNSCOPED_AUTHORITY } = await import("../src/core/actions/service.ts");
    await createAction(
      workspaceId,
      {
        name: "update-ticket-priority",
        description: "Change a support ticket priority.",
        method: "PATCH",
        urlTemplate: "https://support.example.com/tickets/{{input.ticketId}}",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          properties: { ticketId: { type: "string" }, priority: { type: "string", enum: ["low", "high"] } },
          required: ["ticketId", "priority"],
        },
      },
      UNSCOPED_AUTHORITY,
      environmentId,
    );

    const { auth, MCP_RESOURCE_URL, OAUTH_ISSUER } = await import("../src/utils/auth.ts");
    const now = Math.floor(Date.now() / 1000);
    ({ token } = await auth.api.signJWT({
      body: { payload: { sub: userId, azp: clientId, scope: ALL_GROUPS, aud: MCP_RESOURCE_URL, iss: OAUTH_ISSUER, iat: now, exp: now + 900 } },
    }));
    mcpUrl = MCP_RESOURCE_URL;

    const app = (await import("../src/api/index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
    const { serve } = await import("@hono/node-server");
    const started = serve({ fetch: app.fetch, port: Number(new URL(OAUTH_ISSUER).port), hostname: "127.0.0.1" });
    await new Promise((ready, fail) => {
      (started as unknown as NodeJS.EventEmitter).once("listening", ready);
      (started as unknown as NodeJS.EventEmitter).once("error", fail);
    });
    expect(((started as unknown as { address: () => AddressInfo }).address()).port).toBe(Number(new URL(OAUTH_ISSUER).port));
    server = started as unknown as { close: (cb?: () => void) => void };
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (!pool) return;
    await pool.query(`DELETE FROM approvals WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM action_invocations WHERE workspace_id = $1`, [workspaceId]).catch(() => {});
    await pool.query(`DELETE FROM actions WHERE workspace_id = $1`, [workspaceId]).catch(() => {});
    await pool.query(`DELETE FROM oauth_workspace_binding WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_consent WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_client WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM environments WHERE workspace_id = $1`, [workspaceId]).catch(() => {});
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]).catch(() => {});
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
    await pool.end();
  });

  it("tools/list", async () => {
    await expect(bytes(await rpc("tools/list"))).toMatchFileSnapshot(`${SNAPSHOTS}/tools-list.json`);
  });

  it("hides the legacy tools from the list and refuses them by name, under a grant that covers them", async () => {
    const names = ((await rpc("tools/list")).tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual([
      "list_actions",
      "invoke_action",
      "request_approval",
      "check_approval",
      "wait_for_approval",
      "get_invocation",
      "list_pending_approvals",
      "decide_approval",
      "check_sign_off",
      "wait_for_sign_off",
      "list_workspaces",
      "select_workspace",
      "action_update-ticket-priority",
    ]);
    for (const legacy of LEGACY_TOOL_NAMES) expect(names).not.toContain(legacy);

    for (const name of ["publish_event", "list_topics"]) {
      expect(LEGACY_TOOL_NAMES.has(name), name).toBe(true);
    }
    for (const name of ["publish_event", "list_topics", "memory_recall", "create_session", "queue_publish", "list_files", "cache_lookup"]) {
      const refused = await rpc("tools/call", { name, arguments: {} });
      expect(refused.isError, name).toBe(true);
      expect(refused.content[0].text).toBe(`Unknown tool: ${name}`);
    }
  });

  it("tools/call list_actions", async () => {
    await expect(bytes(await rpc("tools/call", { name: "list_actions", arguments: {} }))).toMatchFileSnapshot(
      `${SNAPSHOTS}/call-list_actions.json`,
    );
  });

  it("tools/call action_update-ticket-priority (parks for a person)", async () => {
    const result = await rpc("tools/call", {
      name: "action_update-ticket-priority",
      arguments: { ticketId: "T-1", priority: "high" },
    });
    await expect(bytes(result)).toMatchFileSnapshot(`${SNAPSHOTS}/call-action-gated.json`);
  });

  it("tools/call request_approval then check_approval", async () => {
    const requested = await rpc("tools/call", { name: "request_approval", arguments: { title: "Send the contract?" } });
    await expect(bytes(requested)).toMatchFileSnapshot(`${SNAPSHOTS}/call-request_approval.json`);
    const approvalId = JSON.parse(requested.content[0].text).id as string;
    const checked = await rpc("tools/call", { name: "check_approval", arguments: { approvalId } });
    await expect(bytes(checked)).toMatchFileSnapshot(`${SNAPSHOTS}/call-check_approval.json`);
  });

  it("tools/call an unknown action", async () => {
    const result = await rpc("tools/call", { name: "invoke_action", arguments: { name: "does-not-exist" } });
    await expect(bytes(result)).toMatchFileSnapshot(`${SNAPSHOTS}/call-invoke-unknown.json`);
  });
});
