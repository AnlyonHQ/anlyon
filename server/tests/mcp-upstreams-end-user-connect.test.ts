import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  process.env.CONNECTIONS_ENCRYPTION_KEY = "test-connections-encryption-key-32chars";
  process.env.CONNECT_PUBLIC_URL = "https://api.anlyon.test";
  return {
    client: undefined as PGlite | undefined,
    store: new Map<string, { value: string; expiresAt: number }>(),
  };
});

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
  return {
    redis, redisBlocking: redis, RedisKeys, createBlockingConnection: () => redis,
    incrementWithTtl: async () => 1, USAGE_COUNTER_TTL_SECONDS: 1, WAITING_EVENT_TTL_SECONDS: 1,
  };
});
vi.mock("../src/lib/safe-http.ts", async (original) => ({
  ...await original<typeof import("../src/lib/safe-http.ts")>(),
  safeFetch: async (url: string) => { throw new Error(`unexpected request to ${url}`); },
}));
vi.mock("../src/core/events/emitter.ts", () => ({ emitEvent: vi.fn() }));
vi.mock("../src/core/notifications/notification-service.ts", () => ({ createAndSendNotification: vi.fn() }));
vi.mock("../src/core/assistant/service.ts", () => ({ onApprovalAnnounced: async () => false }));
vi.mock("../src/lib/product-events.ts", () => ({ captureMilestoneOnce: vi.fn() }));

const { createNativeProvider } = await import("../src/core/connections/native.ts");
const { setConnectionProviderForTests } = await import("../src/core/connections/provider.ts");
const { OAUTH_SIM_ENCRYPTION_KEY, OAUTH_SIM_ORIGIN } = await import("./support/effects/oauth-simulator.ts");
const oauth = await import("../src/core/mcp-upstreams/oauth.ts");
const connect = await import("../src/core/end-users/connect.ts");
const connections = await import("../src/core/end-users/connections.ts");
const { createAction, invokeAction, UNSCOPED_AUTHORITY } = await import("../src/core/actions/service.ts");

const ws = "00000000-0000-4000-8000-0000000c0e01";
const env = "00000000-0000-4000-8000-0000000c0f01";
const otherEnv = "00000000-0000-4000-8000-0000000c0f02";
const scope = { workspaceId: ws, environmentId: env };
const APP = "https://app.acme.test/connected";
const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);

const OAUTH = {
  resource: "https://mcp.tracker.test/mcp",
  issuer: "https://auth.tracker.test",
  authorizationEndpoint: "https://auth.tracker.test/authorize",
  tokenEndpoint: "https://auth.tracker.test/token",
  scopesSupported: ["issues"],
  scopes: ["issues"],
  clientRegistration: "pre_registered",
  clientId: "tracker-client",
  clientSecretName: null,
  advertised: { dynamicRegistration: false, clientIdMetadataDocuments: false, pkceS256: true },
};

let seq = 0;

async function adoptedTool(environmentId = env, oauthRow: unknown = OAUTH): Promise<{ action: string; key: string; rowId: string; name: string }> {
  const n = ++seq;
  const [row] = (await sql(
    `INSERT INTO mcp_upstreams (upstream_id, workspace_id, environment_id, name, url, oauth)
     VALUES ($1, $2, $3, $4, 'https://mcp.tracker.test/mcp', $5) RETURNING id`,
    [`mcpu_connect${n}`, ws, environmentId, `Tracker ${n}`, oauthRow === null ? null : JSON.stringify(oauthRow)],
  )).rows as Array<{ id: string }>;
  const key = oauth.upstreamIntegrationKey(row!.id);
  const name = `tracker-create_issue-${n}`;
  await createAction(ws, {
    name,
    method: "POST",
    urlTemplate: "https://mcp.tracker.test/mcp",
    headers: {},
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    requiresApproval: true,
    mcp: {
      upstreamId: `mcpu_connect${n}`, toolName: "create_issue", toolHash: "a".repeat(64), suggestedClass: "write",
      ...(oauthRow === null ? {} : { oauthConnection: key }),
    },
  } as never, UNSCOPED_AUTHORITY, environmentId);
  return { action: name, key, rowId: row!.id, name: `Tracker ${n}` };
}

