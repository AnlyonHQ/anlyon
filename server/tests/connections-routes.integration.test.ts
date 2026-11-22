import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

process.env.CONNECTIONS_ALLOW_UNVERIFIED = "true";

vi.mock("@anlyon/feature-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anlyon/feature-flags")>();
  return { ...actual, isFeatureEnabled: (key: string) => key === "connected-accounts" || actual.isFeatureEnabled(key as never) };
});

const { OAuthProviderSimulator, OAUTH_SIM_CLIENT, OAUTH_SIM_ENCRYPTION_KEY, OAUTH_SIM_ORIGIN } = await import("./support/effects/oauth-simulator.ts");
const { createNativeProvider } = await import("../src/core/connections/native.ts");
const { setConnectionProviderForTests } = await import("../src/core/connections/provider.ts");
const { keyCheck } = await import("../src/core/connections/service.ts");
const { probeRejectedCredentials, sweepConnectionHealth } = await import("../src/core/connections/health.ts");
const { findIntegration } = await import("../src/core/connections/catalogue.ts");
const { encryptSecret } = await import("../src/utils/crypto.ts");
const { env } = await import("../src/config/env.ts");

const hubspot = findIntegration("hubspot")!;
const hubspotStatus = hubspot.verificationStatus;

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("connect flow (real stack, HTTP)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let redis: typeof import("../src/lib/redis.ts")["redis"];
  let provider: InstanceType<typeof OAuthProviderSimulator>;
  let userId: string;
  let workspaceId: string;
  let production: { id: string };
  let staging: { id: string };
  let prodKey: string;
  let stagingKey: string;

  const install = (clientFor: () => typeof OAUTH_SIM_CLIENT | null = () => OAUTH_SIM_CLIENT) =>
    setConnectionProviderForTests(createNativeProvider({
      origin: OAUTH_SIM_ORIGIN, encryptionKey: OAUTH_SIM_ENCRYPTION_KEY, fetch: provider.fetch, clientFor,
    }));

  beforeAll(async () => {
    (hubspot as { verificationStatus: string }).verificationStatus = "pending";
    app = (await import("../src/api/index.ts")).default as typeof app;
    redis = (await import("../src/lib/redis.ts")).redis;
    const keys = await import("../src/core/auth/api-keys.ts");
    const envs = await import("../src/core/environments/service.ts");
    userId = `user_${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'T', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`]);
    workspaceId = (await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('C', $1, 'enterprise') RETURNING id`,
      [`ws-${randomUUID().slice(0, 8)}`])).rows[0].id;
    production = await envs.ensureDefaultEnvironment(workspaceId);
    staging = await envs.createEnvironment(workspaceId, { name: "Staging", slug: `staging-${randomUUID().slice(0, 8)}` });
    prodKey = (await keys.createApiKey(workspaceId, userId, "prod", undefined, ["secrets:read", "secrets:write"], production.id)).key;
    stagingKey = (await keys.createApiKey(workspaceId, userId, "staging", undefined, ["secrets:read", "secrets:write"], staging.id)).key;
  }, 60_000);

  beforeEach(async () => {
    provider = new OAuthProviderSimulator();
    install();
    await pool.query("DELETE FROM workspace_secrets WHERE workspace_id = $1", [workspaceId]);
    await pool.query("DELETE FROM oauth_connections WHERE workspace_id = $1", [workspaceId]);
    for (const key of await redis.keys(`ratelimit:connect-sessions:${workspaceId}:*`)) await redis.del(key);
  });
  afterEach(() => setConnectionProviderForTests(undefined));
  afterAll(async () => {
    (hubspot as { verificationStatus: string }).verificationStatus = hubspotStatus;
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await pool.end();
  });

  const call = (key: string, path: string, init: { method?: string; body?: unknown } = {}) => app.request(path, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  type Session = { sessionId: string; sessionToken: string; connectUrl: string; expiresAt: string };

  async function start(key = prodKey, secretName = "HUBSPOT") {
    const res = await call(key, "/api/v2/connections/sessions", { method: "POST", body: { integrationId: "hubspot", secretName, description: "CRM" } });
    expect(res.status).toBe(201);
    return (await res.json()).data as Session;
  }

  const complete = (sessionId: string, reference?: string, key = prodKey) =>
    call(key, `/api/v2/connections/sessions/${sessionId}/complete`, { method: "POST", body: reference ? { reference } : {} });

  const browse = (url: string) => app.request(url, { method: "GET" });

  async function open(session: Session): Promise<string> {
    const res = await browse(session.connectUrl);
    expect(res.status).toBe(302);
    return res.headers.get("location")!;
  }

  async function consent(session: Session, decision: "approve" | "deny" = "approve") {
    const authorizeUrl = await open(session);
    const back = decision === "approve" ? provider.approve(authorizeUrl) : provider.deny(authorizeUrl);
    const res = await browse(back);
    return { res, page: await res.text(), back };
  }

  const connectionRows = async () =>
    (await pool.query("SELECT id, integration_key, access_token_encrypted, refresh_token_encrypted, revoked_at FROM oauth_connections WHERE workspace_id = $1", [workspaceId])).rows;

  describe("the best way to act in an app", () => {
    const find = async (name: string) => (await call(prodKey, `/api/v2/connections/integrations/find?name=${encodeURIComponent(name)}`)).json();

    it("answers for a catalogue integration, a vendor's server and an unknown name, and writes nothing", async () => {
      const before = (await connectionRows()).length;
      expect((await find("stripe")).data.route).toMatchObject({ kind: "integration", integration: { id: "stripe" }, next: { command: "anlyon connections add stripe" } });
      const figma = (await find("figma")).data;
      expect(figma.route).toMatchObject({ kind: "openapi" });
      expect(figma.alternatives).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "mcp_address" })]));
      expect(JSON.stringify(figma)).not.toContain("mcp.figma.com");
      expect((await find("acme crm")).data.route).toMatchObject({ kind: "openapi" });
      expect((await connectionRows()).length).toBe(before);
      expect((await pool.query("SELECT id FROM mcp_upstreams WHERE workspace_id = $1", [workspaceId])).rows).toEqual([]);
    });

    it("needs a name", async () => {
      expect((await call(prodKey, "/api/v2/connections/integrations/find")).status).toBe(400);
      expect((await call(prodKey, "/api/v2/connections/integrations/find?name=%20")).status).toBe(400);
    });

    it("refuses an unknown integration with a fix that points at the route", async () => {
      const res = await call(prodKey, "/api/v2/connections/keys", { method: "POST", body: { integrationId: "acme", secretName: "ACME", apiKey: "fixture-not-a-key-0000" } });
      expect(res.status).toBe(400);
      const { error } = await res.json();
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.fix).toMatchObject({ url: expect.stringContaining("/actions?import=openapi&vendor=acme") });
      expect(error.fix.command).toBeUndefined();
    });
  });

  it("lists a sign-in integration, marking it as needing the environment's own app where its OAuth app is not configured, without provider identifiers", async () => {
    const res = await call(prodKey, "/api/v2/connections/integrations");
    expect(res.status).toBe(200);
    const data = (await res.json()).data as Array<Record<string, unknown>>;
    const hubspot = data.find((i) => i.id === "hubspot");
    expect(hubspot).toMatchObject({ name: "HubSpot", hosts: ["api.hubapi.com"], hostsFromAccount: false, auth: { kind: "oauth" } });
    expect(hubspot).not.toHaveProperty("ownOAuthAppRequired");
    expect(JSON.stringify(data)).not.toMatch(/sim-client|client_secret|oauth_connections/i);

    install(() => null);
    const without = (await (await call(prodKey, "/api/v2/connections/integrations")).json()).data as Array<{ id: string }>;
    expect(without.find((i) => i.id === "hubspot")).toMatchObject({ auth: { kind: "oauth" }, ownOAuthAppRequired: true });
    const refused = await call(prodKey, "/api/v2/connections/sessions", { method: "POST", body: { integrationId: "hubspot", secretName: "X" } });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatchObject({ code: "OWN_OAUTH_APP_REQUIRED" });
  });

  it("runs the round trip through the provider and binds the secret to the integration's hosts", async () => {
    const session = await start();
    expect(session.sessionId).toMatch(/^csn_/);
    expect(session.sessionToken).toMatch(/^cst_/);
    expect(session.connectUrl).toBe(`${OAUTH_SIM_ORIGIN}/api/v2/connection-consent/start?token=${session.sessionToken}`);
    expect(session).not.toHaveProperty("consent");

    const authorize = new URL(await open(session));
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://app.hubspot.com/oauth/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: OAUTH_SIM_CLIENT.clientId,
      redirect_uri: `${OAUTH_SIM_ORIGIN}/api/v2/connection-consent/callback`,
      response_type: "code",
      scope: ["oauth", ...hubspot.scopes].join(" "),
    });
    expect(authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(authorize.searchParams.has("code_challenge")).toBe(false);

    expect((await (await complete(session.sessionId)).json()).data).toEqual({ status: "pending", secret: null });

    const callback = await browse(provider.approve(authorize.toString()));
    expect(callback.status).toBe(200);
    expect(callback.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(callback.headers.get("cache-control")).toBe("no-store");
    const page = await callback.text();
    expect(page).toContain("HubSpot is connected");
    expect(page).not.toMatch(/<script|sim_access|sim_refresh|sim_code/);

    const exchange = provider.requests.filter((r) => r.url === "https://api.hubapi.com/oauth/v3/token");
    expect(exchange).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(exchange[0].body))).toMatchObject({
      grant_type: "authorization_code", client_id: OAUTH_SIM_CLIENT.clientId, redirect_uri: `${OAUTH_SIM_ORIGIN}/api/v2/connection-consent/callback`,
    });

    const res = await complete(session.sessionId);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      status: "completed",
      secret: { name: "HUBSPOT", kind: "connection", allowedHosts: ["api.hubapi.com"], allowedPlacements: ["header"], description: "CRM", connection: { integrationId: "hubspot", status: "active" } },
    });
    const [row] = await connectionRows();
    expect(row).toMatchObject({ integration_key: "hubspot", revoked_at: null });
    expect(JSON.stringify(data)).not.toContain(row.id);
    const grant = provider.latest();
    expect(row.access_token_encrypted).not.toContain(grant.accessToken);
    expect(row.refresh_token_encrypted).not.toContain(grant.refreshToken);

    const again = await (await complete(session.sessionId)).json();
    expect(again.data.secret.id).toBe(data.secret.id);
    const list = await (await call(prodKey, "/api/v2/connections")).json();
    expect(list.data.map((s: { name: string }) => s.name)).toEqual(["HUBSPOT"]);
  });

  it("a replayed or forged redirect is refused and writes nothing new", async () => {
    const session = await start();
    const { res, back } = await consent(session);
    expect(res.status).toBe(200);
    const replay = await browse(back);
    expect(replay.status).toBe(410);
    const forged = new URL(back);
    forged.searchParams.set("state", "x".repeat(43));
    expect((await browse(forged.toString())).status).toBe(410);
    expect((await browse(`${OAUTH_SIM_ORIGIN}/api/v2/connection-consent/callback?code=abc`)).status).toBe(410);
    expect(await connectionRows()).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_secrets WHERE workspace_id = $1", [workspaceId])).rows[0].n).toBe(1);
  });

  it("a consent link can no longer be opened once its consent finished, or for a token Anlyon never issued", async () => {
    const session = await start();
    await consent(session);
    const reopened = await browse(session.connectUrl);
    expect(reopened.status).toBe(410);
    expect(await reopened.text()).toContain("This sign-in link has expired");
    expect((await browse(`${OAUTH_SIM_ORIGIN}/api/v2/connection-consent/start?token=cst_${"a".repeat(43)}`)).status).toBe(410);
    expect((await browse(`${OAUTH_SIM_ORIGIN}/api/v2/connection-consent/start`)).status).toBe(410);
  });

  it("a consent whose session expired is revoked, and the session cannot be completed", async () => {
    const session = await start();
    const authorizeUrl = await open(session);
    await redis.del(`connections:session:${session.sessionId}`);
    const callback = await browse(provider.approve(authorizeUrl));
    expect(callback.status).toBe(400);
    expect(await connectionRows()).toHaveLength(0);
    expect(provider.revocations).toBe(1);
    const res = await complete(session.sessionId);
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe("CONNECTION_SESSION_EXPIRED");
  });

  it("a session from one environment cannot complete into another", async () => {
    const session = await start(prodKey);
    await consent(session);
    const res = await complete(session.sessionId, undefined, stagingKey);
    expect(res.status).toBe(410);
    expect((await pool.query("SELECT 1 FROM workspace_secrets WHERE workspace_id = $1 AND environment_id = $2", [workspaceId, staging.id])).rowCount).toBe(0);
  });

  it("a reference other than the connection the callback recorded is refused", async () => {
    const mine = await start(prodKey, "MINE");
    const theirs = await start(prodKey, "THEIRS");
    await consent(theirs);
    const [their] = await connectionRows();
    const res = await complete(mine.sessionId, their.id);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/not connected through this session/);
    expect((await (await complete(mine.sessionId)).json()).data).toEqual({ status: "pending", secret: null });
  });

  it("a consent the person declines connects nothing, and complete says so", async () => {
    const session = await start();
    const { res, page } = await consent(session, "deny");
    expect(res.status).toBe(200);
    expect(page).toContain("Access was not approved");
    const done = await complete(session.sessionId);
    expect(done.status).toBe(400);
    expect((await done.json()).error.message).toMatch(/access was not approved at the provider/);
    expect(await connectionRows()).toHaveLength(0);
    expect(provider.requests.filter((r) => r.url.endsWith("/oauth/v3/token"))).toHaveLength(0);
  });

  it("a failed code exchange connects nothing and never leaks the client secret or the provider's body", async () => {
    const session = await start();
    provider.fault("token", "http_500");
    const { res, page } = await consent(session);
    expect(res.status).toBe(502);
    expect(page).not.toMatch(/boom|sim_client_secret/);
    const done = await complete(session.sessionId);
    expect(done.status).toBe(400);
    const text = await done.text();
    expect(text).toMatch(/the provider did not complete the sign-in/);
    expect(text).not.toContain(OAUTH_SIM_CLIENT.clientSecret);
    expect(await connectionRows()).toHaveLength(0);
  });

  it("a consent whose secret name was taken meanwhile is refused, and its token dropped", async () => {
    const session = await start();
    const authorizeUrl = await open(session);
    await call(prodKey, "/api/v2/secrets/HUBSPOT", { method: "PUT", body: { value: "value-1234", allowedHosts: ["api.example.com"] } });
    const callback = await browse(provider.approve(authorizeUrl));
    expect(callback.status).toBe(400);
    const done = await complete(session.sessionId);
    expect(done.status).toBe(400);
    expect((await done.json()).error.message).toMatch(/created by something else while this account was being connected/);
    expect(await connectionRows()).toHaveLength(0);
  });

  it("deleting the secret revokes the grant at the provider and drops the token; PUT cannot overwrite it", async () => {
    const session = await start();
    await consent(session);
    await complete(session.sessionId);
    const put = await call(prodKey, "/api/v2/secrets/HUBSPOT", { method: "PUT", body: { value: "x".repeat(10) } });
    expect(put.status).toBe(409);
    expect((await put.json()).error.code).toBe("SECRET_KIND_MISMATCH");
    const del = await call(prodKey, "/api/v2/secrets/HUBSPOT?confirmProtected=true", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await connectionRows()).toHaveLength(0);
    expect(provider.latest().revoked).toBe(true);
    const revoke = provider.requests.find((r) => r.url === "https://api.hubapi.com/oauth/2026-03/token/revoke")!;
    expect(Object.fromEntries(new URLSearchParams(revoke.body))).toMatchObject({ token: provider.latest().refreshToken, token_type_hint: "refresh_token", client_id: OAUTH_SIM_CLIENT.clientId });
  });

  it("refuses a name that already exists, and an unknown integration", async () => {
    await call(prodKey, "/api/v2/secrets/TAKEN", { method: "PUT", body: { value: "value-1234", allowedHosts: ["api.example.com"] } });
    const taken = await call(prodKey, "/api/v2/connections/sessions", { method: "POST", body: { integrationId: "hubspot", secretName: "TAKEN" } });
    expect(taken.status).toBe(409);
    const unknown = await call(prodKey, "/api/v2/connections/sessions", { method: "POST", body: { integrationId: "nope", secretName: "X" } });
    expect(unknown.status).toBe(400);
  });

  it("limits session creation to ten per minute per workspace", async () => {
    for (let i = 0; i < 10; i++) await start(prodKey, `S${i}`);
    const res = await call(prodKey, "/api/v2/connections/sessions", { method: "POST", body: { integrationId: "hubspot", secretName: "S10" } });
    expect(res.status).toBe(429);
  });

  it("answers 501 CONNECTIONS_UNAVAILABLE where no connector is configured", async () => {
    setConnectionProviderForTests(null);
    const res = await call(prodKey, "/api/v2/connections/sessions", { method: "POST", body: { integrationId: "hubspot", secretName: "X" } });
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe("CONNECTIONS_UNAVAILABLE");
    const completed = await complete("csn_abcdefgh12345678");
    expect(completed.status).toBe(501);
    expect((await browse(`${OAUTH_SIM_ORIGIN}/api/v2/connection-consent/start?token=cst_${"a".repeat(43)}`)).status).toBe(501);
    expect((await call(prodKey, "/api/v2/connections/integrations")).status).toBe(200);
    expect((await call(prodKey, "/api/v2/connections")).status).toBe(200);
  });

  describe("API-key integrations", () => {
    const KEY = "fixture-github-token-not-a-key-0000";
    let checks: Array<{ url: string; headers: Record<string, string> }>;
    let answer: () => Promise<Response>;
    let original: typeof keyCheck.fetch;

    beforeEach(() => {
      checks = [];
      answer = async () => new Response("{}", { status: 200 });
      original = keyCheck.fetch;
      keyCheck.fetch = async (url, init) => {
        checks.push({ url, headers: init.headers });
        return answer();
      };
    });
    afterEach(() => { keyCheck.fetch = original; });

    const connect = (body: Record<string, unknown>, key = prodKey) => call(key, "/api/v2/connections/keys", { method: "POST", body });
    const stored = async () => (await pool.query("SELECT count(*)::int AS n FROM workspace_secrets WHERE workspace_id = $1", [workspaceId])).rows[0].n;

    it("lists how each integration is connected, and gives a key integration's instructions only", async () => {
      const data = (await (await call(prodKey, "/api/v2/connections/integrations")).json()).data as Array<{ id: string; auth: Record<string, unknown> }>;
      expect(data.find((i) => i.id === "hubspot")!.auth).toEqual({ kind: "oauth" });
      const stripe = data.find((i) => i.id === "stripe")!;
      expect(Object.keys(stripe.auth).sort()).toEqual(["instructions", "instructionsUrl", "kind"]);
      expect(stripe.auth.kind).toBe("api_key");
      const github = data.find((i) => i.id === "github")!;
      expect(github.auth.kind).toBe("oauth");
      expect(Object.keys(github.auth.apiKey as object).sort()).toEqual(["instructions", "instructionsUrl"]);
      const { isFeatureEnabled } = await import("@anlyon/feature-flags");
      expect(data.some((i) => i.id === "gmail")).toBe(isFeatureEnabled("google-integrations"));
      expect(data.find((i) => i.id === "salesforce")).toBeUndefined();
    });

    it("checks the key with the provider, then stores it bound to the integration's hosts in a header", async () => {
      setConnectionProviderForTests(null);
      const res = await connect({ integrationId: "github", secretName: "GITHUB", apiKey: KEY, description: "Issues bot" });
      expect(res.status).toBe(201);
      const text = await res.text();
      expect(text).not.toContain(KEY);
      expect(JSON.parse(text).data).toMatchObject({
        name: "GITHUB", kind: "static", connection: null, integrationId: "github",
        allowedHosts: ["api.github.com"], allowedPlacements: ["header"], description: "Issues bot",
      });
      expect(checks).toHaveLength(1);
      expect(checks[0].url).toBe("https://api.github.com/user");
      expect(checks[0].headers.Authorization).toBe(`Bearer ${KEY}`);

      const listed = (await (await call(prodKey, "/api/v2/connections")).json()).data as Array<{ name: string }>;
      expect(listed.map((secret) => secret.name)).toEqual(["GITHUB"]);
      const row = (await pool.query("SELECT value_encrypted, integration_id, kind FROM workspace_secrets WHERE workspace_id = $1 AND name = 'GITHUB'", [workspaceId])).rows[0];
      expect(row).toMatchObject({ integration_id: "github", kind: "static" });
      expect(row.value_encrypted).not.toContain(KEY);
    });

    it("sends each integration's key in that integration's own header and prefix", async () => {
      await connect({ integrationId: "pagerduty", secretName: "PAGERDUTY", apiKey: "u+fixture-pagerduty-not-a-key" });
      expect(checks[0].url).toBe("https://api.pagerduty.com/abilities");
      expect(checks[0].headers.Authorization).toBe("Token token=u+fixture-pagerduty-not-a-key");
      await connect({ integrationId: "discord", secretName: "DISCORD", apiKey: "fixture-discord-bot-not-a-key" });
      expect(checks[1].url).toBe("https://discord.com/api/v10/users/@me");
      expect(checks[1].headers.Authorization).toBe("Bot fixture-discord-bot-not-a-key");
      checks.length = 1;
      await connect({ integrationId: "notion", secretName: "NOTION", apiKey: "fixture-notion-token-not-a-key" });
      expect(checks[1].headers).toMatchObject({ Authorization: "Bearer fixture-notion-token-not-a-key", "Notion-Version": "2022-06-28" });
    });

    it("refuses a key the provider rejects, and stores nothing", async () => {
      for (const status of [401, 403]) {
        answer = async () => new Response(JSON.stringify({ message: "Bad credentials", echoed: KEY }), { status });
        const res = await connect({ integrationId: "github", secretName: "GITHUB", apiKey: KEY });
        expect(res.status).toBe(422);
        const text = await res.text();
        expect(JSON.parse(text).error.code).toBe("CONNECTION_KEY_REJECTED");
        expect(text).not.toContain(KEY);
        expect(text).not.toContain("Bad credentials");
      }
      expect(await stored()).toBe(0);
    });

    it("stores nothing when the key cannot be checked", async () => {
      answer = async () => new Response("upstream down", { status: 503 });
      const unavailable = await connect({ integrationId: "github", secretName: "GITHUB", apiKey: KEY });
      expect(unavailable.status).toBe(502);
      expect((await unavailable.json()).error.code).toBe("CONNECTION_KEY_CHECK_FAILED");
      answer = async () => { throw new Error(`connect ECONNREFUSED with ${KEY}`); };
      const failed = await connect({ integrationId: "github", secretName: "GITHUB", apiKey: KEY });
      expect(failed.status).toBe(502);
      expect(await failed.text()).not.toContain(KEY);
      expect(await stored()).toBe(0);
    });

    it("refuses a sign-in integration, an unknown one, a paused one, a taken name and a malformed key, before any check", async () => {
      expect((await connect({ integrationId: "hubspot", secretName: "HUBSPOT", apiKey: KEY })).status).toBe(400);
      expect((await connect({ integrationId: "nope", secretName: "X", apiKey: KEY })).status).toBe(400);
      expect((await connect({ integrationId: "salesforce", secretName: "SALESFORCE", apiKey: KEY })).status).toBe(400);
      expect((await connect({ integrationId: "gmail", secretName: "GMAIL", apiKey: KEY })).status).toBe(400);
      await call(prodKey, "/api/v2/secrets/TAKEN", { method: "PUT", body: { value: "value-1234", allowedHosts: ["api.example.com"] } });
      expect((await connect({ integrationId: "github", secretName: "TAKEN", apiKey: KEY })).status).toBe(409);
      expect((await connect({ integrationId: "github", secretName: "GITHUB", apiKey: `${KEY}\n` })).status).toBe(400);
      expect((await connect({ integrationId: "github", secretName: "GITHUB", apiKey: KEY, hosts: ["evil.test"] })).status).toBe(400);
      expect(checks).toEqual([]);
      const session = await call(prodKey, "/api/v2/connections/sessions", { method: "POST", body: { integrationId: "stripe", secretName: "STRIPE" } });
      expect(session.status).toBe(400);
    });

    it("a key connected in one environment is not visible from another, and deleting it needs no provider", async () => {
      setConnectionProviderForTests(null);
      await connect({ integrationId: "github", secretName: "GITHUB", apiKey: KEY });
      expect(((await (await call(stagingKey, "/api/v2/connections")).json()).data as unknown[]).length).toBe(0);
      const del = await call(prodKey, "/api/v2/secrets/GITHUB?confirmProtected=true", { method: "DELETE" });
      expect(del.status).toBe(200);
      expect(((await (await call(prodKey, "/api/v2/connections")).json()).data as unknown[]).length).toBe(0);
    });

    it("rotating the key with PUT keeps it bound to its integration and hosts", async () => {
      await connect({ integrationId: "github", secretName: "GITHUB", apiKey: KEY });
      const put = await call(prodKey, "/api/v2/secrets/GITHUB", { method: "PUT", body: { value: "fixture-github-token-rotated-1111" } });
      expect(put.status).toBe(200);
      expect((await put.json()).data).toMatchObject({ kind: "static", integrationId: "github", allowedHosts: ["api.github.com"], allowedPlacements: ["header"] });
    });
  });

  describe("health and reconnecting, for a key and for a sign-in alike", () => {
    const KEY = "fixture-github-token-not-a-key-0000";
    const NEW_KEY = "fixture-github-token-renewed-1111";
    let checks: Array<{ url: string; headers: Record<string, string> }>;
    let answer: () => Promise<Response>;
    let original: typeof keyCheck.fetch;

    beforeEach(() => {
      checks = [];
      answer = async () => new Response("{}", { status: 200 });
      original = keyCheck.fetch;
      keyCheck.fetch = async (url, init) => {
        checks.push({ url, headers: init.headers });
        return answer();
      };
    });
    afterEach(() => { keyCheck.fetch = original; });

    const connectKey = (apiKey = KEY) => call(prodKey, "/api/v2/connections/keys", { method: "POST", body: { integrationId: "github", secretName: "GITHUB", apiKey } });
    const check = (name: string, key = prodKey) => call(key, `/api/v2/connections/${name}/check`, { method: "POST" });
    const reconnect = (name: string, body: Record<string, unknown> = {}, key = prodKey) => call(key, `/api/v2/connections/${name}/reconnect`, { method: "POST", body });
    const health = async (name: string) => ((await (await call(prodKey, `/api/v2/secrets/${name}`)).json()).data as { health: Record<string, unknown> | null; connection: Record<string, unknown> | null });
    const storedValue = async (name: string) => (await pool.query("SELECT value_encrypted FROM workspace_secrets WHERE workspace_id = $1 AND name = $2", [workspaceId, name])).rows[0].value_encrypted as string;

    it("a connected key is checked now when connected, and a check the provider refuses marks it", async () => {
      const connected = (await (await connectKey()).json()).data;
      expect(connected.health).toMatchObject({ status: "active", reason: null });
      expect(connected.health.checkedAt).toBeTruthy();
      const checkedAt = connected.health.checkedAt;

      answer = async () => new Response(JSON.stringify({ message: "Bad credentials", echoed: KEY }), { status: 401 });
      const res = await check("GITHUB");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("Bad credentials");
      const { data } = JSON.parse(text);
      expect(data).toMatchObject({ name: "GITHUB", kind: "static", connection: null, health: { status: "needs_reauth", reason: "key_rejected" } });
      expect(Date.parse(data.health.checkedAt)).toBeGreaterThanOrEqual(Date.parse(checkedAt));
      expect(checks.at(-1)).toMatchObject({ url: "https://api.github.com/user", headers: { Authorization: `Bearer ${KEY}` } });
      const listed = (await (await call(prodKey, "/api/v2/connections")).json()).data;
      expect(listed[0].health.status).toBe("needs_reauth");
    });

    it("a check the provider accepts clears the mark; one that cannot be made leaves it alone", async () => {
      await connectKey();
      answer = async () => new Response("", { status: 403 });
      await check("GITHUB");
      expect((await health("GITHUB")).health).toMatchObject({ status: "needs_reauth", reason: "key_rejected" });

      answer = async () => new Response("down", { status: 503 });
      const inconclusive = await check("GITHUB");
      expect(inconclusive.status).toBe(502);
      expect((await inconclusive.json()).error.code).toBe("CONNECTION_KEY_CHECK_FAILED");
      expect((await health("GITHUB")).health).toMatchObject({ status: "needs_reauth", reason: "key_rejected" });

      answer = async () => new Response("{}", { status: 200 });
      const ok = await check("GITHUB");
      expect(ok.status).toBe(200);
      expect((await ok.json()).data.health).toMatchObject({ status: "active", reason: null });
    });

    it("reconnecting a key checks the new key, replaces the value in place and keeps the bindings", async () => {
      await connectKey();
      answer = async () => new Response("", { status: 401 });
      await check("GITHUB");
      const before = await storedValue("GITHUB");

      const noKey = await reconnect("GITHUB");
      expect(noKey.status).toBe(400);
      expect((await noKey.json()).error.message).toMatch(/send it as apiKey/);

      const refused = await reconnect("GITHUB", { apiKey: NEW_KEY });
      expect(refused.status).toBe(422);
      expect((await refused.json()).error.code).toBe("CONNECTION_KEY_REJECTED");
      expect(await storedValue("GITHUB")).toBe(before);
      expect((await health("GITHUB")).health!.status).toBe("needs_reauth");

      answer = async () => new Response("{}", { status: 200 });
      const res = await reconnect("GITHUB", { apiKey: NEW_KEY });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(NEW_KEY);
      const { data } = JSON.parse(text);
      expect(data).toMatchObject({
        status: "completed", session: null,
        secret: { name: "GITHUB", kind: "static", integrationId: "github", allowedHosts: ["api.github.com"], allowedPlacements: ["header"], health: { status: "active", reason: null } },
      });
      expect(checks.at(-1)!.headers.Authorization).toBe(`Bearer ${NEW_KEY}`);
      expect(await storedValue("GITHUB")).not.toBe(before);
      expect((await pool.query("SELECT count(*)::int AS n FROM workspace_secrets WHERE workspace_id = $1", [workspaceId])).rows[0].n).toBe(1);
    });

    it("a sign-in account is checked by a forced refresh, and reconnected through the same consent window on the same connection", async () => {
      const session = await start();
      await consent(session);
      await complete(session.sessionId);
      expect((await health("HUBSPOT")).health).toMatchObject({ status: "active", reason: null });
      const [before] = await connectionRows();

      expect((await check("HUBSPOT")).status).toBe(200);
      expect(provider.refreshes).toBe(1);

      provider.revoke();
      const res = await check("HUBSPOT");
      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data).toMatchObject({ name: "HUBSPOT", kind: "connection", connection: { integrationId: "hubspot", status: "needs_reauth" }, health: { status: "needs_reauth", reason: "access_revoked" } });

      expect((await reconnect("HUBSPOT", { apiKey: "not-how-this-one-works-000" })).status).toBe(400);

      const started = await reconnect("HUBSPOT");
      expect(started.status).toBe(200);
      const pending = (await started.json()).data;
      expect(pending).toMatchObject({ status: "pending", secret: null });
      expect(pending.session.sessionId).toMatch(/^csn_/);
      expect(pending.session.connectUrl).toContain("/api/v2/connection-consent/start?token=cst_");
      expect(JSON.stringify(pending)).not.toContain(before.id);

      const { res: callback } = await consent(pending.session);
      expect(callback.status).toBe(200);
      const done = await complete(pending.session.sessionId);
      expect(done.status).toBe(200);
      expect((await done.json()).data).toMatchObject({ status: "completed", secret: { name: "HUBSPOT", connection: { status: "active" }, health: { status: "active", reason: null } } });
      expect((await pool.query("SELECT count(*)::int AS n FROM workspace_secrets WHERE workspace_id = $1", [workspaceId])).rows[0].n).toBe(1);
      const after = await connectionRows();
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: before.id, revoked_at: null });
      expect(after[0].access_token_encrypted).not.toBe(before.access_token_encrypted);
    });

    it("a reconnect is completed only with the connection it re-authorised", async () => {
      const session = await start();
      await consent(session);
      await complete(session.sessionId);
      const pending = (await (await reconnect("HUBSPOT")).json()).data;
      const res = await complete(pending.session.sessionId, "oc_someoneelsesconnection00");
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(/not connected through this session/);
    });

    it("a secret bound while a third-party connector held the token is moved to Anlyon by reconnecting it", async () => {
      const legacyId = "6f1c2a90-legacy-0001";
      const value = encryptSecret(JSON.stringify({ provider: "nango", integrationId: "hubspot", integrationKey: "hubspot-anlyon", connectionId: legacyId }), env.DELIVERY_SECRET_MASTER_KEY, {
        store: "vault", workspaceId, environmentId: production.id, name: "LEGACY",
      });
      await pool.query(
        `INSERT INTO workspace_secrets (workspace_id, environment_id, secret_id, name, value_encrypted, allowed_hosts, allowed_placements, kind, connection, integration_id, health)
         VALUES ($1, $2, $3, 'LEGACY', $4, '["api.hubapi.com"]', '["header"]', 'connection', $5, 'hubspot', '{"status":"active","checkedAt":null,"reason":null}')`,
        [workspaceId, production.id, `sec_${randomUUID().replace(/-/g, "").slice(0, 20)}`, value, JSON.stringify({ provider: "nango", integrationId: "hubspot", connectionId: legacyId })],
      );
      expect((await (await check("LEGACY")).json()).data.health).toMatchObject({ status: "needs_reauth", reason: "access_revoked" });

      const pending = (await (await reconnect("LEGACY")).json()).data;
      await consent(pending.session);
      const done = await complete(pending.session.sessionId);
      expect((await done.json()).data).toMatchObject({ status: "completed", secret: { name: "LEGACY", health: { status: "active" } } });
      expect((await connectionRows()).map((r) => r.id)).toEqual([legacyId]);
      expect((await (await check("LEGACY")).json()).data.health.status).toBe("active");
    });

    it("a 401 from the destination probes the account, and only a refused probe marks it", async () => {
      setConnectionProviderForTests(null);
      await connectKey();
      const scope = { workspaceId, environmentId: production.id };
      const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

      answer = async () => new Response("{}", { status: 200 });
      probeRejectedCredentials(scope, ["GITHUB"]);
      await settled();
      expect((await health("GITHUB")).health!.status).toBe("active");
      expect(checks.length).toBe(2);

      answer = async () => new Response("", { status: 401 });
      probeRejectedCredentials(scope, ["GITHUB", "NOT_A_SECRET"]);
      await settled();
      expect((await health("GITHUB")).health).toMatchObject({ status: "needs_reauth", reason: "key_rejected" });
    });

    it("the sweep checks accounts not checked for a day, and skips ones already waiting on a person", async () => {
      setConnectionProviderForTests(null);
      await connectKey();
      const day = 24 * 60 * 60 * 1000;
      checks.length = 0;

      await sweepConnectionHealth(new Date());
      expect(checks.some((c) => c.headers.Authorization === `Bearer ${KEY}`)).toBe(false);

      answer = async () => new Response("", { status: 401 });
      const result = await sweepConnectionHealth(new Date(Date.now() + 2 * day));
      expect(result.checked).toBeGreaterThanOrEqual(1);
      expect(checks.some((c) => c.headers.Authorization === `Bearer ${KEY}`)).toBe(true);
      expect((await health("GITHUB")).health).toMatchObject({ status: "needs_reauth", reason: "key_rejected" });

      checks.length = 0;
      await sweepConnectionHealth(new Date(Date.now() + 4 * day));
      expect(checks.some((c) => c.headers.Authorization === `Bearer ${KEY}`)).toBe(false);
    });

    it("a stored value is not a connected account, and an unknown name is not found", async () => {
      await call(prodKey, "/api/v2/secrets/PLAIN", { method: "PUT", body: { value: "value-1234", allowedHosts: ["api.example.com"] } });
      const plain = await check("PLAIN");
      expect(plain.status).toBe(400);
      expect((await plain.json()).error.message).toMatch(/not a connected account/);
      expect((await reconnect("PLAIN", { apiKey: "whatever-key-0000" })).status).toBe(400);
      expect((await check("NOPE")).status).toBe(404);
      expect((await check("lower")).status).toBe(400);
      await connectKey();
      expect((await check("GITHUB", stagingKey)).status).toBe(404);
    });
  });
});
