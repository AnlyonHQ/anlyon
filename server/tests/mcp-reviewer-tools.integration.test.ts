import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

const suffix = randomUUID().slice(0, 8);
const requesterId = `mcp_rev_requester_${suffix}`;
const reviewerId = `mcp_rev_reviewer_${suffix}`;
const clientId = `mcp_rev_client_${suffix}`;

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("MCP reviewer tools through the hosted route", () => {
  let pool: Pool;
  let server: { close: (cb?: () => void) => void } | undefined;
  let mcpUrl = "";
  let workspaceId = "";
  let environmentId = "";
  let sign: (scope: string) => Promise<string>;
  let createApproval: typeof import("../src/core/approvals/service.ts").createApproval;

  async function mcp(token: string, method: string, params: Record<string, unknown> = {}) {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    });
    const raw = await response.text();
    expect(response.status, raw.slice(0, 500)).toBe(200);
    const json = raw.startsWith("{") ? raw : raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    expect(json, `no JSON-RPC message in: ${raw.slice(0, 300)}`).toBeTruthy();
    const message = JSON.parse(json as string);
    expect(message.error, JSON.stringify(message.error)).toBeUndefined();
    return message.result;
  }

  const toolText = (result: { content: Array<{ type: string; text: string }> }) =>
    result.content.map((part) => part.text).join("");

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    for (const [id, name] of [[requesterId, "Requester"], [reviewerId, "Ada Reviewer"]]) {
      await pool.query(
        `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
         VALUES ($1, $2, $3, true, now(), now())`,
        [id, name, `${id}@test.dev`],
      );
    }
    workspaceId = (await pool.query(
      `INSERT INTO workspaces (name, slug, plan) VALUES ('MCP Reviewers', $1, 'paygo') RETURNING id`,
      [`mcp-reviewers-${suffix}`],
    )).rows[0].id;
    environmentId = (await pool.query(
      `INSERT INTO environments (id, workspace_id, name, slug, is_default)
       VALUES (gen_random_uuid(), $1, 'Production', 'production', true) RETURNING id`,
      [workspaceId],
    )).rows[0].id;
    for (const [id, role] of [[requesterId, "admin"], [reviewerId, "member"]]) {
      await pool.query(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [workspaceId, id, role],
      );
    }
    await pool.query(
      `INSERT INTO oauth_client (id, client_id, name, redirect_uris, public, disabled, created_at, updated_at)
       VALUES ($1, $2, 'ChatGPT', ARRAY['https://chatgpt.com/connector/oauth/cb_test'], true, false, now(), now())`,
      [randomUUID(), clientId],
    );
    await pool.query(
      `INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at, updated_at)
       VALUES ($1, $2, $3, ARRAY['openid','anlyon:actions','anlyon:approvals.decide'], now(), now())`,
      [randomUUID(), clientId, reviewerId],
    );
    await pool.query(
      `INSERT INTO oauth_workspace_binding (id, user_id, client_id, workspace_id, environment_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [randomUUID(), reviewerId, clientId, workspaceId, environmentId],
    );

    const { auth, MCP_RESOURCE_URL, OAUTH_ISSUER } = await import("../src/utils/auth.ts");
    ({ createApproval } = await import("../src/core/approvals/service.ts"));
    sign = async (scope: string) => {
      const now = Math.floor(Date.now() / 1000);
      const { token } = await auth.api.signJWT({
        body: {
          payload: { sub: reviewerId, azp: clientId, scope, aud: MCP_RESOURCE_URL, iss: OAUTH_ISSUER, iat: now, exp: now + 900 },
        },
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
    await pool.query(`DELETE FROM approvals WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM oauth_workspace_binding WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_consent WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_client WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM environments WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM "user" WHERE id = ANY($1)`, [[requesterId, reviewerId]]);
    await pool.end();
  });

  it("does not offer the reviewer tools to a connection without the decide grant", async () => {
    const token = await sign("openid anlyon:actions");
    const { tools } = await mcp(token, "tools/list");
    const names = tools.map((tool: { name: string }) => tool.name);

    expect(names).toContain("request_approval");
    expect(names).not.toContain("decide_approval");
    expect(names).not.toContain("list_pending_approvals");

    const result = await mcp(token, "tools/call", {
      name: "decide_approval",
      arguments: { approvalId: "apr_none", decision: "approve", reason: "x" },
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toMatch(/Unknown tool/);
  });

  it("offers them, annotated and scoped, to a connection that was granted deciding", async () => {
    const { tools } = await mcp(await sign("openid anlyon:actions anlyon:approvals.decide"), "tools/list");
    const decide = tools.find((tool: { name: string }) => tool.name === "decide_approval");

    expect(decide.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(decide.securitySchemes).toEqual([{ type: "oauth2", scopes: ["anlyon:approvals.decide"] }]);
  });

  it("lists an approval created elsewhere and records the MCP reviewer as its decider", async () => {
    const created = await createApproval(
      workspaceId,
      { title: "Raise ticket T-1042 to high priority", payload: { ticketId: "T-1042", priority: "high" } },
      { environmentId },
    );
    const token = await sign("openid anlyon:actions anlyon:approvals.decide");

    const listed = JSON.parse(toolText(await mcp(token, "tools/call", { name: "list_pending_approvals", arguments: {} })));
    expect(listed.map((approval: { id: string }) => approval.id)).toContain(created.id);

    const decided = await mcp(token, "tools/call", {
      name: "decide_approval",
      arguments: { approvalId: created.id, decision: "approve", reason: "Checked the ticket" },
    });
    expect(decided.isError, toolText(decided)).toBeFalsy();
    const body = JSON.parse(toolText(decided));
    expect(body.approval.status).toBe("approved");
    expect(body.approval.decisionNote).toBe("Checked the ticket");
    expect(body.approval.decidedBy).toEqual({ type: "user", id: reviewerId, displayName: null });

    const row = await pool.query(
      `SELECT status, decided_by_user_id, decided_by_key_id FROM approvals WHERE approval_id = $1`,
      [created.id],
    );
    expect(row.rows[0]).toEqual({ status: "approved", decided_by_user_id: reviewerId, decided_by_key_id: null });
  });

  it("refuses a connection deciding an approval it requested itself; the row stays pending", async () => {
    const token = await sign("openid anlyon:actions anlyon:approvals.decide");
    const requested = await mcp(token, "tools/call", {
      name: "request_approval",
      arguments: { title: "Refund order 42", payload: { orderId: "ord_42", amount: 2400 } },
    });
    expect(requested.isError, toolText(requested)).toBeFalsy();
    const approvalId = JSON.parse(toolText(requested)).id as string;
    expect(approvalId).toMatch(/^apr_/);

    const decided = await mcp(token, "tools/call", {
      name: "decide_approval",
      arguments: { approvalId, decision: "approve", reason: "looks fine to me" },
    });
    expect(decided.isError).toBe(true);
    expect(toolText(decided)).toMatch(/cannot decide an approval it requested/i);

    const row = await pool.query(
      `SELECT status, decided_by_user_id, requested_by_user_id, requested_by_oauth_client_id FROM approvals WHERE approval_id = $1`,
      [approvalId],
    );
    expect(row.rows[0]).toEqual({
      status: "pending",
      decided_by_user_id: null,
      requested_by_user_id: reviewerId,
      requested_by_oauth_client_id: clientId,
    });
  });

  it("offers a memory-only connection no memory or session tools by default", async () => {
    const token = await sign("openid anlyon:memory");
    const { tools } = await mcp(token, "tools/list");
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(["check_sign_off", "wait_for_sign_off", "list_workspaces"]);

    const refused = await mcp(token, "tools/call", { name: "create_session", arguments: { title: "x" } });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toBe("Unknown tool: create_session");
  });

  describe("with ANLYON_MCP_LEGACY_TOOLS=1", () => {
    beforeEach(() => {
      vi.stubEnv("ANLYON_MCP_LEGACY_TOOLS", "1");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("lists only the events tools to a messaging-only connection", async () => {
      const { tools } = await mcp(await sign("openid anlyon:messaging"), "tools/list");
      const names = tools.map((tool: { name: string }) => tool.name);

      expect(names).toEqual(expect.arrayContaining(["publish_event", "list_events", "list_topics", "create_subscription"]));
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toBeDefined();
        const scopes = tool.securitySchemes[0].scopes as string[];
        expect(scopes.every((scope) => scope === "anlyon:messaging"), `${tool.name}: ${scopes}`).toBe(true);
      }
      expect(names).not.toContain("list_actions");
    });
  });
});
