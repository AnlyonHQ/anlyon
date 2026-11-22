import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";

type AuthModule = typeof import("../src/utils/auth.ts");

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("OAuth client privileges", () => {
  let pool: Pool;
  let auth: AuthModule["auth"];
  let OAUTH_ISSUER = "";
  let AUTH_BASE_PATH = "";
  let MCP_RESOURCE_URL = "";
  let origin = "";
  let server: { close: (cb?: () => void) => void } | undefined;

  const suffix = randomUUID().slice(0, 8);
  const userId = `privileges_user_${suffix}`;
  const email = `${userId}@test.dev`;
  const password = `pw-${randomUUID()}`;
  const clientIp = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  const created: string[] = [];
  let sessionCookie = "";

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    "x-forwarded-for": clientIp,
    origin,
    "content-type": "application/json",
    ...extra,
  });
  const call = (path: string, init: RequestInit = {}) => auth.handler(new Request(`${origin}${AUTH_BASE_PATH}${path}`, init));
  const post = (path: string, body: unknown, cookie = sessionCookie) =>
    call(path, { method: "POST", headers: headers(cookie ? { cookie } : {}), body: JSON.stringify(body) });

  const confidential = {
    client_name: `Privileges ${suffix}`,
    redirect_uris: ["https://example.com/cb"],
    token_endpoint_auth_method: "client_secret_basic",
    grant_types: ["client_credentials"],
    response_types: ["code"],
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    ({ auth, OAUTH_ISSUER, AUTH_BASE_PATH, MCP_RESOURCE_URL } = await import("../src/utils/auth.ts"));
    origin = new URL(OAUTH_ISSUER).origin;

    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Priv', $2, true, now(), now())`,
      [userId, email],
    );
    const { hashPassword } = await import("better-auth/crypto");
    await pool.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomUUID(), userId, await hashPassword(password)],
    );
    const signIn = await post(`/sign-in/email`, { email, password }, "");
    expect(signIn.status).toBe(200);
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
    await pool.query(`DELETE FROM oauth_client WHERE client_id = ANY($1) OR user_id = $2`, [created, userId]);
    await pool.query(`DELETE FROM session WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM account WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM rate_limit WHERE key LIKE $1`, [`${clientIp}%`]);
    await pool.end();
  });

  it("refuses /oauth2/create-client to a signed-in person", async () => {
    const response = await post(`/oauth2/create-client`, confidential);
    expect(response.status).toBe(401);
    const rows = await pool.query(`SELECT 1 FROM oauth_client WHERE user_id = $1`, [userId]);
    expect(rows.rowCount).toBe(0);
  });

  it("refuses /oauth2/register when it carries a session", async () => {
    const response = await post(`/oauth2/register`, confidential);
    expect(response.status).toBe(401);
  });

  it("leaves unauthenticated registration exactly as it was (the agent-harness path)", async () => {
    const response = await post(
      `/oauth2/register`,
      {
        client_name: `Harness ${suffix}`,
        redirect_uris: ["http://127.0.0.1:33418/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      "",
    );
    expect(response.ok, String(response.status)).toBe(true);
    const body = (await response.json()) as { client_id: string; client_secret?: string };
    created.push(body.client_id);
    expect(body.client_secret).toBeUndefined();

    const refused = await post(`/oauth2/register`, confidential, "");
    expect(refused.status).toBe(400);
  });

  it("refuses update, rotate and delete of a client to a signed-in person, even its owner", async () => {
    const clientId = `privileges_${randomUUID().slice(0, 12)}`;
    created.push(clientId);
    await pool.query(
      `INSERT INTO oauth_client (id, client_id, name, redirect_uris, public, user_id, created_at, updated_at)
       VALUES ($1, $2, 'Owned', ARRAY['https://example.com/cb'], false, $3, now(), now())`,
      [randomUUID(), clientId, userId],
    );
    expect((await post(`/oauth2/update-client`, { client_id: clientId, update: { client_name: "Renamed" } })).status).toBe(401);
    expect((await post(`/oauth2/client/rotate-secret`, { client_id: clientId })).status).toBe(401);
    expect((await post(`/oauth2/delete-client`, { client_id: clientId })).status).toBe(401);
    const { rows } = await pool.query(`SELECT name FROM oauth_client WHERE client_id = $1`, [clientId]);
    expect(rows).toEqual([{ name: "Owned" }]);
  });

  it("refuses the OAuth resource admin endpoints to a signed-in person", async () => {
    const identifier = `https://elsewhere.example/${suffix}`;
    const response = await post(`/admin/oauth2/resources`, { identifier, name: "Elsewhere" });
    expect(response.ok, String(response.status)).toBe(false);
    const { auth: server } = await import("../src/utils/auth.ts");
    const api = server.api as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    await expect(
      api.adminCreateOAuthResource({ headers: new Headers({ cookie: sessionCookie }), body: { identifier, name: "Elsewhere" } }),
    ).rejects.toThrow();
    const { rows } = await pool.query(`SELECT 1 FROM oauth_resource WHERE identifier = $1`, [identifier]);
    expect(rows).toEqual([]);
  });

  it("a client_credentials token, had one been created, has no subject and opens nothing on /mcp", async () => {
    const clientId = `privileges_cc_${randomUUID().slice(0, 12)}`;
    const secret = randomBytes(24).toString("base64url");
    created.push(clientId);
    await pool.query(
      `INSERT INTO oauth_client (id, client_id, client_secret, name, redirect_uris, public, user_id, grant_types,
                                 response_types, token_endpoint_auth_method, scopes, client_credentials_scopes,
                                 created_at, updated_at)
       VALUES ($1, $2, $3, 'Machine', ARRAY['https://example.com/cb'], false, $4, ARRAY['client_credentials'],
               ARRAY['code'], 'client_secret_basic', ARRAY['anlyon:actions'], ARRAY['anlyon:actions'], now(), now())`,
      [randomUUID(), clientId, createHash("sha256").update(secret).digest("base64url"), userId],
    );
    const token = await call(`/oauth2/token`, {
      method: "POST",
      headers: {
        "x-forwarded-for": clientIp,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "anlyon:actions", resource: MCP_RESOURCE_URL }).toString(),
    });
    const body = (await token.json()) as { access_token?: string };
    expect(token.status, JSON.stringify(body)).toBe(200);
    const [, payload] = (body.access_token as string).split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub?: string; azp?: string };
    expect(claims.sub === undefined || claims.sub === claims.azp, JSON.stringify(claims)).toBe(true);

    const mcp = await fetch(MCP_RESOURCE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${body.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(mcp.status).toBe(401);
  });
});
