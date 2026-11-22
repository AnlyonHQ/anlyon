import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  process.env.CONNECTIONS_ENCRYPTION_KEY = "test-connections-encryption-key-32chars";
  process.env.CONNECTIONS_ALLOW_UNVERIFIED = "true";
  process.env.CONNECT_PUBLIC_URL = "https://api.anlyon.test";
  return {
    client: undefined as PGlite | undefined,
    store: new Map<string, { value: string; expiresAt: number }>(),
    sent: [] as Array<{ url: string; authorization: string }>,
  };
});
vi.mock("../src/lib/safe-http.ts", async (original) => ({
  ...await original<typeof import("../src/lib/safe-http.ts")>(),
  safeFetch: async (url: string, init: { headers?: Record<string, string> }) => {
    state.sent.push({ url, authorization: init.headers?.Authorization ?? "" });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  },
}));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client), pool: { end: async () => {} } };
});
vi.mock("../src/lib/redis.ts", () => {
  const live = (key: string) => {
    const entry = state.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      state.store.delete(key);
      return null;
    }
    return entry;
  };
  const redis = {
    async set(key: string, value: string, _px?: "PX", ttl?: number) {
      state.store.set(key, { value, expiresAt: Date.now() + (ttl ?? 86_400_000) });
      return "OK";
    },
    async get(key: string) { return live(key)?.value ?? null; },
    async getdel(key: string) {
      const entry = live(key);
      state.store.delete(key);
      return entry?.value ?? null;
    },
    async pttl(key: string) {
      const entry = live(key);
      return entry ? entry.expiresAt - Date.now() : -2;
    },
    async del(key: string) { return state.store.delete(key) ? 1 : 0; },
    async incr(key: string) {
      const next = Number(live(key)?.value ?? 0) + 1;
      state.store.set(key, { value: String(next), expiresAt: live(key)?.expiresAt ?? Date.now() + 60_000 });
      return next;
    },
    async decr() { return 0; },
    async expire() { return 1; },
    async pexpire() { return 1; },
    async exists() { return 0; },
    async hgetall() { return {}; },
  };
  const RedisKeys = new Proxy({}, { get: (_t, name) => (...parts: unknown[]) => `${String(name)}:${parts.join(":")}` });
  return { redis, redisBlocking: redis, RedisKeys, createBlockingConnection: () => redis };
});
vi.mock("../src/core/events/emitter.ts", () => ({ emitEvent: vi.fn() }));
vi.mock("../src/core/notifications/notification-service.ts", () => ({ createAndSendNotification: vi.fn() }));
vi.mock("../src/core/assistant/service.ts", () => ({ onApprovalAnnounced: async () => false }));
vi.mock("../src/lib/product-events.ts", () => ({ captureMilestoneOnce: vi.fn() }));

const { isFeatureEnabled } = await import("@anlyon/feature-flags");
const GOOGLE_ON = isFeatureEnabled("google-integrations");
const PAUSED_SIGN_IN = GOOGLE_ON
  ? { id: "salesforce", authorize: "https://login.salesforce.com/services/oauth2/authorize" }
  : { id: "gmail", authorize: "https://accounts.google.com/o/oauth2/v2/auth" };
const { createNativeProvider } = await import("../src/core/connections/native.ts");
const { setConnectionProviderForTests } = await import("../src/core/connections/provider.ts");
const { keyCheck } = await import("../src/core/connections/health.ts");
const { OAuthProviderSimulator, OAUTH_SIM_CLIENT, OAUTH_SIM_ENCRYPTION_KEY, OAUTH_SIM_ORIGIN } = await import("./support/effects/oauth-simulator.ts");
const { environmentOAuthClient, putEnvironmentOAuthApp, deleteEnvironmentOAuthApp } = await import("../src/core/end-users/oauth-apps.ts");
const connect = await import("../src/core/end-users/connect.ts");
const connections = await import("../src/core/end-users/connections.ts");
const { integrationsOverview } = await import("../src/core/connections/overview.ts");
const { resolveSecrets, putSecret } = await import("../src/core/actions/secrets.ts");
const approvalsService = await import("../src/core/approvals/service.ts");
const impact = await import("../src/core/effects/impact.ts");
const { db } = await import("../src/db/index.ts");
const { invokeAction } = await import("../src/core/actions/service.ts");

const ws = "00000000-0000-4000-8000-0000000000e1";
const env = "00000000-0000-4000-8000-0000000000f1";
const otherEnv = "00000000-0000-4000-8000-0000000000f2";
const scope = { workspaceId: ws, environmentId: env };
const actor = { type: "api_key" as const, id: "00000000-0000-4000-8000-00000000aaaa" };
const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);

let oauth: InstanceType<typeof OAuthProviderSimulator>;
let keyChecks: string[] = [];

async function completeLink(linkUrl: string, how: "approve" | "deny" = "approve"): Promise<URL> {
  const { connectionProvider } = await import("../src/core/connections/provider.ts");
  const provider = connectionProvider()!;
  const token = new URL(linkUrl).searchParams.get("token")!;
  const authorize = await provider.beginConsent(token);
  if (!authorize) throw new Error("link not live");
  const back = new URL(how === "approve" ? oauth.approve(authorize) : oauth.deny(authorize));
  const result = await provider.finishConsent({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: back.searchParams.get("error") });
  const subject = result.ok ? result.outcome.subject : result.reason === "expired" ? undefined : result.subject;
  if (!subject) throw new Error(`no end-user consent: ${JSON.stringify(result)}`);
  const to = await connect.recordEndUserConsent(subject, result.ok ? { status: "connected", connectionId: result.outcome.connectionId } : { status: result.reason === "declined" ? "declined" : "error" });
  return new URL(to!);
}

async function connectHubspot(endUserId: string): Promise<void> {
  const link = await connect.createConnectLink(scope, endUserId, { integration: "hubspot" });
  const landed = await completeLink(link.url);
  await connect.confirmConnection(scope, endUserId, landed.searchParams.get("anlyon_flow")!, actor);
}

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Acme Mail', 'acme-mail')", [ws]);
  await sql(
    `INSERT INTO environments (id, workspace_id, name, slug, kind, allowed_redirect_urls, default_redirect_url)
     VALUES ($1, $3, 'Production', 'prod', 'production', ARRAY['https://app.acme.test/connected'], 'https://app.acme.test/connected'),
            ($2, $3, 'Dev', 'dev', 'development', '{}', NULL)`,
    [env, otherEnv, ws],
  );
}, 120_000);