async function grant(key: string, endUserId: string, extra: { revoked?: boolean } = {}) {
  await sql(
    `INSERT INTO oauth_connections (id, workspace_id, environment_id, integration_key, end_user_id, subject_end_user_id, access_token_encrypted, revoked_at)
     VALUES ($1, $2, $3, $4, 'eul_tag', $5, 'sealed', $6)`,
    [`oc_${++seq}`, ws, env, key, endUserId, extra.revoked ? new Date() : null],
  );
}

const forUser = (endUserId: string | null, environmentId = env) => ({ environmentId, endUser: { endUserId, required: false } });
const counts = async () => ({
  invocations: Number((await sql("SELECT count(*)::int AS n FROM action_invocations WHERE workspace_id = $1", [ws])).rows[0]!.n),
  effects: Number((await sql("SELECT count(*)::int AS n FROM action_effects WHERE workspace_id = $1", [ws])).rows[0]!.n),
  approvals: Number((await sql("SELECT count(*)::int AS n FROM approvals WHERE workspace_id = $1", [ws])).rows[0]!.n),
});

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Acme Tracker', 'acme-mcp-connect')", [ws]);
  await sql(
    `INSERT INTO environments (id, workspace_id, name, slug, kind, allowed_redirect_urls, default_redirect_url)
     VALUES ($1, $3, 'Production', 'prod', 'production', ARRAY['${APP}'], '${APP}'),
            ($2, $3, 'Staging', 'staging', 'staging', '{}', NULL)`,
    [env, otherEnv, ws],
  );
}, 120_000);

beforeEach(() => {
  state.store.clear();
  setConnectionProviderForTests(createNativeProvider({ origin: OAUTH_SIM_ORIGIN, encryptionKey: OAUTH_SIM_ENCRYPTION_KEY, upstreamApp: oauth.upstreamApp }));
});
afterEach(async () => {
  setConnectionProviderForTests(undefined);
  await sql("DELETE FROM oauth_connections");
});

