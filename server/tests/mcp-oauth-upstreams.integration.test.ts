import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { providerFetch, setProviderFetchForHost } from "./support/effects/provider-fetch.ts";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});
const flags = vi.hoisted(() => ({ mcpUpstreams: true }));
vi.mock("@anlyon/feature-flags", async (original) => ({
  ...(await original<typeof import("@anlyon/feature-flags")>()),
  isFeatureEnabled: (key: string) => (key === "mcp-upstreams" ? flags.mcpUpstreams : true),
}));

const vendorList = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("../src/core/connections/known-vendors.ts", () => {
  vendorList.list.push({ name: "Sim", domains: ["oauth.example"], server: { registryName: "example.oauth/mcp", url: "https://mcp.oauth.example/mcp" } });
  return { CHECKED_ON: "2026-11-02", KNOWN_VENDORS: vendorList.list, knownVendors: () => vendorList.list };
});

const { EffectScope, loadEffectModules } = await import("./support/effects/fixture.ts");
const { McpOAuthSimulator, MCP_OAUTH_HOST, MCP_OAUTH_URL, AS_HOST, AS_ISSUER } = await import("./support/effects/mcp-oauth-simulator.ts");
const { OAUTH_SIM_ENCRYPTION_KEY, OAUTH_SIM_ORIGIN } = await import("./support/effects/oauth-simulator.ts");
const { createNativeProvider, CONSENT_CALLBACK_PATH } = await import("../src/core/connections/native.ts");
const { setConnectionProviderForTests } = await import("../src/core/connections/provider.ts");
const upstreams = await import("../src/core/mcp-upstreams/service.ts");
const oauth = await import("../src/core/mcp-upstreams/oauth.ts");
const connect = await import("../src/core/end-users/connect.ts");
const sessionCache = await import("../src/core/mcp-upstreams/session-cache.ts");
const { default: consentRouter } = await import("../src/api/routes/connection-consent.ts");
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const { Hono } = await import("hono");
const connectionConsentRouter = new Hono().onError((err, c) => buildErrorResponse(err, c)).route("/", consentRouter);

