import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { DEFAULT_OAUTH_SCOPES } from "../src/core/auth/oauth-scopes.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";

type AuthModule = typeof import("../src/utils/auth.ts");

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("OAuth resource indicator  token audience (real flow)", () => {
  let pool: Pool;
  let auth: AuthModule["auth"];
  let MCP_RESOURCE_URL: string;
  let OAUTH_ISSUER: string;
  let AUTH_BASE_PATH: string;
  let origin: string;

  const suffix = randomUUID().slice(0, 8);
  const userId = `oauth_aud_user_${suffix}`;
  const email = `${userId}@test.dev`;
  const password = `pw-${randomUUID()}`;
  const clientIp = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  const chatgptRedirectUri = `https://chatgpt.com/connector/oauth/cb_${randomUUID().replace(/-/g, "")}`;
  const requestedScope = "openid profile email offline_access anlyon:actions";

  let workspaceId = "";
  let sessionCookie = "";
  let clientId = "";
  const extraClientIds: string[] = [];

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    "x-forwarded-for": clientIp,
    origin,
    ...extra,
  });

  const call = (path: string, init: RequestInit = {}) =>
    auth.handler(new Request(`${origin}${AUTH_BASE_PATH}${path}`, init));

  async function nextUrl(response: Response, step: string): Promise<URL> {
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) return new URL(location, origin);
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    const url = (body as { url?: unknown } | null)?.url;
    if (response.ok && typeof url === "string") return new URL(url, origin);
    throw new Error(`${step}: expected a redirect, got ${response.status} ${text.slice(0, 500)}`);
  }

  function pkcePair(): { verifier: string; challenge: string } {
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
  }

  async function authorizeToCode(options: { resource?: string; challenge: string }) {
    const state = randomUUID();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: chatgptRedirectUri,
      scope: requestedScope,
      state,
      code_challenge: options.challenge,
      code_challenge_method: "S256",
    });
    if (options.resource) query.set("resource", options.resource);

    let url = await nextUrl(
      await call(`/oauth2/authorize?${query}`, { method: "GET", headers: headers({ cookie: sessionCookie }) }),
      "authorize",
    );

    let sawConsent = false;
    if (url.pathname === "/oauth/consent") {
      sawConsent = true;
      const oauthQuery = url.search.replace(/^\?/, "");
      const consent = await call(`/oauth2/consent`, {
        method: "POST",
        headers: headers({ cookie: sessionCookie, "content-type": "application/json" }),
        body: JSON.stringify({ accept: true, scope: requestedScope, oauth_query: oauthQuery }),
      });
      url = await nextUrl(consent, "consent");
    }

    expect(`${url.origin}${url.pathname}`, `flow ended at ${url.toString()}`).toBe(chatgptRedirectUri);
    expect(url.searchParams.get("error"), url.searchParams.get("error_description") ?? "").toBeNull();
    expect(url.searchParams.get("state")).toBe(state);
    const code = url.searchParams.get("code");
    expect(code, "no authorization code was delivered to the redirect URI").toBeTruthy();
    return { code: code as string, sawConsent };
  }

  async function exchange(options: { code: string; verifier: string; resource?: string }) {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: options.code,
      code_verifier: options.verifier,
      redirect_uri: chatgptRedirectUri,
    });
    if (options.resource) form.set("resource", options.resource);
    const response = await call(`/oauth2/token`, {
      method: "POST",
      headers: headers({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" }),
      body: form.toString(),
    });
    const text = await response.text();
    expect(response.status, `token endpoint: ${text.slice(0, 500)}`).toBe(200);
    const body = JSON.parse(text) as { access_token?: string; token_type?: string; refresh_token?: string };
    expect(typeof body.access_token, "token response carried no access_token").toBe("string");
    return body as { access_token: string; token_type: string; refresh_token?: string };
  }

  async function connect(resource: { authorize?: string; token?: string }) {
    const { verifier, challenge } = pkcePair();
    const { code, sawConsent } = await authorizeToCode({ resource: resource.authorize, challenge });
    const tokens = await exchange({ code, verifier, resource: resource.token });
    return { ...tokens, sawConsent };
  }

  async function jwks() {
    const response = await call(`/jwks`, { method: "GET", headers: headers() });
    expect(response.status).toBe(200);
    return createLocalJWKSet((await response.json()) as JSONWebKeySet);
  }

  const verifyForMcp = async (token: string) =>
    jwtVerify(token, await jwks(), { audience: MCP_RESOURCE_URL, issuer: OAUTH_ISSUER });

  const looksLikeJwt = (token: string) => token.split(".").length === 3;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    ({ auth, MCP_RESOURCE_URL, OAUTH_ISSUER, AUTH_BASE_PATH } = await import("../src/utils/auth.ts"));
    origin = new URL(OAUTH_ISSUER).origin;
    expect(OAUTH_ISSUER).toBe(`${origin}${AUTH_BASE_PATH}`);

    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'Audience Test', $2, true, now(), now())`,
      [userId, email],
    );
    const ws = await pool.query(
      `INSERT INTO workspaces (name, slug, plan) VALUES ('Audience', $1, 'paygo') RETURNING id`,
      [`audience-${suffix}`],
    );
    workspaceId = ws.rows[0].id;
    await pool.query(
      `INSERT INTO environments (id, workspace_id, name, slug, is_default)
       VALUES (gen_random_uuid(), $1, 'Production', 'production', true)`,
      [workspaceId],
    );
    await pool.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at)
       VALUES (gen_random_uuid(), $1, $2, 'admin', now())`,
      [workspaceId, userId],
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
    const signInText = await signIn.text();
    expect(signIn.status, `sign-in failed: ${signInText.slice(0, 500)}`).toBe(200);
    sessionCookie = signIn.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    expect(sessionCookie, "sign-in set no session cookie").toMatch(/session_token=/);
  });

  afterAll(async () => {
    if (!pool) return;
    if (clientId) {
      await pool.query(`DELETE FROM oauth_access_token WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM oauth_refresh_token WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM oauth_consent WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM oauth_workspace_binding WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM oauth_client WHERE client_id = $1`, [clientId]);
    }
    if (extraClientIds.length > 0) await pool.query(`DELETE FROM oauth_client WHERE client_id = ANY($1)`, [extraClientIds]);
    await pool.query(`DELETE FROM session WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM account WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM workspace_members WHERE user_id = $1`, [userId]);
    if (workspaceId) {
      await pool.query(`DELETE FROM environments WHERE workspace_id = $1`, [workspaceId]);
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    }
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM rate_limit WHERE key LIKE $1`, [`${clientIp}%`]);
    await pool.end();
  });

  it("registers a public client at ChatGPT's connector redirect URI", async () => {
    const response = await call(`/oauth2/register`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        client_name: `ChatGPT connector ${suffix}`,
        redirect_uris: [chatgptRedirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    const text = await response.text();
    expect([200, 201], `register: ${text.slice(0, 500)}`).toContain(response.status);

    const body = JSON.parse(text) as {
      client_id?: string;
      client_secret?: string;
      redirect_uris?: string[];
      token_endpoint_auth_method?: string;
    };
    expect(body.client_id).toEqual(expect.any(String));
    clientId = body.client_id as string;
    expect(body.redirect_uris).toEqual([chatgptRedirectUri]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_secret).toBeUndefined();

    const row = await pool.query(
      `SELECT redirect_uris, public, token_endpoint_auth_method, client_secret, scopes FROM oauth_client WHERE client_id = $1`,
      [clientId],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].redirect_uris).toEqual([chatgptRedirectUri]);
    expect(row.rows[0].token_endpoint_auth_method).toBe("none");
    expect(row.rows[0].client_secret).toBeNull();
    expect(row.rows[0].public).toBe(true);
    expect(row.rows[0].scopes).toEqual(DEFAULT_OAUTH_SCOPES);
  });

  async function register(body: Record<string, unknown>) {
    const response = await call(`/oauth2/register`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ client_name: `audience extra ${suffix}`, ...body }),
    });
    const text = await response.text();
    expect(response.status, `register: ${text.slice(0, 500)}`).toBe(201);
    const registered = JSON.parse(text) as { client_id: string; client_secret?: string; token_endpoint_auth_method?: string; scope?: string };
    extraClientIds.push(registered.client_id);
    const row = await pool.query(
      `SELECT token_endpoint_auth_method, application_type, client_secret, public, scopes FROM oauth_client WHERE client_id = $1`,
      [registered.client_id],
    );
    return { registered, row: row.rows[0] };
  }

  it("registers loopback and custom-scheme harnesses that omit the auth method and application type", async () => {
    for (const redirect of ["http://127.0.0.1:33418/oauth/callback", "http://localhost:53682/callback", "cursor://anysphere.cursor-mcp/oauth/callback"]) {
      const { registered, row } = await register({ redirect_uris: [redirect] });
      expect(registered.token_endpoint_auth_method, redirect).toBe("none");
      expect(registered.client_secret, redirect).toBeUndefined();
      expect(row.token_endpoint_auth_method, redirect).toBe("none");
      expect(row.client_secret, redirect).toBeNull();
      expect(row.application_type, redirect).toBe("native");
    }
  });

  it("limits a client to the scopes it registered with", async () => {
    const asked = "openid offline_access anlyon:actions anlyon:approvals.decide";
    const { registered, row } = await register({
      redirect_uris: [`https://chatgpt.com/connector/oauth/cb_scoped_${suffix}`],
      token_endpoint_auth_method: "none",
      scope: asked,
    });
    expect(row.scopes).toEqual(asked.split(" "));
    expect(registered.scope).toBe(asked);
  });

  it("mints a JWT for the MCP audience when resource is sent on authorize and token", async () => {
    expect(clientId, "registration must have succeeded first").toBeTruthy();
    const tokens = await connect({ authorize: MCP_RESOURCE_URL, token: MCP_RESOURCE_URL });

    expect(tokens.sawConsent).toBe(true);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.refresh_token).toEqual(expect.any(String));

    expect(looksLikeJwt(tokens.access_token), "access token is not a JWT").toBe(true);
    const claims: JWTPayload = decodeJwt(tokens.access_token);

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    expect(audiences).toContain(MCP_RESOURCE_URL);
    expect(claims.iss).toBe(OAUTH_ISSUER);
    expect(claims.sub).toBe(userId);
    expect(claims.azp).toBe(clientId);
    expect(String(claims.scope).split(" ")).toEqual(expect.arrayContaining(requestedScope.split(" ")));

    const { payload } = await verifyForMcp(tokens.access_token);
    expect(payload.sub).toBe(userId);
  });

  it("does not mint an MCP-audience JWT when resource is omitted entirely", async () => {
    expect(clientId, "registration must have succeeded first").toBeTruthy();
    const before = await pool.query(`SELECT count(*)::int AS n FROM oauth_access_token WHERE client_id = $1`, [clientId]);

    const tokens = await connect({});

    expect(looksLikeJwt(tokens.access_token), "expected an opaque token, got a JWT").toBe(false);
    expect(() => decodeJwt(tokens.access_token)).toThrow();
    await expect(verifyForMcp(tokens.access_token)).rejects.toThrow();

    const after = await pool.query(`SELECT count(*)::int AS n FROM oauth_access_token WHERE client_id = $1`, [clientId]);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it("mints an MCP-audience JWT when resource is sent on authorize but not on token", async () => {
    expect(clientId, "registration must have succeeded first").toBeTruthy();
    const tokens = await connect({ authorize: MCP_RESOURCE_URL });

    expect(looksLikeJwt(tokens.access_token), "access token is not a JWT").toBe(true);
    const { payload } = await verifyForMcp(tokens.access_token);
    expect(payload.sub).toBe(userId);
  });

  it("mints an MCP-audience JWT when resource is sent on token but not on authorize", async () => {
    const tokens = await connect({ token: MCP_RESOURCE_URL });
    const { payload } = await verifyForMcp(tokens.access_token);
    expect(payload.sub).toBe(userId);
  });

  it("refuses a resource that is not ours", async () => {
    const { verifier, challenge } = pkcePair();
    const { code } = await authorizeToCode({ challenge });
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: chatgptRedirectUri,
      resource: "https://elsewhere.example/mcp",
    });
    const response = await call(`/oauth2/token`, {
      method: "POST",
      headers: headers({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" }),
      body: form.toString(),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error?: string }).error).toBe("invalid_target");
  });

  async function refresh(refreshToken: string, resource?: string) {
    const form = new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    if (resource) form.set("resource", resource);
    const response = await call(`/oauth2/token`, {
      method: "POST",
      headers: headers({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" }),
      body: form.toString(),
    });
    const text = await response.text();
    expect(response.status, `refresh: ${text.slice(0, 500)}`).toBe(200);
    return JSON.parse(text) as { access_token: string; refresh_token?: string };
  }

  it("keeps the MCP audience across a refresh that sends resource again", async () => {
    const first = await connect({ authorize: MCP_RESOURCE_URL, token: MCP_RESOURCE_URL });
    expect(first.refresh_token).toEqual(expect.any(String));

    const renewed = await refresh(first.refresh_token as string, MCP_RESOURCE_URL);

    expect(looksLikeJwt(renewed.access_token), "renewed access token is not a JWT").toBe(true);
    const { payload } = await verifyForMcp(renewed.access_token);
    expect(payload.sub).toBe(userId);
  });

  it("pins what a refresh without resource returns", async () => {
    const first = await connect({ authorize: MCP_RESOURCE_URL, token: MCP_RESOURCE_URL });
    const renewed = await refresh(first.refresh_token as string);

    expect(looksLikeJwt(renewed.access_token), "renewed access token is not a JWT").toBe(true);
    const { payload } = await verifyForMcp(renewed.access_token);
    expect(payload.sub).toBe(userId);
  });
});
