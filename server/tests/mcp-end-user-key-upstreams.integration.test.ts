import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { providerFetch, setProviderFetchForHost } from "./support/effects/provider-fetch.ts";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});
vi.mock("@anlyon/feature-flags", async (original) => ({
  ...(await original<typeof import("@anlyon/feature-flags")>()),
  isFeatureEnabled: () => true,
}));

const { EffectScope, loadEffectModules } = await import("./support/effects/fixture.ts");
const { OAUTH_SIM_ENCRYPTION_KEY, OAUTH_SIM_ORIGIN } = await import("./support/effects/oauth-simulator.ts");
const { createNativeProvider } = await import("../src/core/connections/native.ts");
const { setConnectionProviderForTests } = await import("../src/core/connections/provider.ts");
const upstreams = await import("../src/core/mcp-upstreams/service.ts");
const oauth = await import("../src/core/mcp-upstreams/oauth.ts");
const connect = await import("../src/core/end-users/connect.ts");
const connections = await import("../src/core/end-users/connections.ts");
const sessionCache = await import("../src/core/mcp-upstreams/session-cache.ts");
const { env } = await import("../src/config/env.ts");

const HOST = "mcp.keys.example";
const URL_ = `https://${HOST}/mcp`;
const OPERATOR_KEY = "opkey_operator_0000000000000000";
const KEY_A = "ukey_alice_11111111111111111111";
const KEY_B = "ukey_bob_2222222222222222222222";
const APP_REDIRECT = "https://app.acme.test/connected";
const actor = { type: "api_key" as const, id: "00000000-0000-4000-8000-00000000aaaa" };

class KeyServer {
  readonly keys = new Map<string, string>([[OPERATOR_KEY, "operator"], [KEY_A, "alice"], [KEY_B, "bob"]]);
  calls: Array<{ method: string; user: string | null; headers: Record<string, string> }> = [];