beforeEach(() => {
  state.store.clear();
  oauth = new OAuthProviderSimulator();
  setConnectionProviderForTests(createNativeProvider({
    origin: OAUTH_SIM_ORIGIN,
    encryptionKey: OAUTH_SIM_ENCRYPTION_KEY,
    fetch: oauth.fetch,
    clientFor: (spec) => (spec.credentials === "GITHUB" || spec.credentials === "NOTION" ? null : OAUTH_SIM_CLIENT),
    environmentClient: environmentOAuthClient,
  }));
  keyChecks = [];
  vi.spyOn(keyCheck, "fetch").mockImplementation(async (_url, init) => {
    const auth = init.headers.Authorization ?? "";
    keyChecks.push(auth);
    return new Response("{}", { status: auth.includes("bad") ? 401 : 200 });
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await sql("DELETE FROM oauth_connections");
});

describe("isolation between end users", () => {
  it("an end user's call resolves only that end user's own account", async () => {
    await connections.setEndUserApiKey(scope, "alice", "github", "ghp_alice_token_000000", actor);
    await connections.setEndUserApiKey(scope, "bob", "github", "ghp_bob_token_00000000", actor);

    expect(await connections.endUserCredential(scope, "github", "alice")).toBe("ghp_alice_token_000000");
    expect(await connections.endUserCredential(scope, "github", "bob")).toBe("ghp_bob_token_00000000");
    await expect(connections.endUserCredential({ workspaceId: ws, environmentId: otherEnv }, "github", "alice"))
      .rejects.toMatchObject({ code: "END_USER_NOT_CONNECTED" });
    await expect(connections.endUserCredential(scope, "github", "carol")).rejects.toMatchObject({ statusCode: 409, code: "END_USER_NOT_CONNECTED" });
  });

  it("a workspace secret bound to an integration resolves to the end user's account, and a required end user never falls back", async () => {
    await putSecret(ws, "GITHUB", { value: "ghp_workspace_token_00", integrationId: "github", allowedHosts: ["api.github.com"], allowedPlacements: ["header"], checked: true }, env);
    await putSecret(ws, "PLAIN", { value: "plain-value-0000" }, env);
    await connections.setEndUserApiKey(scope, "alice", "github", "ghp_alice_token_000000", actor);

    const forAlice = await resolveSecrets(ws, ["GITHUB", "PLAIN", "connection:github"], env, { endUserId: "alice", required: false });
    expect(forAlice.get("GITHUB")).toBe("ghp_alice_token_000000");
    expect(forAlice.get("connection:github")).toBe("ghp_alice_token_000000");
    expect(forAlice.get("PLAIN")).toBe("plain-value-0000");

    const forWorkspace = await resolveSecrets(ws, ["GITHUB", "connection:github"], env);
    expect(forWorkspace.get("GITHUB")).toBe("ghp_workspace_token_00");
    expect(forWorkspace.get("connection:github")).toBe("ghp_workspace_token_00");

    await expect(resolveSecrets(ws, ["GITHUB"], env, { endUserId: "bob", required: false })).rejects.toMatchObject({ code: "END_USER_NOT_CONNECTED" });
    await expect(resolveSecrets(ws, ["GITHUB"], env, { endUserId: null, required: true })).rejects.toMatchObject({ code: "END_USER_REQUIRED" });
    await expect(resolveSecrets(ws, ["connection:github"], env, { endUserId: null, required: true })).rejects.toMatchObject({ code: "END_USER_REQUIRED" });
    await sql("DELETE FROM workspace_secrets WHERE workspace_id = $1", [ws]);
  });

  it("another end user's approval answers 404, and end users' approvals stay out of the team inbox", async () => {
    const insert = (id: string, endUserId: string, decidedBy: string) => sql(
      `INSERT INTO approvals (workspace_id, environment_id, approval_id, kind, status, title, expires_at, end_user_id, decided_by)
       VALUES ($1, $2, $3, 'custom', 'pending', 'Send the email', now() + interval '1 day', $4, $5)`,
      [ws, env, id, endUserId, decidedBy],
    );
    await insert("apr_bob_own", "bob", "end_user");
    await insert("apr_alice_own", "alice", "end_user");
    await insert("apr_alice_team", "alice", "team");
    const asEndUser = (endUserId: string) => ({ deciderKeyId: null, deciderUserId: null, endUserId });

    await expect(approvalsService.approveApproval(ws, "apr_bob_own", asEndUser("alice"), env)).rejects.toMatchObject({ statusCode: 404 });
    await expect(approvalsService.denyApproval(ws, "apr_bob_own", asEndUser("alice"), env)).rejects.toMatchObject({ statusCode: 404 });
    await expect(approvalsService.approveApproval(ws, "apr_alice_team", asEndUser("alice"), env)).rejects.toMatchObject({ statusCode: 404 });
    await expect(approvalsService.approveApproval(ws, "apr_alice_own", { deciderUserId: "someone" }, env)).rejects.toMatchObject({ statusCode: 404 });

    const aliceList = await approvalsService.listEndUserApprovals(scope, "alice");
    expect(aliceList.approvals.map((a) => a.id)).toEqual(["apr_alice_own"]);
    expect(aliceList.approvals[0]).toMatchObject({ endUserId: "alice", decider: "end_user" });
    const inbox = await approvalsService.listApprovals(ws, { environmentId: env });
    expect(inbox.approvals.map((a) => a.id)).toEqual(["apr_alice_team"]);

    const decided = await approvalsService.approveApproval(ws, "apr_bob_own", asEndUser("bob"), env);
    expect(decided.approval).toMatchObject({ status: "approved", decisionOrigin: "human" });
    await sql("DELETE FROM approvals WHERE workspace_id = $1", [ws]);
  });
});

describe("connect links and confirmation", () => {
  it("requires an allowed redirect and refuses open redirects", async () => {
    await expect(connect.createConnectLink({ workspaceId: ws, environmentId: otherEnv }, "alice", { integration: "hubspot" }))
      .rejects.toMatchObject({ statusCode: 400, code: "REDIRECT_URL_REQUIRED" });
    for (const redirectUrl of [
      "https://evil.test/connected",
      "https://app.acme.test.evil.test/connected",
      "https://app.acme.test@evil.test/connected",
      "//evil.test/connected",
      "https://app.acme.test/connected-elsewhere",
      "https://app.acme.test/other",
      "javascript:alert(1)",
      "http://app.acme.test/connected",
      "https://app.acme.test\\@evil.test/connected",
    ]) {
      await expect(connect.createConnectLink(scope, "alice", { integration: "hubspot", redirectUrl }), redirectUrl)
        .rejects.toMatchObject({ statusCode: 400, code: "REDIRECT_URL_NOT_ALLOWED" });
    }
    const link = await connect.createConnectLink(scope, "alice", { integration: "hubspot", redirectUrl: "https://app.acme.test/connected/gmail?tab=1" });
    expect(link.url.startsWith(`${OAUTH_SIM_ORIGIN}/api/v2/connection-consent/link?token=cst_`)).toBe(true);
    expect(link.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
  });

  it("an integration Anlyon does not offer with its own app connects only through the environment's own app", async () => {
    const id = PAUSED_SIGN_IN.id;
    await expect(connect.createConnectLink(scope, "alice", { integration: id }))
      .rejects.toMatchObject({ statusCode: 400, code: "OWN_OAUTH_APP_REQUIRED" });
    expect(await connect.connectLinkForRetry(scope, "alice", id)).toBeNull();

    await putEnvironmentOAuthApp(scope, id, OAUTH_SIM_CLIENT);
    try {
      const link = await connect.createConnectLink(scope, "alice", { integration: id });
      const { connectionProvider } = await import("../src/core/connections/provider.ts");
      const authorize = new URL((await connectionProvider()!.beginConsent(new URL(link.url).searchParams.get("token")!))!);
      expect(`${authorize.origin}${authorize.pathname}`).toBe(PAUSED_SIGN_IN.authorize);
      expect(authorize.searchParams.get("client_id")).toBe(OAUTH_SIM_CLIENT.clientId);
      expect(await connect.connectLinkForRetry(scope, "alice", id)).not.toBeNull();
      expect(await environmentOAuthClient(otherEnv, id)).toBeNull();
    } finally {
      await deleteEnvironmentOAuthApp(scope, id);
    }
  });

  it.runIf(GOOGLE_ON)("where the google-integrations feature is on, Gmail and Google Calendar sign in with Anlyon's app and ask Google for one scope each", async () => {
    const { connectionProvider } = await import("../src/core/connections/provider.ts");
    for (const [integration, scopeAsked] of [
      ["gmail", "https://www.googleapis.com/auth/gmail.send"],
      ["google-calendar", "https://www.googleapis.com/auth/calendar.events"],
    ] as const) {
      const link = await connect.createConnectLink(scope, "alice", { integration });
      const authorize = new URL((await connectionProvider()!.beginConsent(new URL(link.url).searchParams.get("token")!))!);
      expect(`${authorize.origin}${authorize.pathname}`, integration).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(authorize.searchParams.get("scope"), integration).toBe(scopeAsked);
      expect(authorize.searchParams.get("access_type"), integration).toBe("offline");
    }
  });

  it("a listed integration whose app this deployment does not have asks for the environment's own app, and uses Anlyon's once the pair is set", async () => {
    const deployment = (hasHubSpot: boolean) => setConnectionProviderForTests(createNativeProvider({
      origin: OAUTH_SIM_ORIGIN, encryptionKey: OAUTH_SIM_ENCRYPTION_KEY, fetch: oauth.fetch,
      clientFor: (spec) => (spec.credentials === "HUBSPOT" && !hasHubSpot ? null : OAUTH_SIM_CLIENT),
      environmentClient: environmentOAuthClient,
    }));
    deployment(false);
    await expect(connect.createConnectLink(scope, "alice", { integration: "hubspot" }))
      .rejects.toMatchObject({ statusCode: 400, code: "OWN_OAUTH_APP_REQUIRED" });
    expect((await integrationsOverview(scope)).find((e) => e.id === "hubspot")).toMatchObject({ connectable: false, signIn: { app: "own_required" } });

    await putEnvironmentOAuthApp(scope, "hubspot", { clientId: "env-own-client", clientSecret: "env-own-secret" });
    try {
      expect((await integrationsOverview(scope)).find((e) => e.id === "hubspot")).toMatchObject({ connectable: true, signIn: { app: "own" } });
      const link = await connect.createConnectLink(scope, "alice", { integration: "hubspot" });
      const { connectionProvider } = await import("../src/core/connections/provider.ts");
      const authorize = new URL((await connectionProvider()!.beginConsent(new URL(link.url).searchParams.get("token")!))!);
      expect(authorize.searchParams.get("client_id")).toBe("env-own-client");
    } finally {
      await deleteEnvironmentOAuthApp(scope, "hubspot");
    }

    deployment(true);
    expect((await integrationsOverview(scope)).find((e) => e.id === "hubspot")).toMatchObject({ connectable: true, signIn: { app: "anlyon" } });
    const link = await connect.createConnectLink(scope, "alice", { integration: "hubspot" });
    const { connectionProvider } = await import("../src/core/connections/provider.ts");
    const authorize = new URL((await connectionProvider()!.beginConsent(new URL(link.url).searchParams.get("token")!))!);
    expect(authorize.searchParams.get("client_id")).toBe(OAUTH_SIM_CLIENT.clientId);
  });

  it("with the environment's own app a link goes straight to the provider, and an unfurler's GETs use nothing up", async () => {
    const { default: consentRouter } = await import("../src/api/routes/connection-consent.ts");
    await putEnvironmentOAuthApp(scope, "hubspot", OAUTH_SIM_CLIENT);
    try {
      const link = await connect.createConnectLink(scope, "alice", { integration: "hubspot" });
      const path = `/link?token=${new URL(link.url).searchParams.get("token")}`;
      const unfurled = await consentRouter.request(path);
      const opened = await consentRouter.request(path);
      expect(unfurled.status).toBe(302);
      expect(unfurled.headers.get("cache-control")).toBe("no-store");
      const authorize = new URL(opened.headers.get("location")!);
      expect(opened.headers.get("location")).toBe(unfurled.headers.get("location"));
      expect(`${authorize.origin}${authorize.pathname}`).toBe("https://app.hubspot.com/oauth/authorize");
      expect(authorize.searchParams.get("client_id")).toBe(OAUTH_SIM_CLIENT.clientId);

      const back = new URL(oauth.approve(authorize.toString()));
      const { connectionProvider } = await import("../src/core/connections/provider.ts");
      const finish = () => connectionProvider()!.finishConsent({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null });
      const done = await finish();
      expect(done.ok).toBe(true);
      expect(await finish()).toEqual({ ok: false, reason: "expired", endUserId: null });
      expect((await consentRouter.request(path)).status).toBe(410);
    } finally {
      await deleteEnvironmentOAuthApp(scope, "hubspot");
    }
  });

  it("with Anlyon's shared app a link shows the page first, and opening it uses nothing up", async () => {
    const { default: consentRouter } = await import("../src/api/routes/connection-consent.ts");
    const link = await connect.createConnectLink(scope, "alice", { integration: "hubspot" });
    const path = `/link?token=${new URL(link.url).searchParams.get("token")}`;
    for (let i = 0; i < 2; i++) {
      const page = await consentRouter.request(path);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Connect HubSpot to Acme Mail");
      expect(html).toContain("HubSpot will show Anlyon, which connects your account for Acme Mail.");
      expect(html).toContain("anlyon_status=declined");
    }
    const landed = await completeLink(link.url);
    expect(landed.searchParams.get("anlyon_status")).toBe("pending_confirmation");
  });

  it("with a pages origin, links and the redirect URI use its short paths, and the code exchange sends the URI the authorize URL named", async () => {
    const pages = "https://connect.anlyon.test";
    const make = (pagesOrigin: string | null) => createNativeProvider({
      origin: OAUTH_SIM_ORIGIN, pagesOrigin, encryptionKey: OAUTH_SIM_ENCRYPTION_KEY, fetch: oauth.fetch, clientFor: () => OAUTH_SIM_CLIENT, environmentClient: environmentOAuthClient,
    });
    const exchangedWith = () => new URLSearchParams(oauth.requests.filter((r) => r.body.includes("grant_type=authorization_code")).at(-1)!.body).get("redirect_uri");

    setConnectionProviderForTests(make(pages));
    const link = await connect.createConnectLink(scope, "alice", { integration: "hubspot" });
    expect(link.url.startsWith(`${pages}/link?token=cst_`)).toBe(true);
    const token = new URL(link.url).searchParams.get("token")!;
    const { connectionProvider } = await import("../src/core/connections/provider.ts");
    expect(connectionProvider()!.connectUrl(token)).toBe(`${pages}/start?token=${token}`);
    const authorize = new URL((await connectionProvider()!.beginConsent(token))!);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${pages}/callback`);
    const back = new URL(oauth.approve(authorize.toString()));
    expect((await connectionProvider()!.finishConsent({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null })).ok).toBe(true);
    expect(exchangedWith()).toBe(`${pages}/callback`);

    setConnectionProviderForTests(make(null));
    const before = await connect.createConnectLink(scope, "bob", { integration: "hubspot" });
    const started = new URL((await connectionProvider()!.beginConsent(new URL(before.url).searchParams.get("token")!))!);
    expect(started.searchParams.get("redirect_uri")).toBe(`${OAUTH_SIM_ORIGIN}/api/v2/connection-consent/callback`);
    setConnectionProviderForTests(make(pages));
    const returned = new URL(oauth.approve(started.toString()));
    expect((await connectionProvider()!.finishConsent({ state: returned.searchParams.get("state"), code: returned.searchParams.get("code"), error: null })).ok).toBe(true);
    expect(exchangedWith()).toBe(`${OAUTH_SIM_ORIGIN}/api/v2/connection-consent/callback`);
  });

  it("an API-key integration gets a key link; an OAuth one has no key path", async () => {
    const link = await connect.createConnectLink(scope, "alice", { integration: "github" });
    expect(link.url.startsWith("https://api.anlyon.test/api/v2/connection-consent/key?token=kln_")).toBe(true);
    expect(link.url).not.toContain("alice");
    await expect(connections.setEndUserApiKey(scope, "alice", "hubspot", "token", actor)).rejects.toMatchObject({ statusCode: 400 });
    await expect(connections.setEndUserApiKey(scope, "alice", "github", "bad_key_0000", actor)).rejects.toMatchObject({ statusCode: 422 });
    expect(keyChecks).toEqual(["Bearer bad_key_0000"]);
    expect(await connections.listEndUserConnections(scope, "alice")).toEqual([]);
  });

  it("with a GitHub app on the deployment, a GitHub link signs in, and an end user's key is still taken and used", async () => {
    setConnectionProviderForTests(createNativeProvider({
      origin: OAUTH_SIM_ORIGIN, encryptionKey: OAUTH_SIM_ENCRYPTION_KEY, fetch: oauth.fetch, clientFor: () => OAUTH_SIM_CLIENT, environmentClient: environmentOAuthClient,
    }));
    const link = await connect.createConnectLink(scope, "alice", { integration: "github" });
    expect(link.url.startsWith("https://api.anlyon.test/api/v2/connection-consent/link?token=cst_")).toBe(true);
    await connections.setEndUserApiKey(scope, "alice", "github", "ghp_alice_token_000000", actor);
    expect(await connections.listEndUserConnections(scope, "alice")).toMatchObject([{ integration: "github", kind: "api_key", scopes: [] }]);
    expect(await connections.endUserCredential(scope, "github", "alice")).toBe("ghp_alice_token_000000");
    expect((await integrationsOverview(scope)).find((entry) => entry.id === "github")).toMatchObject({
      connectable: true, auth: { kind: "oauth", apiKey: { instructionsUrl: "https://github.com/settings/personal-access-tokens/new" } }, signIn: { app: "anlyon" },
    });
  });

  const keyToken = (url: string) => new URL(url).searchParams.get("token")!;

  it("a key typed into a key link is checked, held pending, and becomes the end user's only on confirm", async () => {
    await connections.setEndUserApiKey(scope, "alice", "github", "ghp_alice_old_0000000", actor);
    const link = await connect.createConnectLink(scope, "alice", { integration: "github" });
    const token = keyToken(link.url);
    expect(await connect.peekKeyLink(token)).toMatchObject({ integration: "github", workspaceName: "Acme Mail" });

    expect(await connect.submitKeyLink(token, { apiKey: "bad_key_0001" })).toMatchObject({ status: "refused", attemptsLeft: connect.KEY_LINK_ATTEMPTS - 1 });
    expect(await connect.peekKeyLink(token)).not.toBeNull();

    const result = await connect.submitKeyLink(token, { apiKey: "ghp_alice_new_0000000" });
    expect(result.status).toBe("connected");
    const landed = new URL((result as { redirectTo: string }).redirectTo);
    expect(`${landed.origin}${landed.pathname}`).toBe("https://app.acme.test/connected");
    expect(landed.searchParams.get("anlyon_status")).toBe("pending_confirmation");
    expect(landed.toString()).not.toContain("alice");
    expect(await connect.peekKeyLink(token)).toBeNull();
    expect(await connect.submitKeyLink(token, { apiKey: "ghp_alice_new_0000000" })).toEqual({ status: "expired" });
    expect(await connections.endUserCredential(scope, "github", "alice")).toBe("ghp_alice_old_0000000");

    expect(await connect.confirmConnection(scope, "alice", landed.searchParams.get("anlyon_flow")!, actor)).toEqual({ integration: "github", status: "active" });
    expect(await connections.endUserCredential(scope, "github", "alice")).toBe("ghp_alice_new_0000000");
    expect(await connections.listEndUserConnections(scope, "alice")).toMatchObject([{ integration: "github", kind: "api_key", status: "active" }]);
  });

  it("a key link confirmed for another end user stores nothing (account takeover)", async () => {
    const link = await connect.createConnectLink(scope, "mallory", { integration: "github" });
    const result = await connect.submitKeyLink(keyToken(link.url), { apiKey: "ghp_victim_token_00000" });
    const flowId = new URL((result as { redirectTo: string }).redirectTo).searchParams.get("anlyon_flow")!;
    await expect(connect.confirmConnection(scope, "victim", flowId, actor)).rejects.toMatchObject({ statusCode: 403, code: "END_USER_MISMATCH" });
    expect((await sql("SELECT count(*)::int AS n FROM oauth_connections")).rows[0].n).toBe(0);
  });

  it("a key link is used up after too many refused keys", async () => {
    const token = keyToken((await connect.createConnectLink(scope, "alice", { integration: "github" })).url);
    for (let i = 1; i <= connect.KEY_LINK_ATTEMPTS; i++) {
      expect(await connect.submitKeyLink(token, { apiKey: `bad_key_${i}` })).toMatchObject({ status: "refused", attemptsLeft: connect.KEY_LINK_ATTEMPTS - i });
    }
    expect(await connect.submitKeyLink(token, { apiKey: "ghp_alice_token_000000" })).toEqual({ status: "expired" });
    expect(await connect.peekKeyLink(token)).toBeNull();
    expect(await connections.listEndUserConnections(scope, "alice")).toEqual([]);
  });

  it("the hosted key page asks for the key, refuses a bad one without echoing it, and sends the browser back", async () => {
    const { default: consentRouter } = await import("../src/api/routes/connection-consent.ts");
    const token = keyToken((await connect.createConnectLink(scope, "alice", { integration: "github" })).url);

    const page = await consentRouter.request(`/key?token=${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain("Connect GitHub to Acme Mail");
    expect(html).toContain('name="f_apiKey" type="password"');
    expect(html).toContain(`name="token" value="${token}"`);
    expect(html).not.toContain("alice");

    const post = (apiKey: string, t = token) => consentRouter.request("/key", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: t, f_apiKey: apiKey }).toString(),
    });
    const refused = await post("bad_key_secret_value");
    expect(refused.status).toBe(400);
    const refusedHtml = await refused.text();
    expect(refusedHtml).toContain('role="alert"');
    expect(refusedHtml).toContain("4 tries are left on this link.");
    expect(refusedHtml).not.toContain("bad_key_secret_value");

    const accepted = await post("ghp_alice_token_000000");
    expect(accepted.status).toBe(302);
    const back = new URL(accepted.headers.get("location")!);
    expect(back.searchParams.get("anlyon_status")).toBe("pending_confirmation");
    expect((await post("ghp_alice_token_000000")).status).toBe(410);
    expect((await consentRouter.request("/key?token=kln_nope")).status).toBe(410);
  });

  it("with confirmation off, a link needs no redirect and the end user lands on Anlyon's page", async () => {
    const dev = { workspaceId: ws, environmentId: otherEnv };
    await sql("UPDATE environments SET connect_confirmation = 'off' WHERE id = $1", [otherEnv]);
    try {
      const link = await connect.createConnectLink(dev, "alice", { integration: "github" });
      expect(await connect.submitKeyLink(keyToken(link.url), { apiKey: "ghp_alice_token_000000" })).toEqual({ status: "connected", redirectTo: null });
      expect(await connections.listEndUserConnections(dev, "alice")).toMatchObject([{ integration: "github", status: "active" }]);
      expect(await connect.connectLinkForRetry(dev, "bob", "github")).not.toBeNull();
    } finally {
      await sql("UPDATE environments SET connect_confirmation = 'required' WHERE id = $1", [otherEnv]);
    }
    await expect(connect.createConnectLink(dev, "alice", { integration: "github" })).rejects.toMatchObject({ code: "REDIRECT_URL_REQUIRED" });
  });

  it("the overview counts each integration's accounts and says whose app signs people in", async () => {
    await connections.setEndUserApiKey(scope, "alice", "github", "ghp_alice_token_000000", actor);
    await connections.setEndUserApiKey(scope, "bob", "github", "ghp_bob_token_00000000", actor);
    const byId = async () => new Map((await integrationsOverview(scope)).map((entry) => [entry.id, entry]));
    let overview = await byId();
    expect(overview.get("github")).toMatchObject({ connectable: true, auth: { kind: "api_key" }, signIn: { app: "own_required" }, endUsers: { connected: 2, needsReconnect: 0 }, workspace: { connected: 0 } });
    expect(overview.get("stripe")).toMatchObject({ signIn: null });
    expect(overview.get("hubspot")?.signIn).toMatchObject({ app: "anlyon", redirectUri: "https://api.anlyon.test/api/v2/connection-consent/callback" });
    expect(overview.get(PAUSED_SIGN_IN.id)).toMatchObject({ connectable: false, signIn: { app: "own_required" } });
    expect(overview.get("gmail")).toMatchObject(GOOGLE_ON ? { connectable: true, signIn: { app: "anlyon" } } : { connectable: false, signIn: { app: "own_required" } });
    await putEnvironmentOAuthApp(scope, PAUSED_SIGN_IN.id, OAUTH_SIM_CLIENT);
    try {
      overview = await byId();
      expect(overview.get(PAUSED_SIGN_IN.id)?.signIn?.app).toBe("own");
    } finally {
      await deleteEnvironmentOAuthApp(scope, PAUSED_SIGN_IN.id);
    }
    expect((await connections.listEndUsers(scope, { integration: "github" })).endUsers.map((u) => u.endUserId)).toEqual(["alice", "bob"]);
    expect((await connections.listEndUsers(scope, { integration: "hubspot" })).endUsers).toEqual([]);
  });

  it("stores the grant pending until confirmed, never puts the end user in the URL, and activates on confirm", async () => {
    const link = await connect.createConnectLink(scope, "alice@acme.test", { integration: "hubspot" });
    const landed = await completeLink(link.url);
    expect(`${landed.origin}${landed.pathname}`).toBe("https://app.acme.test/connected");
    expect(landed.searchParams.get("anlyon_status")).toBe("pending_confirmation");
    expect(landed.searchParams.get("integration")).toBe("hubspot");
    expect(landed.toString()).not.toContain("alice");
    const flowId = landed.searchParams.get("anlyon_flow")!;

    expect(await connections.listEndUserConnections(scope, "alice@acme.test")).toEqual([]);
    await expect(connections.endUserCredential(scope, "hubspot", "alice@acme.test")).rejects.toMatchObject({ code: "END_USER_NOT_CONNECTED" });

    expect(await connect.confirmConnection(scope, "alice@acme.test", flowId, actor)).toEqual({ integration: "hubspot", status: "active" });
    const listed = await connections.listEndUserConnections(scope, "alice@acme.test");
    expect(listed).toMatchObject([{ integration: "hubspot", status: "active", kind: "oauth" }]);
    expect(JSON.stringify(listed)).not.toContain(oauth.latest().accessToken);
    expect(await connections.endUserCredential(scope, "hubspot", "alice@acme.test")).toBe(oauth.latest().accessToken);

    await expect(connect.confirmConnection(scope, "alice@acme.test", flowId, actor)).rejects.toMatchObject({ statusCode: 404 });
    await expect(completeLink(link.url)).rejects.toThrow(/not live/);
  });

  it("refuses a flow confirmed for another end user, revokes the grant and stores nothing (account takeover)", async () => {
    const link = await connect.createConnectLink(scope, "mallory", { integration: "hubspot" });
    const landed = await completeLink(link.url);
    const flowId = landed.searchParams.get("anlyon_flow")!;

    await expect(connect.confirmConnection(scope, "victim", flowId, actor)).rejects.toMatchObject({ statusCode: 403, code: "END_USER_MISMATCH" });
    expect((await sql("SELECT count(*)::int AS n FROM oauth_connections")).rows[0].n).toBe(0);
    expect(oauth.revocations).toBe(1);
    expect(await connections.listEndUserConnections(scope, "mallory")).toEqual([]);
    expect(await connections.listEndUserConnections(scope, "victim")).toEqual([]);
    await expect(connect.confirmConnection(scope, "mallory", flowId, actor)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("another environment's flow reads as unknown and is left alone", async () => {
    const link = await connect.createConnectLink(scope, "alice", { integration: "hubspot" });
    const flowId = (await completeLink(link.url)).searchParams.get("anlyon_flow")!;
    await expect(connect.confirmConnection({ workspaceId: ws, environmentId: otherEnv }, "alice", flowId, actor)).rejects.toMatchObject({ statusCode: 404 });
    expect(await connect.confirmConnection(scope, "alice", flowId, actor)).toMatchObject({ status: "active" });
  });

  it("deletes a grant nobody confirmed in time", async () => {
    const link = await connect.createConnectLink(scope, "alice", { integration: "hubspot" });
    const flowId = (await completeLink(link.url)).searchParams.get("anlyon_flow")!;
    await sql("UPDATE oauth_connections SET pending_confirmation_until = now() - interval '1 second'");
    expect(await connect.sweepUnconfirmedGrants()).toBe(1);
    expect((await sql("SELECT count(*)::int AS n FROM oauth_connections")).rows[0].n).toBe(0);
    await expect(connect.confirmConnection(scope, "alice", flowId, actor)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("a declined consent uses the link up and sends the browser back with the result", async () => {
    const link = await connect.createConnectLink(scope, "alice", { integration: "hubspot" });
    const landed = await completeLink(link.url, "deny");
    expect(landed.searchParams.get("anlyon_status")).toBe("declined");
    expect(landed.searchParams.get("anlyon_flow")).toBeNull();
    await expect(completeLink(link.url)).rejects.toThrow(/not live/);
  });

  it("an expired link cannot be opened", async () => {
    const link = await connect.createConnectLink(scope, "alice", { integration: "hubspot" });
    for (const [key, entry] of state.store) if (key.startsWith("connections:consent:")) entry.expiresAt = Date.now() - 1;
    await expect(completeLink(link.url)).rejects.toThrow(/not live/);
  });

  it("limits how many links one end user can be sent per minute", async () => {
    for (let i = 0; i < connect.LINKS_PER_MINUTE_PER_END_USER; i++) {
      await connect.createConnectLink(scope, "alice", { integration: "hubspot" });
    }
    await expect(connect.createConnectLink(scope, "alice", { integration: "hubspot" })).rejects.toMatchObject({ statusCode: 429 });
    await connect.createConnectLink(scope, "bob", { integration: "hubspot" });
  });

  it("with confirmation off (development only), the grant is active at once", async () => {
    const dev = { workspaceId: ws, environmentId: otherEnv };
    await sql(`UPDATE environments SET connect_confirmation = 'off', allowed_redirect_urls = ARRAY['http://localhost:3000/cb'] WHERE id = $1`, [otherEnv]);
    try {
      const link = await connect.createConnectLink(dev, "alice", { integration: "hubspot", redirectUrl: "http://localhost:3000/cb" });
      const landed = await completeLink(link.url);
      expect(landed.searchParams.get("anlyon_status")).toBe("connected");
      expect(await connections.endUserCredential(dev, "hubspot", "alice")).toBe(oauth.latest().accessToken);
    } finally {
      await sql(`UPDATE environments SET connect_confirmation = 'required', allowed_redirect_urls = '{}' WHERE id = $1`, [otherEnv]);
    }
  });

  it("keeps tokens encrypted at rest, bound to their row", async () => {
    await connectHubspot("alice");
    await connections.setEndUserApiKey(scope, "alice", "github", "ghp_alice_token_000000", actor);
    const { rows } = await sql("SELECT id, access_token_encrypted, refresh_token_encrypted FROM oauth_connections");
    for (const row of rows) {
      expect(String(row.access_token_encrypted).startsWith("v3.")).toBe(true);
      expect(String(row.access_token_encrypted)).not.toContain("ghp_alice");
      expect(String(row.access_token_encrypted)).not.toContain(oauth.latest().accessToken);
    }
    const [a, b] = rows;
    await sql("UPDATE oauth_connections SET access_token_encrypted = $1 WHERE id = $2", [a.access_token_encrypted, b.id]);
    await expect(connections.endUserCredential(scope, "github", "alice")).rejects.toThrow();
  });
});

describe("the two 409s", () => {
  it("END_USER_NOT_CONNECTED carries a fresh link on the default redirect, reused while it is live", async () => {
    const error = await connections.endUserCredential(scope, "hubspot", "alice").catch((e) => e);
    expect(error).toMatchObject({ statusCode: 409, code: "END_USER_NOT_CONNECTED", integration: "hubspot", endUserId: "alice" });
    const body = error.toJSON().error;
    expect(body.connectUrl).toMatch(/\/api\/v2\/connection-consent\/link\?token=cst_/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const again = await connections.endUserCredential(scope, "hubspot", "alice").catch((e) => e);
    expect(again.toJSON().error.connectUrl).toBe(body.connectUrl);
    const landed = await completeLink(body.connectUrl);
    await connect.confirmConnection(scope, "alice", landed.searchParams.get("anlyon_flow")!, actor);
    expect(await connections.endUserCredential(scope, "hubspot", "alice")).toBe(oauth.latest().accessToken);
  });

  it("END_USER_RECONNECT_REQUIRED when the provider refused the grant, also with a link", async () => {
    await connectHubspot("alice");
    oauth.revoke();
    await sql("UPDATE oauth_connections SET expires_at = now() - interval '1 minute'");
    const error = await connections.endUserCredential(scope, "hubspot", "alice").catch((e) => e);
    expect(error).toMatchObject({ statusCode: 409, code: "END_USER_RECONNECT_REQUIRED" });
    expect(error.toJSON().error.connectUrl).toBeTruthy();
    expect(await connections.listEndUserConnections(scope, "alice")).toMatchObject([{ status: "needs_reconnect" }]);
    await expect(connections.assertEndUserConnected(scope, "alice", ["hubspot"])).rejects.toMatchObject({ code: "END_USER_RECONNECT_REQUIRED" });
  });

  it("without a default redirect the 409 says how to get one and carries no link", async () => {
    const error = await connections.endUserCredential({ workspaceId: ws, environmentId: otherEnv }, "hubspot", "alice").catch((e) => e);
    expect(error.toJSON().error).not.toHaveProperty("connectUrl");
    expect(error.message).toMatch(/default redirect URL/);
  });
});

describe("per-end-user impact limits", () => {
  it("counts each end user on their own allowance; calls with no end user share one", async () => {
    const limit = await impact.createLimit(ws, env, { name: "Emails per user per day", dimension: "emails", period: "day", amount: 2, scope: "end_user" });
    expect(limit.scope.kind).toBe("end_user");
    const { rows: [action] } = await sql(
      `INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template) VALUES ($1, $2, 'act_mail', 'send-email', 'https://mail.test/send') RETURNING id`,
      [ws, env],
    );
    let n = 0;
    const reserve = async (endUserId: string | null) => {
      n++;
      const { rows: [inv] } = await sql(
        `INSERT INTO action_invocations (workspace_id, environment_id, action_id, invocation_id, end_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [ws, env, action.id, `inv_lim_${n}`, endUserId],
      );
      const { rows: [effect] } = await sql(
        `INSERT INTO action_effects (workspace_id, environment_id, action_id, invocation_id, effect_id, operation_key, request_digest, action_name,
           action_version_id, adapter_type, adapter_version, target_account, resource_key, target, request, impact, capabilities, stage, end_user_id)
         VALUES ($1, $2, $3, $4, $5, $5, 'd', 'send-email', 'acv_1', 'http_declared', '1', 'mail', 'mail:x', '{}', '{}', '[]', '{}', 'ready', $6) RETURNING id`,
        [ws, env, action.id, inv.id, `eff_lim_${n}`, endUserId],
      );
      return db.transaction((tx) => impact.reserveImpactIn(tx, effect.id as string, {
        workspaceId: ws, environmentId: env, actionName: "send-email", resourceKey: "mail:x",
        impact: [{ dimension: "emails", amount: 1 }] as never, dimensions: ["emails"], endUserId,
      }, new Date()));
    };

    await reserve("alice");
    await reserve("alice");
    await expect(reserve("alice")).rejects.toMatchObject({ reason: "impact_limit_exceeded" });
    await reserve("bob");
    await reserve(null);
    await reserve(null);
    await expect(reserve(null)).rejects.toMatchObject({ reason: "impact_limit_exceeded" });

    const [forAlice] = await impact.listLimits(ws, env, { endUserId: "alice" });
    expect(forAlice).toMatchObject({ reserved: 2, available: 0 });
    const [forBob] = await impact.listLimits(ws, env, { endUserId: "bob" });
    expect(forBob).toMatchObject({ reserved: 1, available: 1 });
    const { rows } = await sql("SELECT period_key FROM impact_limit_periods");
    expect(rows.map((r) => r.period_key).join()).not.toContain("alice");
  });
});

describe("invoking for an end user", () => {
  async function action(name: string, headers: Record<string, string>, requiresApproval = false) {
    await sql(
      `INSERT INTO actions (workspace_id, environment_id, action_id, name, method, url_template, headers, requires_approval)
       VALUES ($1, $2, $3, $4, 'GET', 'https://api.github.com/user', $5, $6)`,
      [ws, env, `act_${name}`, name, JSON.stringify(headers), requiresApproval],
    );
  }

  it("answers 409 with a connect link before recording anything, then sends the end user's own token", async () => {
    await action("whoami", { Authorization: "Bearer {{connection:github}}" });
    state.sent = [];
    await expect(invokeAction(ws, "whoami", {}, { environmentId: env, endUser: { endUserId: "alice", required: false } }))
      .rejects.toMatchObject({ statusCode: 409, code: "END_USER_NOT_CONNECTED", integration: "github" });
    expect((await sql("SELECT count(*)::int AS n FROM action_invocations i JOIN actions a ON a.id = i.action_id WHERE a.name = 'whoami'")).rows[0].n).toBe(0);

    await connections.setEndUserApiKey(scope, "alice", "github", "ghp_alice_token_000000", actor);
    await connections.setEndUserApiKey(scope, "bob", "github", "ghp_bob_token_00000000", actor);
    const result = await invokeAction(ws, "whoami", {}, { environmentId: env, endUser: { endUserId: "alice", required: false } });
    expect(result).toMatchObject({ status: "succeeded", endUserId: "alice" });
    expect(state.sent).toEqual([{ url: "https://api.github.com/user", authorization: "Bearer ghp_alice_token_000000" }]);

    await expect(invokeAction(ws, "whoami", {}, { environmentId: env, endUser: { endUserId: null, required: true } }))
      .rejects.toMatchObject({ code: "END_USER_REQUIRED" });
    expect(state.sent).toHaveLength(1);
  });

  it("parks a call under an end-user policy as that end user's approval, out of the team inbox", async () => {
    await action("send-mail", { Authorization: "Bearer {{connection:github}}" }, true);
    await sql(`INSERT INTO approval_policies (workspace_id, environment_id, policy_id, name, match_kind, match_action_name, effect, decided_by, required_approvals)
      VALUES ($1, $2, 'apol_eu', 'End users decide mail', 'action', 'send-mail', 'require_approval', 'end_user', 2)`, [ws, env]);
    await connections.setEndUserApiKey(scope, "alice", "github", "ghp_alice_token_000000", actor);
    state.sent = [];

    const parked = await invokeAction(ws, "send-mail", {}, { environmentId: env, endUser: { endUserId: "alice", required: false } });
    expect(parked).toMatchObject({ status: "pending_approval", pendingApproval: true, endUserId: "alice" });
    const mine = await approvalsService.listEndUserApprovals(scope, "alice");
    expect(mine.approvals).toMatchObject([{ id: parked.approvalId, decider: "end_user", endUserId: "alice", requiredApprovals: 1 }]);
    expect((await approvalsService.listEndUserApprovals(scope, "bob")).approvals).toEqual([]);
    expect((await approvalsService.listApprovals(ws, { environmentId: env })).approvals.map((a) => a.id)).not.toContain(parked.approvalId);

    const team = await invokeAction(ws, "send-mail", {}, { environmentId: env });
    expect((await approvalsService.getApproval(ws, team.approvalId!, env)).decider).toBe("team");

    await expect(approvalsService.approveApproval(ws, parked.approvalId!, { deciderKeyId: actor.id, endUserId: "bob" }, env)).rejects.toMatchObject({ statusCode: 404 });
    const decided = await approvalsService.approveApproval(ws, parked.approvalId!, { deciderKeyId: actor.id, endUserId: "alice" }, env);
    expect(decided.approval.status).toBe("approved");
    expect(decided.invocation).toMatchObject({ status: "succeeded", endUserId: "alice" });
    expect(state.sent).toEqual([{ url: "https://api.github.com/user", authorization: "Bearer ghp_alice_token_000000" }]);
    await sql("DELETE FROM approval_policies WHERE policy_id = 'apol_eu'");
  });

  it("with no policy, the workspace default says whether a user's call goes to the user or the team", async () => {
    await action("send-note", { Authorization: "Bearer {{connection:github}}" }, true);
    await connections.setEndUserApiKey(scope, "alice", "github", "ghp_alice_token_000000", actor);
    const forAlice = () => invokeAction(ws, "send-note", {}, { environmentId: env, endUser: { endUserId: "alice", required: false } });
    const aliceDecides = async (approvalId: string) =>
      (await approvalsService.listEndUserApprovals(scope, "alice")).approvals.some((a) => a.id === approvalId);

    const before = await forAlice();
    expect((await approvalsService.getApproval(ws, before.approvalId!, env)).decider).toBe("team");

    await sql("INSERT INTO workspace_defaults (workspace_id, acting_for) VALUES ($1, 'users')", [ws]);
    expect((await approvalsService.getApproval(ws, (await forAlice()).approvalId!, env)).decider).toBe("team");

    await sql("UPDATE workspace_defaults SET end_user_decider = 'end_user' WHERE workspace_id = $1", [ws]);
    const after = await forAlice();
    expect(after).toMatchObject({ status: "pending_approval", endUserId: "alice" });
    expect(await aliceDecides(after.approvalId!)).toBe(true);
    expect((await approvalsService.listApprovals(ws, { environmentId: env })).approvals.map((a) => a.id)).not.toContain(after.approvalId);

    const team = await invokeAction(ws, "send-note", {}, { environmentId: env });
    expect((await approvalsService.getApproval(ws, team.approvalId!, env)).decider).toBe("team");

    await sql(`INSERT INTO approval_policies (workspace_id, environment_id, policy_id, name, match_kind, match_action_name, effect, decided_by, required_approvals)
      VALUES ($1, $2, 'apol_team_note', 'Team decides notes', 'action', 'send-note', 'require_approval', 'team', 1)`, [ws, env]);
    const underPolicy = await forAlice();
    expect((await approvalsService.getApproval(ws, underPolicy.approvalId!, env)).decider).toBe("team");

    await sql("DELETE FROM approval_policies WHERE policy_id = 'apol_team_note'");
    await sql("DELETE FROM workspace_defaults WHERE workspace_id = $1", [ws]);
    await sql("UPDATE approvals SET status = 'expired' WHERE workspace_id = $1 AND status = 'pending'", [ws]);
  });
});

describe("erasing an end user", () => {
  it("removes accounts, counters and pending approvals, and keeps records under a hash", async () => {
    await connectHubspot("erin");
    await connections.setEndUserApiKey(scope, "erin", "github", "ghp_erin_token_0000000", actor);
    await connections.setEndUserApiKey(scope, "frank", "github", "ghp_frank_token_000000", actor);
    const { rows: [action] } = await sql(
      `INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template) VALUES ($1, $2, 'act_erase', 'erase-me', 'https://mail.test/x') RETURNING id`,
      [ws, env],
    );
    await sql(`INSERT INTO action_invocations (workspace_id, environment_id, action_id, invocation_id, end_user_id, status, approval_id)
      VALUES ($1, $2, $3, 'inv_erin_1', 'erin', 'pending_approval', 'apr_erin_1'), ($1, $2, $3, 'inv_frank_1', 'frank', 'succeeded', NULL)`, [ws, env, action.id]);
    await sql(`INSERT INTO approvals (workspace_id, environment_id, approval_id, kind, status, title, payload, expires_at, end_user_id, decided_by)
      VALUES ($1, $2, 'apr_erin_1', 'action', 'pending', 'Run', '{"actionName": "erase-me", "endUserId": "erin", "input": {"to": "x"}}', now() + interval '1 day', 'erin', 'end_user')`, [ws, env]);
    await sql(`INSERT INTO audit_events (event_id, workspace_id, environment_id, type, category, actor_type, occurred_at, end_user_id, resource_type, resource_id)
      VALUES ('aud_erin_1', $1, $2, 'end_user.connected', 'connection', 'system', now(), 'erin', 'end_user', 'erin'),
             ('aud_erin_2', $1, $2, 'approval.requested', 'approval', 'system', now(), 'erin', 'approval', 'apr_erin_1')`, [ws, env]);
    const limit = await impact.createLimit(ws, env, { name: "Per user erase", dimension: "sends", period: "day", amount: 5, scope: "end_user" });
    const { rows: [limitRow] } = await sql("SELECT id FROM impact_limits WHERE limit_id = $1", [limit.id]);
    const { endUserCounterTag } = await import("../src/core/end-users/identity.ts");
    await sql("INSERT INTO impact_limit_periods (limit_id, period_key, consumed) VALUES ($1, $2, 3), ($1, $3, 1)",
      [limitRow.id, `day:2026-10-24|${endUserCounterTag("erin")}`, `day:2026-10-24|${endUserCounterTag("frank")}`]);

    const result = await connections.eraseEndUser(scope, "erin", actor, approvalsService.cancelEndUserApprovals);
    expect(result).toMatchObject({ connectionsDeleted: 2, approvalsCancelled: 1, countersCleared: 1 });
    expect(result.erasedAs).toMatch(/^erased~[0-9a-f]{32}$/);

    expect(await connections.listEndUserConnections(scope, "erin")).toEqual([]);
    expect(await connections.listEndUserConnections(scope, "frank")).toHaveLength(1);
    expect(oauth.revocations).toBe(1);
    const { rows: invocations } = await sql("SELECT invocation_id, end_user_id, status FROM action_invocations WHERE action_id = $1 ORDER BY invocation_id", [action.id]);
    expect(invocations).toEqual([
      { invocation_id: "inv_erin_1", end_user_id: result.erasedAs, status: "denied" },
      { invocation_id: "inv_frank_1", end_user_id: "frank", status: "succeeded" },
    ]);
    const { rows: [approval] } = await sql("SELECT status, decision_origin, end_user_id, payload FROM approvals WHERE approval_id = 'apr_erin_1'");
    expect(approval).toEqual({
      status: "denied", decision_origin: "system", end_user_id: result.erasedAs,
      payload: { actionName: "erase-me", endUserId: result.erasedAs, input: { to: "x" } },
    });
    const { rows: audits } = await sql("SELECT event_id, end_user_id, resource_type, resource_id FROM audit_events WHERE event_id IN ('aud_erin_1', 'aud_erin_2') ORDER BY event_id");
    expect(audits).toEqual([
      { event_id: "aud_erin_1", end_user_id: result.erasedAs, resource_type: "end_user", resource_id: result.erasedAs },
      { event_id: "aud_erin_2", end_user_id: result.erasedAs, resource_type: "approval", resource_id: "apr_erin_1" },
    ]);
    const { rows: periods } = await sql("SELECT period_key FROM impact_limit_periods WHERE limit_id = $1", [limitRow.id]);
    expect(periods.map((p) => p.period_key)).toEqual([`day:2026-10-24|${endUserCounterTag("frank")}`]);
    expect((await connections.listEndUsers(scope)).endUsers.map((u) => u.endUserId)).not.toContain("erin");

    await expect(sql("UPDATE audit_events SET type = 'x' WHERE event_id = 'aud_erin_1'")).rejects.toThrow(/immutable/);
    await expect(sql("UPDATE audit_events SET end_user_id = 'someone' WHERE event_id = 'aud_erin_1'")).rejects.toThrow(/immutable/);
    await expect(sql("UPDATE audit_events SET resource_id = 'other' WHERE event_id = 'aud_erin_1'")).rejects.toThrow(/immutable/);
    await sql(`INSERT INTO audit_events (event_id, workspace_id, environment_id, type, category, actor_type, occurred_at, end_user_id, resource_type, resource_id)
      VALUES ('aud_erin_3', $1, $2, 'end_user.connected', 'connection', 'system', now(), 'erin', 'end_user', 'frank')`, [ws, env]);
    await expect(sql("UPDATE audit_events SET end_user_id = 'erased~x', resource_id = 'erased~x' WHERE event_id = 'aud_erin_3'")).rejects.toThrow(/immutable/);
    await expect(sql("UPDATE audit_events SET end_user_id = 'erased~x', resource_id = 'erased~y' WHERE event_id = 'aud_erin_1'")).rejects.toThrow(/immutable/);
  });

  it("lists end users with counts, a page at a time", async () => {
    await connections.setEndUserApiKey(scope, "u1", "github", "ghp_u1_token_000000000", actor);
    await connections.setEndUserApiKey(scope, "u2", "github", "ghp_u2_token_000000000", actor);
    const first = await connections.listEndUsers(scope, { limit: 1, prefix: "u" });
    expect(first.endUsers).toEqual([{ endUserId: "u1", connections: 1, invocations: 0, pendingApprovals: 0 }]);
    const second = await connections.listEndUsers(scope, { limit: 1, prefix: "u", cursor: first.nextCursor! });
    expect(second.endUsers.map((u) => u.endUserId)).toEqual(["u2"]);
    expect(second.nextCursor).toBeNull();
  });
});
