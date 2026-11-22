import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from "jose";

const sentVerificationEmails = vi.hoisted(() => [] as Array<{ email: string; verificationUrl: string }>);
const signUps = vi.hoisted(() => [] as Array<{ userId: string; properties: Record<string, unknown> }>);

vi.mock("../src/lib/emails/send-auth-email.ts", () => ({
  sendVerificationEmail: async (input: { email: string; verificationUrl: string }) => {
    sentVerificationEmails.push({ email: input.email, verificationUrl: input.verificationUrl });
  },
  sendPasswordResetEmail: async () => {},
  sendPasswordChangedEmail: async () => {},
  sendWelcomeEmail: async () => {},
}));

vi.mock("../src/lib/product-events.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/product-events.ts")>()),
  captureUserSignedUp: (userId: string, properties: Record<string, unknown> = {}) => {
    signUps.push({ userId, properties });
  },
}));

type AuthModule = typeof import("../src/utils/auth.ts");

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("Sign in with Anlyon (first-party client)", () => {
  let pool: Pool;
  let auth: AuthModule["auth"];
  let OAUTH_ISSUER = "";
  let AUTH_BASE_PATH = "";
  let MCP_RESOURCE_URL = "";
  let origin = "";
  let server: { close: (cb?: () => void) => void } | undefined;

  const suffix = randomUUID().slice(0, 8);
  const userId = `siwa_user_${suffix}`;
  const email = `${userId}@test.dev`;
  const password = `pw-${randomUUID()}`;
  const clientIp = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  const redirectUri = "https://anlyon.dev/auth/callback";
  const definitionKey = `anlyon.dev-test-${suffix}`;

  let clientId = "";
  let clientSecret = "";
  let sessionCookie = "";
  const signedUpEmail = `siwa_new_${suffix}@test.dev`;

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    "x-forwarded-for": clientIp,
    origin,
    ...extra,
  });
  const call = (path: string, init: RequestInit = {}) => auth.handler(new Request(`${origin}${AUTH_BASE_PATH}${path}`, init));
  const basic = () => `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

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

  function authorizeQuery(scope: string, extra: Record<string, string> = {}) {
    const verifier = randomBytes(48).toString("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state: randomUUID(),
      nonce: randomUUID(),
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      ...extra,
    });
    return { query, verifier };
  }

  async function authorize(scope: string, cookie = sessionCookie, extra: Record<string, string> = {}) {
    const { query, verifier } = authorizeQuery(scope, extra);
    const url = await nextUrl(
      await call(`/oauth2/authorize?${query}`, { method: "GET", headers: headers(cookie ? { cookie } : {}) }),
      "authorize",
    );
    return { url, verifier, nonce: query.get("nonce") as string };
  }

  async function exchange(code: string, verifier: string, extra: Record<string, string> = {}) {
    return call(`/oauth2/token`, {
      method: "POST",
      headers: headers({ "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: basic() }),
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, ...extra }).toString(),
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    ({ auth, OAUTH_ISSUER, AUTH_BASE_PATH, MCP_RESOURCE_URL } = await import("../src/utils/auth.ts"));
    origin = new URL(OAUTH_ISSUER).origin;

    const { anlyonDevDefinition, seedFirstPartyClient } = await import("../src/core/auth/first-party-seed.ts");
    const outcome = await seedFirstPartyClient({ ...anlyonDevDefinition({ staging: false }), key: definitionKey }, { rotate: false });
    expect(outcome.action).toBe("created");
    clientId = outcome.clientId;
    clientSecret = outcome.clientSecret as string;

    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at)
       VALUES ($1, 'Ada Index', $2, true, 'https://example.com/ada.png', now(), now())`,
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
    const people = [userId];
    const created = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [signedUpEmail]);
    for (const row of created.rows) people.push(row.id);
    if (clientId) {
      for (const table of ["oauth_access_token", "oauth_refresh_token", "oauth_consent", "oauth_workspace_binding", "oauth_client"]) {
        await pool.query(`DELETE FROM ${table} WHERE client_id = $1`, [clientId]);
      }
    }
    for (const id of people) {
      const owned = await pool.query(`SELECT workspace_id FROM workspace_members WHERE user_id = $1`, [id]);
      await pool.query(`DELETE FROM session WHERE user_id = $1`, [id]);
      await pool.query(`DELETE FROM account WHERE user_id = $1`, [id]);
      await pool.query(`DELETE FROM workspace_members WHERE user_id = $1`, [id]);
      for (const { workspace_id: ws } of owned.rows) await pool.query(`DELETE FROM workspaces WHERE id = $1`, [ws]).catch(() => {});
      await pool.query(`DELETE FROM "user" WHERE id = $1`, [id]);
    }
    await pool.query(`DELETE FROM verification WHERE identifier LIKE $1`, [`%${suffix}%`]).catch(() => {});
    await pool.query(`DELETE FROM rate_limit WHERE key LIKE $1`, [`${clientIp}%`]);
    await pool.end();
  });

  it("seeds the client as specified: identity scopes set explicitly, PKCE, no consent, no end-session, secret hashed", async () => {
    const { rows } = await pool.query(
      `SELECT scopes, skip_consent, require_pkce, enable_end_session, grant_types, response_types, redirect_uris,
              public, user_id, client_secret
         FROM oauth_client WHERE client_id = $1`,
      [clientId],
    );
    expect(rows[0]).toMatchObject({
      scopes: ["openid", "profile", "email"],
      skip_consent: true,
      require_pkce: true,
      enable_end_session: false,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: [redirectUri],
      public: false,
      user_id: null,
    });
    expect(rows[0].client_secret).not.toBe(clientSecret);
  });

  it("re-seeding keeps the client id and secret, and --staging adds only the localhost redirect", async () => {
    const { anlyonDevDefinition, seedFirstPartyClient } = await import("../src/core/auth/first-party-seed.ts");
    const again = await seedFirstPartyClient({ ...anlyonDevDefinition({ staging: true }), key: definitionKey }, { rotate: false });
    expect(again).toEqual({ action: "updated", clientId });
    const { rows } = await pool.query(`SELECT redirect_uris FROM oauth_client WHERE client_id = $1`, [clientId]);
    expect(rows[0].redirect_uris).toEqual([redirectUri, "http://localhost:3000/auth/callback"]);

    const back = await seedFirstPartyClient({ ...anlyonDevDefinition({ staging: false }), key: definitionKey }, { rotate: false });
    expect(back).toEqual({ action: "updated", clientId });
    const after = await pool.query(`SELECT redirect_uris FROM oauth_client WHERE client_id = $1`, [clientId]);
    expect(after.rows[0].redirect_uris).toEqual([redirectUri]);
  });

  it("signs a person in with no consent screen and no workspace, and returns an EdDSA ID token with the identity claims", async () => {
    const { url, verifier, nonce } = await authorize("openid profile email");
    expect(`${url.origin}${url.pathname}`, `flow went to ${url.toString()}`).toBe(redirectUri);
    const code = url.searchParams.get("code");
    expect(code, url.searchParams.get("error_description") ?? "no code").toBeTruthy();

    const token = await exchange(code as string, verifier);
    const body = (await token.json()) as { id_token?: string; access_token?: string; refresh_token?: string };
    expect(token.status, JSON.stringify(body)).toBe(200);
    expect(body.refresh_token).toBeUndefined();

    const jwks = (await (await call(`/jwks`, { method: "GET", headers: headers() })).json()) as JSONWebKeySet;
    expect(decodeProtectedHeader(body.id_token as string).alg).toBe("EdDSA");
    const { payload } = await jwtVerify(body.id_token as string, createLocalJWKSet(jwks), { issuer: OAUTH_ISSUER, audience: clientId });
    expect(payload).toMatchObject({ sub: userId, nonce, email, email_verified: true, name: "Ada Index", picture: "https://example.com/ada.png" });

    const userinfo = await call(`/oauth2/userinfo`, { method: "GET", headers: headers({ authorization: `Bearer ${body.access_token}` }) });
    expect(userinfo.status).toBe(200);
    expect(await userinfo.json()).toMatchObject({ sub: userId, email });

    const workspaces = await pool.query(`SELECT 1 FROM workspace_members WHERE user_id = $1`, [userId]);
    expect(workspaces.rowCount, "an identity-only sign-in must not create a workspace").toBe(0);
    const consents = await pool.query(`SELECT 1 FROM oauth_consent WHERE client_id = $1`, [clientId]);
    expect(consents.rowCount).toBe(0);
  });

  it("refuses an anlyon:* scope with invalid_scope", async () => {
    const { url } = await authorize("openid anlyon:actions");
    expect(`${url.origin}${url.pathname}`).toBe(redirectUri);
    expect(url.searchParams.get("error")).toBe("invalid_scope");
    expect(url.searchParams.get("code")).toBeNull();
  });

  it("gives nothing that opens /mcp, even when the token is requested for the MCP resource", async () => {
    const { url, verifier } = await authorize("openid profile email");
    const code = url.searchParams.get("code") as string;
    const token = await exchange(code, verifier, { resource: MCP_RESOURCE_URL });
    const { access_token: accessToken } = (await token.json()) as { access_token: string };

    const response = await fetch(MCP_RESOURCE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("is never swept by the client reaper", async () => {
    await pool.query(`UPDATE oauth_client SET created_at = now() - interval '30 days' WHERE client_id = $1`, [clientId]);
    const { sweepAbandonedOAuthClients } = await import("../src/core/auth/oauth-client-maintenance.ts");
    await sweepAbandonedOAuthClients();
    const { rowCount } = await pool.query(`SELECT 1 FROM oauth_client WHERE client_id = $1`, [clientId]);
    expect(rowCount).toBe(1);
  });

  it("names itself to the login page before sign-in, and nobody else's client", async () => {
    const response = await fetch(`${origin}/api/oauth/first-party-client?client_id=${encodeURIComponent(clientId)}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown }).data).toEqual({ displayName: "anlyon.dev", startUrl: "https://anlyon.dev/auth/login" });

    const unknown = await fetch(`${origin}/api/oauth/first-party-client?client_id=not-a-client`);
    expect(unknown.status).toBe(404);
  });

  it("a sign-up inside its authorize request is counted as from anlyon.dev, and the verification link leads back", async () => {
    const { url: login } = await authorize("openid profile email", "");
    expect(login.pathname).toBe("/auth/login");
    const signedQuery = login.search.replace(/^\?/, "");
    expect(new URLSearchParams(signedQuery).get("sig")).toBeTruthy();

    const signUp = await call(`/sign-up/email`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        email: signedUpEmail,
        password: `Pw-${randomUUID()}`,
        name: "New Person",
        callbackURL: `/auth/login?${signedQuery}`,
        oauth_query: signedQuery,
      }),
    });
    expect(signUp.status, (await signUp.clone().text()).slice(0, 300)).toBe(200);

    const { rows } = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [signedUpEmail]);
    expect(signUps.find((event) => event.userId === rows[0].id)?.properties).toEqual({ method: "email", source: definitionKey });

    const sent = sentVerificationEmails.find((message) => message.email === signedUpEmail);
    expect(sent, "a verification email").toBeDefined();
    const link = new URL(sent?.verificationUrl as string);
    expect(link.pathname).toBe("/auth/verify-email");
    expect(link.searchParams.get("token")).toBeTruthy();
    const carried = new URLSearchParams(link.searchParams.get("oauth_query") ?? "");
    expect(carried.get("client_id")).toBe(clientId);
    expect(carried.get("sig")).toBe(new URLSearchParams(signedQuery).get("sig"));
  });

  it("an ordinary sign-up carries no source and no return path", async () => {
    const plain = `siwa_plain_${suffix}@test.dev`;
    try {
      const signUp = await call(`/sign-up/email`, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ email: plain, password: `Pw-${randomUUID()}`, name: "Plain Person" }),
      });
      expect(signUp.status, (await signUp.clone().text()).slice(0, 300)).toBe(200);
      const { rows } = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [plain]);
      expect(signUps.find((event) => event.userId === rows[0].id)?.properties).toEqual({ method: "email" });
      const sent = sentVerificationEmails.find((message) => message.email === plain);
      expect(new URL(sent?.verificationUrl as string).searchParams.has("oauth_query")).toBe(false);
    } finally {
      const { rows } = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [plain]);
      for (const row of rows) {
        await pool.query(`DELETE FROM account WHERE user_id = $1`, [row.id]);
        await pool.query(`DELETE FROM "user" WHERE id = $1`, [row.id]);
      }
    }
  });

  it("--rotate issues a new secret and the old one stops working", async () => {
    const { anlyonDevDefinition, seedFirstPartyClient } = await import("../src/core/auth/first-party-seed.ts");
    const rotated = await seedFirstPartyClient({ ...anlyonDevDefinition({ staging: false }), key: definitionKey }, { rotate: true });
    expect(rotated.action).toBe("rotated");
    expect(rotated.clientId).toBe(clientId);
    expect(rotated.clientSecret).not.toBe(clientSecret);

    const { url, verifier } = await authorize("openid profile email");
    const stale = await exchange(url.searchParams.get("code") as string, verifier);
    expect(stale.status).toBe(401);

    clientSecret = rotated.clientSecret as string;
    const { url: next, verifier: nextVerifier } = await authorize("openid profile email");
    const fresh = await exchange(next.searchParams.get("code") as string, nextVerifier);
    expect(fresh.status).toBe(200);
  });
});