  fetch = async (_url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> => {
    const body = JSON.parse(init?.body ?? "{}") as { id?: number; method: string; params?: { name?: string } };
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const user = this.keys.get(headers["x-api-key"] ?? "") ?? null;
    this.calls.push({ method: body.method, user, headers });
    const json = (status: number, payload: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...extra } });
    if (!user) return json(401, { error: "invalid_api_key" });
    const reply = (result: unknown, extra: Record<string, string> = {}) => json(200, { jsonrpc: "2.0", id: body.id, result }, extra);
    switch (body.method) {
      case "initialize":
        return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "key-notes", version: "1.0.0" } }, { "Mcp-Session-Id": `s-${user}-${this.calls.length}` });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return reply({ tools: [{ name: "create_note", description: "Creates a note.", inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } }] });
      case "tools/call":
        return reply({ content: [{ type: "text", text: `${String(body.params?.name)} for ${user}` }] });
      default:
        return json(200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
    }
  };
}

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("MCP servers each end user brings their own key to (real Postgres)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let m: Awaited<ReturnType<typeof loadEffectModules>>;
  let s: InstanceType<typeof EffectScope>;
  let server: KeyServer;
  const previousKey = env.CONNECTIONS_ENCRYPTION_KEY;

  beforeAll(async () => {
    await pool.query("SELECT 1");
    m = await loadEffectModules();
  });
  beforeEach(async () => {
    s = await new EffectScope(pool, m).seed();
    await pool.query("UPDATE environments SET allowed_redirect_urls = ARRAY[$2], default_redirect_url = $2 WHERE id = $1", [s.environmentId, APP_REDIRECT]);
    server = new KeyServer();
    sessionCache.clearSessionCache();
    setProviderFetchForHost(HOST, server.fetch);
    (env as { CONNECTIONS_ENCRYPTION_KEY?: string }).CONNECTIONS_ENCRYPTION_KEY = OAUTH_SIM_ENCRYPTION_KEY;
    setConnectionProviderForTests(createNativeProvider({ origin: OAUTH_SIM_ORIGIN, encryptionKey: OAUTH_SIM_ENCRYPTION_KEY, upstreamApp: oauth.upstreamApp }));
    await m.secrets.putSecret(s.workspaceId, "NOTES_KEY", { value: OPERATOR_KEY, allowedHosts: [HOST], allowedPlacements: ["header"] }, s.environmentId);
  });
  afterEach(async () => {
    (env as { CONNECTIONS_ENCRYPTION_KEY?: string }).CONNECTIONS_ENCRYPTION_KEY = previousKey;
    setConnectionProviderForTests(undefined);
    await s.cleanup();
  });
  afterAll(async () => { await pool.end(); });

  const scope = () => ({ workspaceId: s.workspaceId, environmentId: s.environmentId });
  const register = (extra: Record<string, unknown> = {}) => upstreams.registerUpstream(s.workspaceId, s.environmentId, {
    name: "notes", url: URL_, headers: { "X-Api-Key": "{{secret:NOTES_KEY}}", "X-Client": "anlyon" }, endUserKey: { header: "x-api-key" }, ...extra,
  }, m.actions.UNSCOPED_AUTHORITY);
  const keyOf = async (upstreamId: string) =>
    oauth.upstreamIntegrationKey((await pool.query("SELECT id FROM mcp_upstreams WHERE upstream_id = $1", [upstreamId])).rows[0].id);
  const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;
  const asEndUser = (endUserId: string) => ({ endUser: { endUserId, required: false } });
  const stored = async (endUserId: string) =>
    (await pool.query("SELECT * FROM oauth_connections WHERE environment_id = $1 AND subject_end_user_id = $2", [s.environmentId, endUserId])).rows;

  async function connectEndUser(upstreamId: string, endUserId: string, key: string) {
    const link = await upstreams.createEndUserConnectLink(s.workspaceId, s.environmentId, upstreamId, { endUserId });
    const result = await connect.submitKeyLink(tokenOf(link.url), { apiKey: key });
    if (result.status !== "connected" || !result.redirectTo) throw new Error(`key link failed: ${JSON.stringify(result)}`);
    const landed = new URL(result.redirectTo);
    expect(landed.searchParams.get("anlyon_status")).toBe("pending_confirmation");
    await connect.confirmConnection(scope(), endUserId, landed.searchParams.get("anlyon_flow")!, actor);
  }

  it("registers with the operator's key, names the end user's header as the server's headers spell it, and never returns a key", async () => {
    const upstream = await register();
    expect(upstream.endUserKey).toEqual({ header: "X-Api-Key", integration: await keyOf(upstream.id) });
    expect(upstream.oauth).toBeNull();
    expect(upstream.listedWith).toBe("headers");
    expect(upstream.tools.map((t) => t.name)).toEqual(["create_note"]);
    expect(server.calls.every((c) => c.user === "operator")).toBe(true);
    expect(JSON.stringify(upstream)).not.toContain(OPERATOR_KEY);

    const [adopted] = (await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_note: {} }, m.actions.UNSCOPED_AUTHORITY)).adopted;
    expect(adopted!.action.headers).toEqual({ "X-Api-Key": "{{secret:NOTES_KEY}}", "X-Client": "anlyon" });
    const binding = (await pool.query("SELECT mcp FROM actions WHERE action_id = $1", [adopted!.action.id])).rows[0].mcp;
    expect(binding).toMatchObject({ endUserKey: { connection: await keyOf(upstream.id), header: "X-Api-Key" } });
    expect(binding).not.toHaveProperty("oauthConnection");
  });

  it("refuses a registration whose end-user header is missing, holds no secret reference, or comes with OAuth", async () => {
    await expect(register({ endUserKey: { header: "Authorization" } })).rejects.toThrow(/not one of this server's headers/);
    await expect(register({ endUserKey: { header: "X-Client" } })).rejects.toThrow(/exactly one \{\{secret:NAME\}\} reference/);
    await expect(register({ headers: { "X-Api-Key": "{{secret:NOTES_KEY}}{{secret:NOTES_KEY}}" } })).rejects.toThrow(/exactly one/);
    await expect(register({ oauth: { clientId: "c" } })).rejects.toThrow(/not both/);
    expect((await pool.query("SELECT count(*)::int AS n FROM mcp_upstreams WHERE workspace_id = $1", [s.workspaceId])).rows[0].n).toBe(0);
  });

  it("each end user's call carries their own key and never the operator's; a call for no end user carries the operator's", async () => {
    const upstream = await register();
    await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_note: {} }, m.actions.UNSCOPED_AUTHORITY);
    await connectEndUser(upstream.id, "user-a", KEY_A);
    await connectEndUser(upstream.id, "user-b", KEY_B);

    server.calls = [];
    const a = await s.invoke("notes-create_note", { title: "From A" }, asEndUser("user-a"));
    expect(a.status).toBe("succeeded");
    const b = await s.invoke("notes-create_note", { title: "From B" }, asEndUser("user-b"));
    expect(b.status).toBe("succeeded");
    expect(server.calls.filter((c) => c.method === "tools/call").map((c) => c.user)).toEqual(["alice", "bob"]);
    expect(new Set(server.calls.map((c) => c.user))).toEqual(new Set(["alice", "bob"]));
    expect(server.calls.every((c) => c.headers["x-client"] === "anlyon")).toBe(true);

    const key = await keyOf(upstream.id);
    const effectA = await s.effect(a.effectId!);
    const effectB = await s.effect(b.effectId!);
    expect(effectA.request.headers).toEqual({ "X-Api-Key": `{{connection:${key}}}`, "X-Client": "anlyon" });
    expect(effectB.request.headers).toEqual(effectA.request.headers);
    for (const secret of [KEY_A, KEY_B, OPERATOR_KEY]) {
      expect(JSON.stringify(effectA)).not.toContain(secret);
      expect(JSON.stringify(a)).not.toContain(secret);
    }

    server.calls = [];
    expect((await s.invoke("notes-create_note", { title: "From the operator" })).status).toBe("succeeded");
    expect(new Set(server.calls.map((c) => c.user))).toEqual(new Set(["operator"]));
  });

  it("stores a key encrypted and marked as a key, lists it without it, and deletes it", async () => {
    const upstream = await register();
    await connectEndUser(upstream.id, "user-a", KEY_A);
    const [row] = await stored("user-a");
    expect(row.integration_key).toBe(await keyOf(upstream.id));
    expect(row.connection_config).toEqual({ upstreamKey: true });
    expect(row.access_token_encrypted).not.toContain(KEY_A);
    expect(row.pending_confirmation_until).toBeNull();

    const listed = await connections.listEndUserConnections(scope(), "user-a");
    expect(listed).toMatchObject([{ integration: await keyOf(upstream.id), kind: "api_key", status: "active", scopes: [] }]);
    expect(JSON.stringify(listed)).not.toContain(KEY_A);

    await connections.deleteEndUserConnection(scope(), "user-a", await keyOf(upstream.id), actor);
    expect(await stored("user-a")).toEqual([]);
  });

  it("a key the server refuses is not stored, the link stays open for another try, and a malformed one never reaches the server", async () => {
    const upstream = await register();
    const link = await upstreams.createEndUserConnectLink(s.workspaceId, s.environmentId, upstream.id, { endUserId: "user-a" });
    server.calls = [];
    const refused = await connect.submitKeyLink(tokenOf(link.url), { apiKey: "ukey_wrong_000000000000000000000" });
    expect(refused).toMatchObject({ status: "refused", attemptsLeft: connect.KEY_LINK_ATTEMPTS - 1 });
    expect((refused as { message: string }).message).toContain("notes did not accept that key");
    expect(server.calls.length).toBeGreaterThan(0);
    expect(server.calls.every((c) => c.headers["x-api-key"] === "ukey_wrong_000000000000000000000")).toBe(true);
    expect(await stored("user-a")).toEqual([]);

    server.calls = [];
    for (const bad of ["has a space", "line\r\nbreak: x", "{{secret:NOTES_KEY}}", "x".repeat(4097)]) {
      expect(await connect.submitKeyLink(tokenOf(link.url), { apiKey: bad })).toMatchObject({ status: "refused" });
    }
    expect(server.calls).toEqual([]);
    expect(await stored("user-a")).toEqual([]);
    expect(await connect.submitKeyLink(tokenOf(link.url), { apiKey: KEY_A })).toEqual({ status: "expired" });
  });

  it("a key typed into a link is not the end user's until the developer's server confirms it, and not at all when confirmed for someone else", async () => {
    const upstream = await register();
    await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_note: {} }, m.actions.UNSCOPED_AUTHORITY);
    const link = await upstreams.createEndUserConnectLink(s.workspaceId, s.environmentId, upstream.id, { endUserId: "user-a" });
    const result = await connect.submitKeyLink(tokenOf(link.url), { apiKey: KEY_A });
    expect(result.status).toBe("connected");
    await expect(s.invoke("notes-create_note", { title: "Too soon" }, asEndUser("user-a"))).rejects.toMatchObject({ code: "END_USER_NOT_CONNECTED" });
    expect(await connect.submitKeyLink(tokenOf(link.url), { apiKey: KEY_A })).toEqual({ status: "expired" });
    const flow = new URL((result as { redirectTo: string }).redirectTo).searchParams.get("anlyon_flow")!;
    await expect(connect.confirmConnection(scope(), "user-b", flow, actor)).rejects.toMatchObject({ code: "END_USER_MISMATCH" });
    expect(await stored("user-a")).toEqual([]);
    expect(await stored("user-b")).toEqual([]);
  });

  it("an end user who never connected is answered 409 with a key link before anything is recorded, and connects through it", async () => {
    const upstream = await register();
    await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_note: {} }, m.actions.UNSCOPED_AUTHORITY);
    const invocations = async () => Number((await pool.query("SELECT count(*)::int AS n FROM action_invocations WHERE workspace_id = $1", [s.workspaceId])).rows[0].n);
    const before = await invocations();
    server.calls = [];
    const refused = await s.invoke("notes-create_note", { title: "Nobody" }, asEndUser("user-c")).catch((error: unknown) => error);
    expect(refused).toMatchObject({ statusCode: 409, code: "END_USER_NOT_CONNECTED", integration: await keyOf(upstream.id), displayName: "notes", endUserId: "user-c" });
    const link = (refused as { link: { url: string } | null }).link;
    expect(tokenOf(link!.url)).toMatch(/^kln_/);
    expect(server.calls).toEqual([]);
    expect(await invocations()).toBe(before);

    const result = await connect.submitKeyLink(tokenOf(link!.url), { apiKey: KEY_B });
    await connect.confirmConnection(scope(), "user-c", new URL((result as { redirectTo: string }).redirectTo).searchParams.get("anlyon_flow")!, actor);
    server.calls = [];
    expect((await s.invoke("notes-create_note", { title: "Now connected" }, asEndUser("user-c"))).status).toBe("succeeded");
    expect(server.calls.find((c) => c.method === "tools/call")!.user).toBe("bob");
  });

  it("the developer's server can store an end user's key directly, checked the same way", async () => {
    const upstream = await register();
    const key = await keyOf(upstream.id);
    await expect(connections.setEndUserApiKey(scope(), "user-a", key, { apiKey: "ukey_wrong_000000000000000000000" }, actor)).rejects.toMatchObject({ code: "CONNECTION_KEY_REJECTED" });
    expect(await stored("user-a")).toEqual([]);
    const view = await connections.setEndUserApiKey(scope(), "user-a", key, { apiKey: KEY_A }, actor);
    expect(view).toMatchObject({ integration: key, kind: "api_key", status: "active" });
    expect(view).not.toHaveProperty("connectionId");
  });

  it("a key the server stops accepting fails before the tool is called, and the next call asks the end user to connect again", async () => {
    const upstream = await register();
    await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_note: {} }, m.actions.UNSCOPED_AUTHORITY);
    await connectEndUser(upstream.id, "user-a", KEY_A);
    server.keys.delete(KEY_A);
    server.calls = [];
    const failed = await s.invoke("notes-create_note", { title: "Revoked at the server" }, asEndUser("user-a"));
    expect(failed.status).toBe("failed");
    expect(server.calls.some((c) => c.method === "tools/call")).toBe(false);
    await expect(s.invoke("notes-create_note", { title: "Again" }, asEndUser("user-a"))).rejects.toMatchObject({ code: "END_USER_RECONNECT_REQUIRED" });
    expect((await s.invoke("notes-create_note", { title: "Operator" })).status).toBe("succeeded");
  });

  it("an archived server lends no key, and a server without the option makes no link", async () => {
    const upstream = await register();
    await upstreams.adoptTools(s.workspaceId, s.environmentId, upstream.id, { create_note: { requiresApproval: true } }, m.actions.UNSCOPED_AUTHORITY);
    await connectEndUser(upstream.id, "user-a", KEY_A);
    const key = await keyOf(upstream.id);
    await pool.query("UPDATE mcp_upstreams SET archived_at = now() WHERE upstream_id = $1", [upstream.id]);
    await expect(upstreams.createEndUserConnectLink(s.workspaceId, s.environmentId, upstream.id, { endUserId: "user-b" })).rejects.toThrow(/archived/);
    await expect(connections.setEndUserApiKey(scope(), "user-b", key, { apiKey: KEY_B }, actor)).rejects.toThrow(/does not take an end user's own key/);

    const plain = await upstreams.registerUpstream(s.workspaceId, s.environmentId, { name: "plain", url: URL_, headers: { "X-Api-Key": "{{secret:NOTES_KEY}}" } }, m.actions.UNSCOPED_AUTHORITY);
    expect(plain.endUserKey).toBeNull();
    await expect(upstreams.createEndUserConnectLink(s.workspaceId, s.environmentId, plain.id, { endUserId: "user-b" })).rejects.toThrow(/do not connect to it/);
  });
});