const REDIRECT_URI = `${OAUTH_SIM_ORIGIN}${CONSENT_CALLBACK_PATH}`;
const APP_REDIRECT = "https://app.acme.test/connected";
const actor = { type: "api_key" as const, id: "00000000-0000-4000-8000-00000000aaaa" };

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("OAuth upstream MCP servers (real Postgres)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let m: Awaited<ReturnType<typeof loadEffectModules>>;
  let s: InstanceType<typeof EffectScope>;
  let sim: InstanceType<typeof McpOAuthSimulator>;
  const provider = () => createNativeProvider({ origin: OAUTH_SIM_ORIGIN, encryptionKey: OAUTH_SIM_ENCRYPTION_KEY, upstreamApp: oauth.upstreamApp });

  beforeAll(async () => {
    await pool.query("SELECT 1");
    m = await loadEffectModules();
  });
  beforeEach(async () => {
    s = await new EffectScope(pool, m).seed();
    await pool.query("UPDATE environments SET allowed_redirect_urls = ARRAY[$2], default_redirect_url = $2 WHERE id = $1", [s.environmentId, APP_REDIRECT]);
    sim = new McpOAuthSimulator({ clientId: "anlyon-test-client", redirectUri: REDIRECT_URI });
    sessionCache.clearSessionCache();
    setProviderFetchForHost(MCP_OAUTH_HOST, sim.fetch);
    setProviderFetchForHost(AS_HOST, sim.fetch);
    setConnectionProviderForTests(provider());
  });
  afterEach(async () => {
    flags.mcpUpstreams = true;
    setConnectionProviderForTests(undefined);
    await s.cleanup();
  });
  afterAll(async () => { await pool.end(); });

  const register = (client: Partial<{ clientId: string | null; clientSecret: string | null; redirectUri: string }> = {}) =>
    upstreams.registerUpstream(s.workspaceId, s.environmentId, { name: "tracker", url: MCP_OAUTH_URL, oauth: { clientId: "anlyon-test-client", ...client } }, m.actions.UNSCOPED_AUTHORITY);

  async function connectOperator(id: string, user = "operator") {
    const { url } = await upstreams.connectUpstream(s.workspaceId, s.environmentId, id);
    const p = provider();
    const authorize = await p.beginConsent(new URL(url).searchParams.get("token")!);
    const back = new URL(sim.approve(authorize!, user));
    const result = await p.finishConsent({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null });
    if (!result.ok) throw new Error(`consent failed: ${JSON.stringify(result)}`);
    return upstreams.recordOperatorConsent(result.outcome);
  }

  async function connectEndUser(id: string, endUserId: string, user = endUserId) {
    const link = await upstreams.createEndUserConnectLink(s.workspaceId, s.environmentId, id, { endUserId });
    const p = provider();
    const authorize = await p.beginConsent(new URL(link.url).searchParams.get("token")!);
    const back = new URL(sim.approve(authorize!, user));
    const result = await p.finishConsent({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null });
    if (!result.ok || !result.outcome.subject) throw new Error(`end-user consent failed: ${JSON.stringify(result)}`);
    const landed = new URL((await connect.recordEndUserConsent(result.outcome.subject, { status: "connected", connectionId: result.outcome.connectionId }))!);
    await connect.confirmConnection({ workspaceId: s.workspaceId, environmentId: s.environmentId }, endUserId, landed.searchParams.get("anlyon_flow")!, actor);
  }

  const asEndUser = (endUserId: string) => ({ endUser: { endUserId, required: false } });
  const codesOf = async (effectId: string) =>
    (await s.effect(effectId)).evidence.map((e: { details: Record<string, unknown> }) => e.details.code).filter(Boolean);

  it("registers from the 401 challenge's metadata, with a public client, and lists nothing until the operator connects", async () => {
    const upstream = await register();
    expect(upstream.oauth).toMatchObject({
      resource: MCP_OAUTH_URL,
      issuer: AS_ISSUER,
      tokenEndpoint: `${AS_ISSUER}/token`,
      clientId: "anlyon-test-client",
      publicClient: true,
      scopes: ["issues:read", "issues:write"],
      advertised: { dynamicRegistration: true, clientIdMetadataDocuments: false, pkceS256: true },
      redirectUri: REDIRECT_URI,
      operatorConnected: false,
    });
    expect(upstream.tools).toEqual([]);
    expect(upstream.listedWith).toBeNull();
    expect(upstream.headers).toEqual({});

    const listed = await connectOperator(upstream.id);
    expect(listed).toBe("connected");
    const after = await upstreams.getUpstream(s.workspaceId, s.environmentId, upstream.id);
    expect(after.lastError).toBeNull();
    expect(after.listedWith).toBe("operator");
    expect(after.oauth!.operatorConnected).toBe(true);
    expect(after.tools.map((t) => t.name)).toEqual(["create_issue", "list_issues"]);
    expect(sim.calls.filter((c) => c.method === "tools/list").at(-1)!.user).toBe("operator");
    const exchange = sim.tokenRequests.find((r) => r.grant_type === "authorization_code")!;
    expect(exchange).toMatchObject({ client_id: "anlyon-test-client", resource: MCP_OAUTH_URL });
    expect(exchange.code_verifier).toBeTruthy();
    expect(exchange.client_secret).toBeUndefined();
  });

  it("a server that lists without a sign-in is listed anonymously at registration, and the view says so", async () => {
    sim.listsAnonymously = true;
    const upstream = await register();
    expect(upstream.listedWith).toBe("anonymous");
    expect(upstream.tools.map((t) => t.name)).toEqual(["create_issue", "list_issues"]);
  });

  it("each end user's call carries their own token; a warm token is used as it is", async () => {
    const upstream = await register();
    await connectOperator(upstream.id);
    const [adopted] = (await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_issue: {} }, m.actions.UNSCOPED_AUTHORITY)).adopted;
    expect(adopted!.action.headers).toEqual({});
    await connectEndUser(upstream.id, "user-a");
    await connectEndUser(upstream.id, "user-b");
    const refreshesBefore = sim.tokenRequests.filter((r) => r.grant_type === "refresh_token").length;

    sim.calls = [];
    const a = await s.invoke("tracker-create_issue", { title: "From A" }, asEndUser("user-a"));
    expect(a.status).toBe("succeeded");
    const b = await s.invoke("tracker-create_issue", { title: "From B" }, asEndUser("user-b"));
    expect(b.status).toBe("succeeded");
    expect(sim.calls.filter((c) => c.method === "tools/call").map((c) => c.user)).toEqual(["user-a", "user-b"]);
    expect(new Set(sim.calls.map((c) => c.user))).toEqual(new Set(["user-a", "user-b"]));
    expect(sim.tokenRequests.filter((r) => r.grant_type === "refresh_token").length).toBe(refreshesBefore);

    const effectA = await s.effect(a.effectId!);
    const effectB = await s.effect(b.effectId!);
    const key = oauth.upstreamIntegrationKey((await pool.query("SELECT id FROM mcp_upstreams WHERE upstream_id = $1", [upstream.id])).rows[0].id);
    expect(effectA.request.headers).toEqual({ Authorization: `Bearer {{connection:${key}}}` });
    expect(effectB.request.headers).toEqual(effectA.request.headers);
    expect(JSON.stringify(effectA)).not.toMatch(/at_[0-9a-f]{32}/);

    sim.calls = [];
    expect((await s.invoke("tracker-create_issue", { title: "From the operator" })).status).toBe("succeeded");
    expect(sim.calls.find((c) => c.method === "tools/call")!.user).toBe("operator");
  });

  it("an expired token is refreshed once before tools/list, and the call goes through", async () => {
    const upstream = await register();
    await connectOperator(upstream.id);
    await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_issue: {} }, m.actions.UNSCOPED_AUTHORITY);
    await connectEndUser(upstream.id, "user-a");
    sim.expire("user-a");
    await pool.query("UPDATE oauth_connections SET expires_at = now() - interval '1 minute' WHERE environment_id = $1 AND subject_end_user_id = 'user-a'", [s.environmentId]);

    sim.calls = [];
    sim.tokenRequests = [];
    const invocation = await s.invoke("tracker-create_issue", { title: "After expiry" }, asEndUser("user-a"));
    expect(invocation.status).toBe("succeeded");
    expect(sim.tokenRequests.map((r) => r.grant_type)).toEqual(["refresh_token"]);
    expect(sim.tokenRequests[0]).toMatchObject({ resource: MCP_OAUTH_URL, client_id: "anlyon-test-client" });
    expect(sim.calls.every((c) => c.user === "user-a")).toBe(true);
  });

  it("an end user who never connected is answered 409 with a link before anything is recorded, and connects through it", async () => {
    const upstream = await register();
    await connectOperator(upstream.id);
    await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_issue: {} }, m.actions.UNSCOPED_AUTHORITY);
    const key = oauth.upstreamIntegrationKey((await pool.query("SELECT id FROM mcp_upstreams WHERE upstream_id = $1", [upstream.id])).rows[0].id);
    const invocations = async () => Number((await pool.query("SELECT count(*)::int AS n FROM action_invocations WHERE workspace_id = $1", [s.workspaceId])).rows[0].n);
    const before = await invocations();
    sim.calls = [];
    const refused = await s.invoke("tracker-create_issue", { title: "Nobody" }, asEndUser("user-c")).catch((error: unknown) => error);
    expect(refused).toMatchObject({ statusCode: 409, code: "END_USER_NOT_CONNECTED", integration: key, displayName: "tracker", endUserId: "user-c" });
    const link = (refused as { link: { url: string } | null }).link;
    expect(link?.url).toMatch(/\?token=/);
    expect(sim.calls).toEqual([]);
    expect(await invocations()).toBe(before);

    const p = provider();
    const authorize = await p.beginConsent(new URL(link!.url).searchParams.get("token")!);
    const back = new URL(sim.approve(authorize!, "user-c"));
    const result = await p.finishConsent({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null });
    if (!result.ok || !result.outcome.subject) throw new Error(`end-user consent failed: ${JSON.stringify(result)}`);
    const landed = new URL((await connect.recordEndUserConsent(result.outcome.subject, { status: "connected", connectionId: result.outcome.connectionId }))!);
    await connect.confirmConnection({ workspaceId: s.workspaceId, environmentId: s.environmentId }, "user-c", landed.searchParams.get("anlyon_flow")!, actor);
    const sent = await s.invoke("tracker-create_issue", { title: "Now connected" }, asEndUser("user-c"));
    expect(sent.status).toBe("succeeded");
    expect(sim.calls.find((c) => c.method === "tools/call")!.user).toBe("user-c");
  });

  it("an end user's grant revoked while an approved call waits is refused at dispatch: no_connection, nothing sent", async () => {
    const upstream = await register();
    await connectOperator(upstream.id);
    await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_issue: { requiresApproval: true } }, m.actions.UNSCOPED_AUTHORITY);
    await connectEndUser(upstream.id, "user-a");
    const parked = await s.invoke("tracker-create_issue", { title: "Waits for review" }, asEndUser("user-a"));
    expect(parked.status).toBe("pending_approval");

    await pool.query("UPDATE oauth_connections SET revoked_at = now() WHERE environment_id = $1 AND subject_end_user_id = 'user-a'", [s.environmentId]);
    sim.calls = [];
    const decided = await m.approvals.approveApproval(s.workspaceId, parked.approvalId!, { deciderKeyId: randomUUID() }, s.environmentId);
    expect(decided.invocation?.status).toBe("failed");
    expect(sim.calls).toEqual([]);
    expect(await codesOf(parked.effectId!)).toContain("no_connection");

    await expect(s.invoke("tracker-create_issue", { title: "Again" }, asEndUser("user-a"))).rejects.toMatchObject({ code: "END_USER_RECONNECT_REQUIRED" });
  });

  it("a grant that can no longer be refreshed is refused before anything is sent: token_refresh_failed", async () => {
    const upstream = await register();
    await connectOperator(upstream.id);
    await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_issue: {} }, m.actions.UNSCOPED_AUTHORITY);
    await connectEndUser(upstream.id, "user-a");
    sim.revoke("user-a");
    await pool.query("UPDATE oauth_connections SET expires_at = now() - interval '1 minute' WHERE environment_id = $1 AND subject_end_user_id = 'user-a'", [s.environmentId]);
    sim.calls = [];
    const refused = await s.invoke("tracker-create_issue", { title: "Revoked" }, asEndUser("user-a"));
    expect(refused.status).toBe("failed");
    expect(sim.calls).toEqual([]);
    expect(await codesOf(refused.effectId!)).toContain("token_refresh_failed");
  });

  it("a confidential client's secret goes to the token endpoint only, and only when its secret may", async () => {
    await m.secrets.putSecret(s.workspaceId, "TRACKER_CLIENT_SECRET", { value: "sim-client-secret-000000", allowedHosts: ["elsewhere.example"] }, s.environmentId);
    await expect(register({ clientSecret: "{{secret:TRACKER_CLIENT_SECRET}}" })).rejects.toThrow();
    await m.secrets.putSecret(s.workspaceId, "TRACKER_ANY_HOST", { value: "sim-client-secret-000000" }, s.environmentId);
    await expect(register({ clientSecret: "{{secret:TRACKER_ANY_HOST}}" })).rejects.toMatchObject({ reason: "client_secret_unbound" });
    await m.secrets.putSecret(s.workspaceId, "TRACKER_CLIENT_SECRET", { value: "sim-client-secret-000000", allowedHosts: [AS_HOST] }, s.environmentId);
    sim = new McpOAuthSimulator({ clientId: "anlyon-test-client", clientSecret: "sim-client-secret-000000", redirectUri: REDIRECT_URI });
    setProviderFetchForHost(MCP_OAUTH_HOST, sim.fetch);
    setProviderFetchForHost(AS_HOST, sim.fetch);
    const upstream = await register({ clientSecret: "{{secret:TRACKER_CLIENT_SECRET}}" });
    expect(upstream.oauth!.publicClient).toBe(false);
    expect(JSON.stringify(upstream)).not.toContain("sim-client-secret-000000");
    expect(await connectOperator(upstream.id)).toBe("connected");
    expect(sim.tokenRequests.find((r) => r.grant_type === "authorization_code")!.client_secret).toBe("sim-client-secret-000000");
  });

  it("refuses what it does not run, by name", async () => {
    await expect(upstreams.registerUpstream(s.workspaceId, s.environmentId, { name: "tracker", url: MCP_OAUTH_URL }, m.actions.UNSCOPED_AUTHORITY))
      .rejects.toMatchObject({ reason: "oauth_required" });
    sim.asMetadata = { ...sim.asMetadata, registration_endpoint: "http://auth.oauth.example/register" };
    await expect(register({ clientId: null })).rejects.toMatchObject({ reason: "registration_mode_unsupported" });
    sim.asMetadata = { ...sim.asMetadata, registration_endpoint: undefined };
    await expect(register({ clientId: null })).rejects.toMatchObject({ reason: "client_required" });
    sim.asMetadata = { ...sim.asMetadata, registration_endpoint: `${AS_ISSUER}/register` };
    await expect(register({ clientId: "https://anlyon.example/client.json" })).rejects.toMatchObject({ reason: "cimd_unsupported" });
    await expect(register({ redirectUri: "https://elsewhere.example/callback" })).rejects.toMatchObject({ reason: "redirect_uri_not_owned" });
    sim.prm = { ...sim.prm, resource: "https://other.example/mcp" };
    await expect(register()).rejects.toMatchObject({ reason: "resource_mismatch" });
    sim.prm = { ...sim.prm, resource: MCP_OAUTH_URL, authorization_servers: ["http://auth.oauth.example"] };
    await expect(register()).rejects.toMatchObject({ reason: "not_https" });
    sim.prm = { ...sim.prm, authorization_servers: [AS_ISSUER] };
    sim.asMetadata = { ...sim.asMetadata, code_challenge_methods_supported: ["plain"] };
    await expect(register()).rejects.toMatchObject({ reason: "pkce_unsupported" });
    sim.asMetadata = { ...sim.asMetadata, code_challenge_methods_supported: ["S256"], grant_types_supported: ["urn:ietf:params:oauth:grant-type:token-exchange"] };
    await expect(register()).rejects.toMatchObject({ reason: "authorization_code_unsupported" });
    expect(sim.calls.filter((c) => c.method === "tools/call")).toEqual([]);
  });

  it("an upstream archived while an approved call waits lends no token: no_connection, nothing sent", async () => {
    const upstream = await register();
    await connectOperator(upstream.id);
    await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_issue: { requiresApproval: true } }, m.actions.UNSCOPED_AUTHORITY);
    await connectEndUser(upstream.id, "user-a");
    const parked = await s.invoke("tracker-create_issue", { title: "Waits for review" }, asEndUser("user-a"));
    expect(parked.status).toBe("pending_approval");

    await upstreams.archiveUpstream(s.workspaceId, s.environmentId, upstream.id);
    sim.calls = [];
    sim.tokenRequests = [];
    const decided = await m.approvals.approveApproval(s.workspaceId, parked.approvalId!, { deciderKeyId: randomUUID() }, s.environmentId);
    expect(decided.invocation?.status).toBe("failed");
    expect(sim.calls).toEqual([]);
    expect(sim.tokenRequests).toEqual([]);
    expect(await codesOf(parked.effectId!)).toContain("no_connection");
  });

  it("an archived upstream lends no token even where its adopted action is still enabled", async () => {
    const upstream = await register();
    await connectOperator(upstream.id);
    await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_issue: { requiresApproval: true } }, m.actions.UNSCOPED_AUTHORITY);
    await connectEndUser(upstream.id, "user-a");
    const parked = await s.invoke("tracker-create_issue", { title: "Waits for review" }, asEndUser("user-a"));
    await pool.query("UPDATE mcp_upstreams SET archived_at = now() WHERE upstream_id = $1", [upstream.id]);
    sim.calls = [];
    const decided = await m.approvals.approveApproval(s.workspaceId, parked.approvalId!, { deciderKeyId: randomUUID() }, s.environmentId);
    expect(decided.invocation?.status).toBe("failed");
    expect(sim.calls).toEqual([]);
    expect(await codesOf(parked.effectId!)).toContain("no_connection");
  });

  it("a grant whose binding fails is revoked, and the upstream keeps no operator", async () => {
    const upstream = await register();
    const rowId = (await pool.query("SELECT id FROM mcp_upstreams WHERE upstream_id = $1", [upstream.id])).rows[0].id as string;
    const fn = `fail_bind_${rowId.replace(/-/g, "")}`;
    await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'bind refused for test'; END $$`);
    await pool.query(
      `CREATE TRIGGER ${fn} BEFORE UPDATE OF operator_connection_id ON mcp_upstreams FOR EACH ROW WHEN (NEW.id = '${rowId}') EXECUTE FUNCTION ${fn}()`,
    );
    try {
      await expect(connectOperator(upstream.id)).rejects.toThrow();
    } finally {
      await pool.query(`DROP TRIGGER ${fn} ON mcp_upstreams`);
      await pool.query(`DROP FUNCTION ${fn}()`);
    }
    const key = oauth.upstreamIntegrationKey(rowId);
    expect((await pool.query("SELECT 1 FROM oauth_connections WHERE environment_id = $1 AND integration_key = $2", [s.environmentId, key])).rowCount).toBe(0);
    expect((await upstreams.getUpstream(s.workspaceId, s.environmentId, upstream.id)).oauth!.operatorConnected).toBe(false);
    expect(await connectOperator(upstream.id)).toBe("connected");
  });

  it("without a client id, a server that is no verified vendor's is not lent this deployment's own", async () => {
    sim.asMetadata = { ...sim.asMetadata, client_id_metadata_document_supported: true, registration_endpoint: undefined };
    const saved = vendorList.list.splice(0);
    try {
      await expect(register({ clientId: null })).rejects.toMatchObject({ reason: "client_required" });
    } finally {
      vendorList.list.push(...saved);
    }
  });

  it("an upstream that has this deployment's client stops lending it once its endpoint is no longer a verified vendor's", async () => {
    sim.asMetadata = { ...sim.asMetadata, client_id_metadata_document_supported: true };
    const upstream = await register({ clientId: null });
    const [row] = (await pool.query<{ id: string }>("SELECT id FROM mcp_upstreams WHERE upstream_id = $1", [upstream.id])).rows;
    const key = oauth.upstreamIntegrationKey(row!.id);
    expect(await oauth.upstreamApp(key, s.environmentId)).toMatchObject({ namesDeveloper: false });
    const saved = vendorList.list.splice(0);
    try {
      expect(await oauth.upstreamApp(key, s.environmentId)).toBeNull();
    } finally {
      vendorList.list.push(...saved);
    }
  });

  it("without a client id, a server that accepts metadata documents gets this deployment's own, end to end", async () => {
    sim.asMetadata = { ...sim.asMetadata, client_id_metadata_document_supported: true };
    const served = await connectionConsentRouter.request("/mcp-client.json");
    expect(served.status).toBe(200);
    const doc = (await served.json()) as Record<string, unknown>;
    const documentUrl = `${OAUTH_SIM_ORIGIN}/api/v2/connection-consent/mcp-client.json`;
    expect(doc).toEqual({
      client_id: documentUrl,
      client_name: "Anlyon",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    sim.clientDocuments.set(documentUrl, doc);
    flags.mcpUpstreams = false;
    expect((await connectionConsentRouter.request("/mcp-client.json")).status).toBe(404);
    flags.mcpUpstreams = true;

    await expect(register({ clientId: null, clientSecret: "{{secret:ANY}}" })).rejects.toMatchObject({ reason: "cimd_secret" });
    const upstream = await register({ clientId: null });
    expect(upstream.oauth).toMatchObject({ clientRegistration: "client_metadata_document", clientId: documentUrl, publicClient: true });

    expect(await connectOperator(upstream.id)).toBe("connected");
    await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_issue: {} }, m.actions.UNSCOPED_AUTHORITY);
    await connectEndUser(upstream.id, "user-a");
    sim.calls = [];
    expect((await s.invoke("tracker-create_issue", { title: "By document" }, asEndUser("user-a"))).status).toBe("succeeded");
    expect(sim.calls.find((c) => c.method === "tools/call")!.user).toBe("user-a");
    expect(sim.tokenRequests.length).toBeGreaterThan(0);
    expect(sim.tokenRequests.every((r) => r.client_id === documentUrl && r.client_secret === undefined)).toBe(true);

    sim.clientDocuments.set(documentUrl, { ...doc, client_id: "https://elsewhere.example/client.json" });
    await expect(connectEndUser(upstream.id, "user-b")).rejects.toThrow(/another client_id/);
  });

  it("without a client id or a metadata document, a public client is registered dynamically, end to end", async () => {
    const upstream = await register({ clientId: null });
    expect(upstream.oauth).toMatchObject({ clientRegistration: "dynamic", publicClient: true });
    const clientId = upstream.oauth!.clientId;
    expect(clientId).toMatch(/^dcr-/);
    expect(sim.registrations).toEqual([{
      client_name: "Anlyon",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "issues:read issues:write",
    }]);
    expect(JSON.stringify((await pool.query("SELECT oauth FROM mcp_upstreams WHERE upstream_id = $1", [upstream.id])).rows[0])).not.toContain("rat_not_kept");

    expect(await connectOperator(upstream.id)).toBe("connected");
    await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_issue: {} }, m.actions.UNSCOPED_AUTHORITY);
    await connectEndUser(upstream.id, "user-a");
    sim.calls = [];
    expect((await s.invoke("tracker-create_issue", { title: "Dynamic" }, asEndUser("user-a"))).status).toBe("succeeded");
    expect(sim.calls.find((c) => c.method === "tools/call")!.user).toBe("user-a");
    expect(sim.tokenRequests.every((r) => r.client_id === clientId && r.client_secret === undefined && r.basic_client_secret === undefined)).toBe(true);
  });

  it("a server that insists on a confidential client: its secret goes to the vault, bound to the token endpoint, and is sent as it assigned", async () => {
    sim.dcr = { mode: "confidential", method: "client_secret_basic" };
    const upstream = await register({ clientId: null });
    expect(upstream.oauth).toMatchObject({ clientRegistration: "dynamic", publicClient: false });
    const [secret] = (await pool.query(
      "SELECT name, allowed_hosts FROM workspace_secrets WHERE workspace_id = $1 AND name LIKE 'MCP_TRACKER_CLIENT_SECRET_%'", [s.workspaceId],
    )).rows as Array<{ name: string; allowed_hosts: string[] }>;
    expect(secret!.allowed_hosts).toEqual([AS_HOST]);
    expect(JSON.stringify(upstream)).not.toContain("dcr_secret_");

    expect(await connectOperator(upstream.id)).toBe("connected");
    const exchange = sim.tokenRequests.find((r) => r.grant_type === "authorization_code")!;
    expect(exchange.basic_client_secret).toMatch(/^dcr_secret_/);
    expect(exchange.client_secret).toBeUndefined();
  });

  it("refuses a registration that fails or drops the redirect URI, and keeps no secret when the upstream is not stored", async () => {
    sim.dcr = { mode: "fail" };
    await expect(register({ clientId: null })).rejects.toMatchObject({ reason: "dcr_failed" });
    sim.dcr = { mode: "public", dropRedirect: true };
    await expect(register({ clientId: null })).rejects.toMatchObject({ reason: "dcr_redirect_mismatch" });
    await expect(register({ clientId: null, clientSecret: "{{secret:ANY}}" })).rejects.toMatchObject({ reason: "dcr_secret" });

    sim.dcr = { mode: "confidential" };
    const fn = `fail_insert_${s.workspaceId.replace(/-/g, "")}`;
    await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'insert refused for test'; END $$`);
    await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON mcp_upstreams FOR EACH ROW WHEN (NEW.workspace_id = '${s.workspaceId}') EXECUTE FUNCTION ${fn}()`);
    try {
      await expect(register({ clientId: null })).rejects.toThrow();
    } finally {
      await pool.query(`DROP TRIGGER ${fn} ON mcp_upstreams`);
      await pool.query(`DROP FUNCTION ${fn}()`);
    }
    expect(sim.registrations.length).toBeGreaterThan(0);
    expect((await pool.query("SELECT 1 FROM workspace_secrets WHERE workspace_id = $1 AND name LIKE 'MCP_TRACKER_CLIENT_SECRET_%'", [s.workspaceId])).rowCount).toBe(0);
  });

  describe("a server that refuses the sign-in before the call", () => {
    const ready = async () => {
      const upstream = await register();
      await connectOperator(upstream.id);
      await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_issue: {} }, m.actions.UNSCOPED_AUTHORITY);
      await connectEndUser(upstream.id, "user-a");
      sim.calls = [];
      sim.tokenRequests = [];
      return upstream;
    };

    it("a token refused before its recorded expiry is refreshed once, and the call goes through", async () => {
      await ready();
      sim.expire("user-a");
      const invocation = await s.invoke("tracker-create_issue", { title: "After a 401" }, asEndUser("user-a"));
      expect(invocation.status).toBe("succeeded");
      expect(sim.tokenRequests.map((r) => r.grant_type)).toEqual(["refresh_token"]);
      expect(sim.calls.filter((c) => c.method === "tools/call").map((c) => c.user)).toEqual(["user-a"]);
      expect(sim.calls[0]!.user).toBeNull();
      expect(sim.calls.slice(1).every((c) => c.user === "user-a")).toBe(true);
    });

    it("a refresh that fails: token_refresh_failed, nothing sent", async () => {
      await ready();
      sim.revoke("user-a");
      const refused = await s.invoke("tracker-create_issue", { title: "Revoked" }, asEndUser("user-a"));
      expect(refused.status).toBe("failed");
      expect(sim.calls.map((c) => c.method)).not.toContain("tools/call");
      expect(await codesOf(refused.effectId!)).toContain("token_refresh_failed");
    });

    it("a refreshed token refused again: unauthorized, refreshed once only, nothing sent", async () => {
      await ready();
      sim.rejectUsers.add("user-a");
      const refused = await s.invoke("tracker-create_issue", { title: "Refused" }, asEndUser("user-a"));
      expect(refused.status).toBe("failed");
      expect(sim.tokenRequests.filter((r) => r.grant_type === "refresh_token")).toHaveLength(1);
      expect(sim.calls.map((c) => c.method)).not.toContain("tools/call");
      expect(await codesOf(refused.effectId!)).toContain("unauthorized");
    });

    it("more scope needed before the call: insufficient_scope with the scope, nothing sent", async () => {
      await ready();
      sim.insufficientScope = { method: "tools/list", scope: "issues:admin" };
      const refused = await s.invoke("tracker-create_issue", { title: "Scope" }, asEndUser("user-a"));
      expect(refused.status).toBe("failed");
      expect(sim.calls.map((c) => c.method)).not.toContain("tools/call");
      expect(await codesOf(refused.effectId!)).toContain("insufficient_scope");
      expect(sim.tokenRequests).toEqual([]);
    });

    it("more scope needed by the call itself: failed with the scope in the evidence, not repeated", async () => {
      await ready();
      sim.insufficientScope = { method: "tools/call", scope: "issues:admin" };
      const refused = await s.invoke("tracker-create_issue", { title: "Scope" }, asEndUser("user-a"));
      expect(refused.status).toBe("failed");
      expect(sim.calls.filter((c) => c.method === "tools/call")).toHaveLength(1);
      const details = (await s.effect(refused.effectId!)).evidence.map((e: { details: Record<string, unknown> }) => e.details);
      expect(details).toEqual(expect.arrayContaining([expect.objectContaining({ code: "insufficient_scope", requiredScope: "issues:admin", status: 403 })]));
    });
  });

  it("the operator chooses among the resource's authorization servers; an unlisted one is refused", async () => {
    sim.prm = { ...sim.prm, authorization_servers: ["https://auth.other.example", AS_ISSUER] };
    await expect(register()).rejects.toMatchObject({ reason: "metadata_unreachable" });
    await expect(upstreams.registerUpstream(s.workspaceId, s.environmentId, {
      name: "tracker", url: MCP_OAUTH_URL, oauth: { clientId: "anlyon-test-client", authorizationServer: "https://auth.elsewhere.example" },
    }, m.actions.UNSCOPED_AUTHORITY)).rejects.toMatchObject({ reason: "authorization_server_not_listed" });
    const upstream = await upstreams.registerUpstream(s.workspaceId, s.environmentId, {
      name: "tracker", url: MCP_OAUTH_URL, oauth: { clientId: "anlyon-test-client", authorizationServer: AS_ISSUER },
    }, m.actions.UNSCOPED_AUTHORITY);
    expect(upstream.oauth).toMatchObject({ issuer: AS_ISSUER, authorizationServers: ["https://auth.other.example", AS_ISSUER] });
    expect(await connectOperator(upstream.id)).toBe("connected");
  });

  it("a consent no operator started is revoked, not bound to the upstream", async () => {
    const upstream = await register();
    const p = provider();
    const key = oauth.upstreamIntegrationKey((await pool.query("SELECT id FROM mcp_upstreams WHERE upstream_id = $1", [upstream.id])).rows[0].id);
    const { endUserIdFor } = await import("../src/core/connections/types.ts");
    const minted = await p.createConnectSession({ endUserId: endUserIdFor(s.workspaceId, s.environmentId, "mco_unclaimedconsent0000"), integrationKey: key });
    const authorize = await p.beginConsent(minted.sessionToken);
    const back = new URL(sim.approve(authorize!, "intruder"));
    const result = await p.finishConsent({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null });
    if (!result.ok) throw new Error("consent failed");
    expect(await upstreams.recordOperatorConsent(result.outcome)).toBe("stray");
    expect((await upstreams.getUpstream(s.workspaceId, s.environmentId, upstream.id)).oauth!.operatorConnected).toBe(false);
    expect((await pool.query("SELECT 1 FROM oauth_connections WHERE id = $1", [result.outcome.connectionId])).rowCount).toBe(0);
  });
});
