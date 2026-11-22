import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";

type AuthModule = typeof import("../src/utils/auth.ts");

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("OAuth for an account with no workspace", () => {
  let pool: Pool;
  let auth: AuthModule["auth"];
  let MCP_RESOURCE_URL = "";
  let OAUTH_ISSUER = "";
  let AUTH_BASE_PATH = "";
  let origin = "";
  let server: { close: (cb?: () => void) => void } | undefined;

  const suffix = randomUUID().slice(0, 8);
  const userId = `oauth_first_user_${suffix}`;
  const email = `${userId}@test.dev`;
  const password = `pw-${randomUUID()}`;
  const clientIp = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  const redirectUri = `https://chatgpt.com/connector/oauth/cb_${randomUUID().replace(/-/g, "")}`;
  const scope = "openid profile email offline_access anlyon:actions";

  let sessionCookie = "";
  let clientId = "";
  let accessToken = "";

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    "x-forwarded-for": clientIp,
    origin,
    ...extra,
  });
  const call = (path: string, init: RequestInit = {}) => auth.handler(new Request(`${origin}${AUTH_BASE_PATH}${path}`, init));

  async function nextUrl(response: Response, step: string): Promise<URL> {
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) return new URL(location, origin);
    const text = await response.text();
    const url = (() => {
      try {
        return (JSON.parse(text) as { url?: unknown }).url;
      } catch {
        return undefined;
      }
    })();
    if (response.ok && typeof url === "string") return new URL(url, origin);
    throw new Error(`${step}: expected a redirect, got ${response.status} ${text.slice(0, 500)}`);
  }

  async function mcp(method: string, params: Record<string, unknown> = {}) {
    const response = await fetch(MCP_RESOURCE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const raw = await response.text();
    expect(response.status, raw.slice(0, 300)).toBe(200);
    const json = raw.startsWith("{") ? raw : raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return JSON.parse(json as string).result as { content: Array<{ text: string }>; isError?: boolean };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    ({ auth, MCP_RESOURCE_URL, OAUTH_ISSUER, AUTH_BASE_PATH } = await import("../src/utils/auth.ts"));
    origin = new URL(OAUTH_ISSUER).origin;

    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Ada First', $2, true, now(), now())`,
      [userId, email],
    );
    const { hashPassword } = await import("better-auth/crypto");
    await pool.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomUUID(), userId, await hashPassword(password)],
    );
    const signIn = await call(`/sign-in/email`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ email, password }),
    });
    expect(signIn.status, (await signIn.clone().text()).slice(0, 300)).toBe(200);
    sessionCookie = signIn.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");

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
    const owned = await pool.query(`SELECT workspace_id FROM workspace_members WHERE user_id = $1`, [userId]);
    if (clientId) {
      for (const table of ["oauth_access_token", "oauth_refresh_token", "oauth_consent", "oauth_workspace_binding", "oauth_client"]) {
        await pool.query(`DELETE FROM ${table} WHERE client_id = $1`, [clientId]);
      }
    }
    await pool.query(`DELETE FROM session WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM account WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM workspace_members WHERE user_id = $1`, [userId]);
    for (const { workspace_id: id } of owned.rows) {
      await pool.query(`DELETE FROM approvals WHERE workspace_id = $1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [id]).catch(() => {});
    }
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM rate_limit WHERE key LIKE $1`, [`${clientIp}%`]);
    await pool.end();
  });

  it("authorizes ChatGPT and leaves the account with one free workspace", async () => {
    const registered = await call(`/oauth2/register`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        client_name: `ChatGPT ${suffix}`,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    clientId = ((await registered.json()) as { client_id: string }).client_id;
    expect(clientId).toEqual(expect.any(String));

    const verifier = randomBytes(48).toString("base64url");
    const state = randomUUID();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: MCP_RESOURCE_URL,
    });
    let url = await nextUrl(await call(`/oauth2/authorize?${query}`, { method: "GET", headers: headers({ cookie: sessionCookie }) }), "authorize");

    expect(url.pathname, `flow went to ${url.toString()}`).toBe("/oauth/consent");
    const consent = await call(`/oauth2/consent`, {
      method: "POST",
      headers: headers({ cookie: sessionCookie, "content-type": "application/json" }),
      body: JSON.stringify({ accept: true, scope, oauth_query: url.search.replace(/^\?/, "") }),
    });
    url = await nextUrl(consent, "consent");
    expect(`${url.origin}${url.pathname}`).toBe(redirectUri);
    const code = url.searchParams.get("code");
    expect(code, url.searchParams.get("error_description") ?? "no code").toBeTruthy();

    const token = await call(`/oauth2/token`, {
      method: "POST",
      headers: headers({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" }),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: code as string,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: MCP_RESOURCE_URL,
      }).toString(),
    });
    accessToken = ((await token.json()) as { access_token: string }).access_token;
    expect(accessToken.split(".")).toHaveLength(3);

    const workspaces = await pool.query(
      `SELECT w.plan, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1`,
      [userId],
    );
    expect(workspaces.rows).toEqual([{ plan: "free", role: "admin" }]);
  });

  it("works from the first tool call: an approval requested here is readable through the same workspace", async () => {
    expect(accessToken, "the authorization step must have run").toBeTruthy();

    const listed = await mcp("tools/call", { name: "list_actions", arguments: {} });
    expect(listed.isError, listed.content[0].text).toBeFalsy();
    expect(Array.isArray(JSON.parse(listed.content[0].text))).toBe(true);

    const requested = await mcp("tools/call", { name: "request_approval", arguments: { title: "Launch plan" } });
    expect(requested.isError, requested.content[0].text).toBeFalsy();
    const approvalId = JSON.parse(requested.content[0].text).id as string;
    expect(approvalId).toMatch(/^apr_/);

    const checked = await mcp("tools/call", { name: "check_approval", arguments: { approvalId } });
    expect(checked.isError, checked.content[0].text).toBeFalsy();
    expect(JSON.parse(checked.content[0].text)).toMatchObject({ id: approvalId, title: "Launch plan", status: "pending" });

    const row = await pool.query(
      `SELECT a.requested_by_user_id, a.requested_by_oauth_client_id, m.role
         FROM approvals a JOIN workspace_members m ON m.workspace_id = a.workspace_id AND m.user_id = $2
        WHERE a.approval_id = $1`,
      [approvalId, userId],
    );
    expect(row.rows).toEqual([{ requested_by_user_id: userId, requested_by_oauth_client_id: clientId, role: "admin" }]);
  });

  it("creates no workspace when a client asks only for identity", async () => {
    const loner = `oauth_first_identity_${suffix}`;
    const lonerPassword = `pw-${randomUUID()}`;
    let lonerClientId = "";
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Ida Identity', $2, true, now(), now())`,
      [loner, `${loner}@test.dev`],
    );
    const { hashPassword } = await import("better-auth/crypto");
    await pool.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomUUID(), loner, await hashPassword(lonerPassword)],
    );
    try {
      const signIn = await call(`/sign-in/email`, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ email: `${loner}@test.dev`, password: lonerPassword }),
      });
      expect(signIn.status).toBe(200);
      const cookie = signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

      const registered = await call(`/oauth2/register`, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          client_name: `Identity ${suffix}`,
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        }),
      });
      lonerClientId = ((await registered.json()) as { client_id: string }).client_id;

      const verifier = randomBytes(48).toString("base64url");
      const query = new URLSearchParams({
        response_type: "code",
        client_id: lonerClientId,
        redirect_uri: redirectUri,
        scope: "openid profile email",
        state: randomUUID(),
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      });
      const url = await nextUrl(await call(`/oauth2/authorize?${query}`, { method: "GET", headers: headers({ cookie }) }), "authorize");
      expect(url.pathname, `flow went to ${url.toString()}`).toBe("/oauth/consent");
      const rows = await pool.query(`SELECT 1 FROM workspace_members WHERE user_id = $1`, [loner]);
      expect(rows.rowCount).toBe(0);
    } finally {
      if (lonerClientId) await pool.query(`DELETE FROM oauth_client WHERE client_id = $1`, [lonerClientId]);
      await pool.query(`DELETE FROM session WHERE user_id = $1`, [loner]);
      await pool.query(`DELETE FROM account WHERE user_id = $1`, [loner]);
      await pool.query(`DELETE FROM "user" WHERE id = $1`, [loner]);
    }
  });

  it("creates one workspace, not two, when two authorizations race for the same new account", async () => {
    const racer = `oauth_first_racer_${suffix}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Racer', $2, true, now(), now())`,
      [racer, `${racer}@test.dev`],
    );
    try {
      const { ensureFirstWorkspace } = await import("../src/core/workspace/service.ts");
      const outcomes = await Promise.all([ensureFirstWorkspace(racer, "Racer's workspace"), ensureFirstWorkspace(racer, "Racer's workspace")]);
      expect(outcomes.sort()).toEqual([false, true]);
      const rows = await pool.query(`SELECT workspace_id FROM workspace_members WHERE user_id = $1`, [racer]);
      expect(rows.rowCount).toBe(1);
      expect(await ensureFirstWorkspace(racer, "again")).toBe(false);
    } finally {
      const owned = await pool.query(`SELECT workspace_id FROM workspace_members WHERE user_id = $1`, [racer]);
      await pool.query(`DELETE FROM workspace_members WHERE user_id = $1`, [racer]);
      for (const { workspace_id: id } of owned.rows) await pool.query(`DELETE FROM workspaces WHERE id = $1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM "user" WHERE id = $1`, [racer]);
    }
  });
});