describe("calling an adopted OAuth tool for an end user", () => {
  it("who never connected the server: 409 END_USER_NOT_CONNECTED with its name and a link, and nothing is created", async () => {
    const { action, key, name } = await adoptedTool();
    const before = await counts();
    const refused = await invokeAction(ws, action, { title: "Nobody" }, forUser("bob")).catch((error: unknown) => error);
    expect(refused).toMatchObject({ statusCode: 409, code: "END_USER_NOT_CONNECTED", integration: key, displayName: name, endUserId: "bob" });
    const body = (refused as { toJSON(): { error: Record<string, unknown> } }).toJSON().error;
    expect(body).toMatchObject({ code: "END_USER_NOT_CONNECTED", integration: key, displayName: name, endUserId: "bob" });
    expect(body.connectUrl).toMatch(/^https:\/\/api\.anlyon\.test\/.*\?token=/);
    expect(body.message).toContain(`has not connected ${name}. Nothing was sent.`);
    expect(await counts()).toEqual(before);

    const again = await invokeAction(ws, action, { title: "Nobody" }, forUser("bob")).catch((error: unknown) => error);
    expect((again as { toJSON(): { error: Record<string, unknown> } }).toJSON().error.connectUrl).toBe(body.connectUrl);
  });

  it("whose grant needs reconnecting: 409 END_USER_RECONNECT_REQUIRED", async () => {
    const { action, key, name } = await adoptedTool();
    await grant(key, "carol", { revoked: true });
    const before = await counts();
    await expect(invokeAction(ws, action, { title: "Revoked" }, forUser("carol")))
      .rejects.toMatchObject({ statusCode: 409, code: "END_USER_RECONNECT_REQUIRED", integration: key, displayName: name });
    expect(await counts()).toEqual(before);
  });

  it("who connected it: the call goes on to review, and another server's grant does not count", async () => {
    const { action, key } = await adoptedTool();
    const other = await adoptedTool();
    await grant(key, "alice");
    const parked = await invokeAction(ws, action, { title: "From Alice" }, forUser("alice"));
    expect(parked.status).toBe("pending_approval");
    await expect(invokeAction(ws, other.action, { title: "Other server" }, forUser("alice")))
      .rejects.toMatchObject({ code: "END_USER_NOT_CONNECTED", integration: other.key });
  });

  it("with no default redirect URL: the 409 carries no link and says how to get one", async () => {
    const { action, name } = await adoptedTool(otherEnv);
    const refused = await invokeAction(ws, action, { title: "No redirect" }, forUser("bob", otherEnv)).catch((error: unknown) => error);
    const body = (refused as { toJSON(): { error: Record<string, unknown> } }).toJSON().error;
    expect(body).toMatchObject({ code: "END_USER_NOT_CONNECTED", displayName: name });
    expect(body.connectUrl).toBeUndefined();
    expect(body.message).toContain("Set a default redirect URL");
  });

  it("keeps today's behaviour with no end user, for an archived server, and for a server without OAuth", async () => {
    const { action, rowId } = await adoptedTool();
    expect((await invokeAction(ws, action, { title: "Operator" }, forUser(null))).status).toBe("pending_approval");
    await sql("UPDATE mcp_upstreams SET archived_at = now() WHERE id = $1", [rowId]);
    expect((await invokeAction(ws, action, { title: "Archived" }, forUser("bob"))).status).toBe("pending_approval");
    const plain = await adoptedTool(env, null);
    expect((await invokeAction(ws, plain.action, { title: "Headers" }, forUser("bob"))).status).toBe("pending_approval");
  });
});

describe("a connect link for an MCP server's key", () => {
  it("is made where the end-user session asks, for a live OAuth server in this environment only", async () => {
    const { key, rowId } = await adoptedTool();
    const link = await connect.createConnectLink(scope, "bob", { integration: key }, { mcpServers: true });
    expect(link).toMatchObject({ integration: key });
    expect(link.url).toMatch(/^https:\/\/api\.anlyon\.test\/.*\?token=/);

    await expect(connect.createConnectLink(scope, "bob", { integration: key })).rejects.toMatchObject({ statusCode: 400 });
    await expect(connect.createConnectLink({ workspaceId: ws, environmentId: otherEnv }, "bob", { integration: key }, { mcpServers: true }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(connect.createConnectLink(scope, "bob", { integration: "mcp-00000000-0000-4000-8000-000000000000" }, { mcpServers: true }))
      .rejects.toMatchObject({ statusCode: 400 });
    await sql("UPDATE mcp_upstreams SET archived_at = now() WHERE id = $1", [rowId]);
    await expect(connect.createConnectLink(scope, "bob", { integration: key }, { mcpServers: true })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("is refused for a server that signs nobody in", async () => {
    const { key } = await adoptedTool(env, null);
    await expect(connect.createConnectLink(scope, "bob", { integration: key }, { mcpServers: true })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("the pre-invocation check passes for a connected end user and names the server otherwise", async () => {
    const { key } = await adoptedTool();
    await grant(key, "alice");
    await expect(connections.assertEndUserConnectedToUpstream(scope, "alice", { integrationKey: key, name: "Tracker" })).resolves.toBeUndefined();
    await expect(connections.assertEndUserConnectedToUpstream(scope, "dave", { integrationKey: key, name: "Tracker" }))
      .rejects.toMatchObject({ code: "END_USER_NOT_CONNECTED", displayName: "Tracker" });
  });
});
