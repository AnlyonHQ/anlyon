import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  process.env.CONNECTIONS_ENCRYPTION_KEY = "test-connections-encryption-key-32chars";
  process.env.CONNECTIONS_ALLOW_UNVERIFIED = "true";
  return {
    client: undefined as PGlite | undefined,
    store: new Map<string, { value: string; expiresAt: number }>(),
    sent: [] as Array<{ url: string; authorization: string }>,
    reply: "{}",
  };
});

vi.mock("../src/lib/safe-http.ts", async (original) => ({
  ...await original<typeof import("../src/lib/safe-http.ts")>(),
  safeFetch: async (url: string, init: { headers?: Record<string, string> }) => {
    state.sent.push({ url, authorization: init.headers?.Authorization ?? "" });
    return new Response(state.reply, { status: 200, headers: { "content-type": "application/json" } });
  },
}));
vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client), pool: { end: async () => {} } };
});
vi.mock("../src/lib/redis.ts", () => {
  const redis = {
    async set(key: string, value: string) { state.store.set(key, { value, expiresAt: Date.now() + 60_000 }); return "OK"; },
    async get(key: string) { return state.store.get(key)?.value ?? null; },
    async getdel(key: string) { const v = state.store.get(key)?.value ?? null; state.store.delete(key); return v; },
    async pttl() { return 60_000; },
    async del(key: string) { return state.store.delete(key) ? 1 : 0; },
    async incr(key: string) {
      const next = Number(state.store.get(key)?.value ?? 0) + 1;
      state.store.set(key, { value: String(next), expiresAt: Date.now() + 60_000 });
      return next;
    },
    async decr() { return 0; },
    async expire() { return 1; },
    async exists() { return 0; },
    async hgetall() { return {}; },
    async eval() { return 0; },
  };
  const RedisKeys = new Proxy({}, { get: (_t, name) => (...parts: unknown[]) => `${String(name)}:${parts.join(":")}` });
  return { redis, redisBlocking: redis, RedisKeys, createBlockingConnection: () => redis };
});
vi.mock("../src/core/events/emitter.ts", () => ({ emitEvent: vi.fn() }));
vi.mock("../src/core/notifications/notification-service.ts", () => ({ createAndSendNotification: vi.fn() }));
vi.mock("../src/core/assistant/service.ts", () => ({ onApprovalAnnounced: async () => false }));
vi.mock("../src/lib/product-events.ts", () => ({ captureMilestoneOnce: vi.fn() }));
vi.mock("../src/core/connections/catalogue.ts", async (original) => {
  const mod = await original<typeof import("../src/core/connections/catalogue.ts")>();
  (mod.CATALOGUE as import("../src/core/connections/catalogue.ts").IntegrationEntry[]).push({
    id: "acmedesk",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Basic ",
      instructions: "A test entry: an email and an API token, on the account's own subdomain of the provider.",
      instructionsUrl: "https://example.com/keys",
      check: { url: "https://{{connection.host}}/api/v2/users/me.json" },
      account: { name: "subdomain", label: "Subdomain" },
      fields: [
        { name: "email", label: "Email", secret: false, pattern: "^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\\.[A-Za-z]{2,63}$" },
        { name: "apiToken", label: "API token", secret: true, pattern: "^[A-Za-z0-9_=-]{8,512}$" },
      ],
      encoding: { kind: "basic", username: "{email}/token", password: "{apiToken}" },
    },
    displayName: "AcmeDesk",
    hosts: { hostTemplate: "{subdomain}.acmedesk.com", from: "account.subdomain" },
    scopes: [],
    verificationStatus: "verified",
    exercised: false,
    reviewNote: "None.",
    operationsPack: null,
    workflowPacks: [],
  });
  return mod;
});

const { keyCheck } = await import("../src/core/connections/health.ts");
const connections = await import("../src/core/end-users/connections.ts");
const { connectWithKey } = await import("../src/core/connections/service.ts");
const { putSecret, resolveAccountHost } = await import("../src/core/actions/secrets.ts");
const { createAction, invokeAction, UNSCOPED_AUTHORITY } = await import("../src/core/actions/service.ts");
const { createPreviewForAction } = await import("../src/core/effects/service.ts");

const ws = "00000000-0000-4000-8000-0000000000a1";
const env = "00000000-0000-4000-8000-0000000000b1";
const scope = { workspaceId: ws, environmentId: env };
const actor = { type: "api_key" as const, id: "00000000-0000-4000-8000-00000000aaaa" };
const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);
const basic = (email: string, token: string) => `Basic ${Buffer.from(`${email}/token:${token}`).toString("base64")}`;

const ALICE = "alice_token_0001";
const BOB = "bob_token_000002";
const TEAM = "team_token_00003";
let checks: Array<{ url: string; authorization: string }> = [];

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Acme', 'acme')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug, kind) VALUES ($1, $2, 'Production', 'prod', 'production')", [env, ws]);
  await sql(
    `INSERT INTO actions (workspace_id, environment_id, action_id, name, method, url_template, headers)
     VALUES ($1, $2, 'act_tickets', 'list-tickets', 'GET', 'https://{{connection.host}}/api/v2/tickets.json?per_page=20', $3)`,
    [ws, env, JSON.stringify({ Authorization: "Basic {{connection:acmedesk}}" })],
  );
}, 120_000);

beforeEach(() => {
  state.store.clear();
  state.sent = [];
  state.reply = "{}";
  checks = [];
  vi.spyOn(keyCheck, "fetch").mockImplementation(async (url, init) => {
    checks.push({ url, authorization: init.headers.Authorization ?? "" });
    return new Response("{}", { status: 200 });
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await sql("DELETE FROM oauth_connections");
  await sql("DELETE FROM workspace_secrets");
});

describe("a workspace key made of fields, on the account's own host", () => {
  it("checks the key on the account's host in the declared header, binds the secret to that host, and returns no value", async () => {
    const secret = await connectWithKey(scope, {
      integrationId: "acmedesk", secretName: "ACMEDESK",
      fields: { subdomain: "acme", email: "team@acme.test", apiToken: TEAM },
    });
    expect(checks).toEqual([{ url: "https://acme.acmedesk.com/api/v2/users/me.json", authorization: basic("team@acme.test", TEAM) }]);
    expect(secret).toMatchObject({ name: "ACMEDESK", integrationId: "acmedesk", allowedHosts: ["acme.acmedesk.com"], allowedPlacements: ["header"] });
    expect(JSON.stringify(secret)).not.toContain(TEAM);
    expect(JSON.stringify(secret)).not.toContain("team@acme.test");
    const { rows } = await sql("SELECT value_encrypted FROM workspace_secrets WHERE name = 'ACMEDESK'");
    expect(String(rows[0]!.value_encrypted)).not.toContain(TEAM);

    await expect(connectWithKey(scope, { integrationId: "acmedesk", secretName: "OTHER", fields: { subdomain: "evil.test", email: "a@b.co", apiToken: TEAM } }))
      .rejects.toThrow(/single name before \.acmedesk\.com/);
    await expect(connectWithKey(scope, { integrationId: "acmedesk", secretName: "OTHER", apiKey: TEAM })).rejects.toThrow(/fields/);
    expect(checks).toHaveLength(1);
  });

  it("sends a workspace call to the workspace's host, and redacts a raw token the provider echoes", async () => {
    const logged: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logged.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write);
    await connectWithKey(scope, { integrationId: "acmedesk", secretName: "ACMEDESK", fields: { subdomain: "acme", email: "team@acme.test", apiToken: TEAM } });
    state.reply = JSON.stringify({ echoed: TEAM, header: basic("team@acme.test", TEAM) });
    const result = await invokeAction(ws, "list-tickets", {}, { environmentId: env });
    expect(logged.join("")).not.toContain(TEAM);
    expect(logged.join("")).not.toContain(Buffer.from(`team@acme.test/token:${TEAM}`).toString("base64"));
    expect(result).toMatchObject({ status: "succeeded" });
    expect(state.sent).toEqual([{ url: "https://acme.acmedesk.com/api/v2/tickets.json?per_page=20", authorization: basic("team@acme.test", TEAM) }]);
    const recorded = JSON.stringify(result);
    expect(recorded).not.toContain(TEAM);
    expect(recorded).not.toContain(Buffer.from(`team@acme.test/token:${TEAM}`).toString("base64"));
    const { rows } = await sql("SELECT response_body, error_message FROM action_invocations");
    expect(JSON.stringify(rows)).not.toContain(TEAM);
  });

  it("refuses a bound host rewritten outside the template, before anything is sent", async () => {
    await connectWithKey(scope, { integrationId: "acmedesk", secretName: "ACMEDESK", fields: { subdomain: "acme", email: "team@acme.test", apiToken: TEAM } });
    for (const host of ["evil.test", "acme.acmedesk.com.evil.test", "x.acme.acmedesk.com"]) {
      await putSecret(ws, "ACMEDESK", { value: JSON.stringify({ fields: { email: "team@acme.test", apiToken: TEAM } }), allowedHosts: [host] }, env);
      await expect(resolveAccountHost(ws, ["connection:acmedesk"], env)).rejects.toThrow(/not a AcmeDesk host/);
      await expect(invokeAction(ws, "list-tickets", {}, { environmentId: env })).resolves.toMatchObject({ status: "failed" });
    }
    expect(state.sent).toEqual([]);
  });
});

describe("end users on their own hosts", () => {
  it("sends each end user's own credential to that end user's own host, never another's", async () => {
    await connections.setEndUserApiKey(scope, "alice", "acmedesk", { fields: { subdomain: "alice-co", email: "alice@alice.test", apiToken: ALICE } }, actor);
    await connections.setEndUserApiKey(scope, "bob", "acmedesk", { fields: { subdomain: "bob-co", email: "bob@bob.test", apiToken: BOB } }, actor);
    await connectWithKey(scope, { integrationId: "acmedesk", secretName: "ACMEDESK", fields: { subdomain: "team", email: "team@acme.test", apiToken: TEAM } });
    expect(checks.map((c) => c.url)).toEqual([
      "https://alice-co.acmedesk.com/api/v2/users/me.json",
      "https://bob-co.acmedesk.com/api/v2/users/me.json",
      "https://team.acmedesk.com/api/v2/users/me.json",
    ]);

    const listed = JSON.stringify(await connections.listEndUserConnections(scope, "alice"));
    expect(listed).not.toContain(ALICE);
    expect(listed).not.toContain("alice@alice.test");

    await invokeAction(ws, "list-tickets", {}, { environmentId: env, endUser: { endUserId: "alice", required: false } });
    await invokeAction(ws, "list-tickets", {}, { environmentId: env, endUser: { endUserId: "bob", required: false } });
    await invokeAction(ws, "list-tickets", {}, { environmentId: env });
    expect(state.sent).toEqual([
      { url: "https://alice-co.acmedesk.com/api/v2/tickets.json?per_page=20", authorization: basic("alice@alice.test", ALICE) },
      { url: "https://bob-co.acmedesk.com/api/v2/tickets.json?per_page=20", authorization: basic("bob@bob.test", BOB) },
      { url: "https://team.acmedesk.com/api/v2/tickets.json?per_page=20", authorization: basic("team@acme.test", TEAM) },
    ]);

    await expect(invokeAction(ws, "list-tickets", {}, { environmentId: env, endUser: { endUserId: "carol", required: false } }))
      .rejects.toMatchObject({ code: "END_USER_NOT_CONNECTED" });
    await expect(invokeAction(ws, "list-tickets", {}, { environmentId: env, endUser: { endUserId: null, required: true } }))
      .rejects.toMatchObject({ code: "END_USER_REQUIRED" });
    expect(state.sent).toHaveLength(3);
  });

  it("the health sweep checks each end user's key on that end user's host, and marks what cannot work", async () => {
    await connections.setEndUserApiKey(scope, "alice", "acmedesk", { fields: { subdomain: "alice-co", email: "alice@alice.test", apiToken: ALICE } }, actor);
    await connections.setEndUserApiKey(scope, "bob", "acmedesk", { fields: { subdomain: "bob-co", email: "bob@bob.test", apiToken: BOB } }, actor);
    await connections.setEndUserApiKey(scope, "carol", "acmedesk", { fields: { subdomain: "carol-co", email: "carol@carol.test", apiToken: TEAM } }, actor);
    await connections.setEndUserApiKey(scope, "dave", "acmedesk", { fields: { subdomain: "dave-co", email: "dave@dave.test", apiToken: TEAM } }, actor);
    await sql("UPDATE oauth_connections SET connection_config = '{\"host\":\"evil.test\"}'::jsonb WHERE subject_end_user_id = 'carol'");
    await sql("UPDATE oauth_connections SET last_refreshed_at = now() - interval '1 hour' WHERE subject_end_user_id = 'dave'");
    checks = [];
    vi.mocked(keyCheck.fetch).mockImplementation(async (url, init) => {
      checks.push({ url, authorization: init.headers.Authorization ?? "" });
      return new Response("{}", { status: url.startsWith("https://bob-co.") ? 401 : 200 });
    });

    await expect(connections.sweepEndUserKeyHealth()).resolves.toEqual({ checked: 3, marked: 2, skipped: 0 });
    expect(checks.sort((a, b) => a.url.localeCompare(b.url))).toEqual([
      { url: "https://alice-co.acmedesk.com/api/v2/users/me.json", authorization: basic("alice@alice.test", ALICE) },
      { url: "https://bob-co.acmedesk.com/api/v2/users/me.json", authorization: basic("bob@bob.test", BOB) },
    ]);
    const status = async (endUserId: string) => (await connections.listEndUserConnections(scope, endUserId))[0]?.status;
    expect(await status("alice")).toBe("active");
    expect(await status("bob")).toBe("needs_reconnect");
    expect(await status("carol")).toBe("needs_reconnect");
    expect(await status("dave")).toBe("active");
    checks = [];
    await expect(connections.sweepEndUserKeyHealth()).resolves.toEqual({ checked: 0, marked: 0, skipped: 0 });
    expect(checks).toEqual([]);
    expect(state.sent).toEqual([]);
  });

  it("refuses an end user's host that no longer fits the template, and a credential whose account changed under the request", async () => {
    await connections.setEndUserApiKey(scope, "alice", "acmedesk", { fields: { subdomain: "alice-co", email: "alice@alice.test", apiToken: ALICE } }, actor);
    await sql("UPDATE oauth_connections SET connection_config = '{\"host\":\"evil.test\"}'::jsonb WHERE subject_end_user_id = 'alice'");
    await expect(resolveAccountHost(ws, ["connection:acmedesk"], env, { endUserId: "alice", required: false })).rejects.toThrow(/not a AcmeDesk host/);
    await sql("UPDATE oauth_connections SET connection_config = '{\"host\":\"alice-co.acmedesk.com\"}'::jsonb WHERE subject_end_user_id = 'alice'");
    await expect(connections.endUserCredentialParts(scope, "acmedesk", "alice", "bob-co.acmedesk.com")).rejects.toThrow(/changed during the call/);
    expect((await connections.endUserCredentialParts(scope, "acmedesk", "alice", "alice-co.acmedesk.com")).value)
      .toBe(Buffer.from(`alice@alice.test/token:${ALICE}`).toString("base64"));
    expect(state.sent).toEqual([]);
  });
});

describe("a governed action on {{connection.host}}", () => {
  it("previews, targets and counts each account on its own host, and refuses a preview for a host the account no longer has", async () => {
    await connections.setEndUserApiKey(scope, "alice", "acmedesk", { fields: { subdomain: "alice-co", email: "alice@alice.test", apiToken: ALICE } }, actor);
    await connections.setEndUserApiKey(scope, "bob", "acmedesk", { fields: { subdomain: "bob-co", email: "bob@bob.test", apiToken: BOB } }, actor);
    const ticket = "https://{{connection.host}}/api/v2/tickets/{{input.id}}.json";
    await createAction(ws, {
      name: "update-ticket", method: "PUT", urlTemplate: ticket,
      headers: { Authorization: "Basic {{connection:acmedesk}}" },
      bodyTemplate: { ticket: { subject: "{{input.subject}}" } },
      inputSchema: {
        type: "object", additionalProperties: false, required: ["id", "subject"],
        properties: { id: { type: "string", pattern: "^[0-9]{1,20}$" }, subject: { type: "string", pattern: "^[\\s\\S]{1,200}$" } },
      },
      impact: { dimension: "resource_mutations", amount: "1", bound: "exact" },
      verify: { url: ticket, status: 200, match: [{ path: "ticket.subject", equals: "{{input.subject}}" }] },
    }, UNSCOPED_AUTHORITY, env);
    const input = { id: "7", subject: "Refund sent" };
    const as = (endUserId: string) => ({ environmentId: env, endUser: { endUserId, required: false } });
    const fields = (preview: { blocks: unknown[] }) => (preview.blocks as Array<{ fields?: Array<{ label: string; value: string }> }>).flatMap((b) => b.fields ?? []);

    const forAlice = await createPreviewForAction(ws, env, "update-ticket", input, { endUserId: "alice" });
    const forBob = await createPreviewForAction(ws, env, "update-ticket", input, { endUserId: "bob" });
    expect(forAlice.target).toMatchObject({ account: "alice-co.acmedesk.com", resourceKey: "http:alice-co.acmedesk.com/api/v2/tickets/7.json" });
    expect(forBob.target).toMatchObject({ account: "bob-co.acmedesk.com", resourceKey: "http:bob-co.acmedesk.com/api/v2/tickets/7.json" });
    expect(fields(forAlice)).toContainEqual({ label: "URL", value: "https://alice-co.acmedesk.com/api/v2/tickets/7.json" });
    expect(fields(forAlice)).toContainEqual({ label: "Target account", value: "alice-co.acmedesk.com" });
    expect(fields(forAlice).find((f) => f.label === "Read-back")?.value).toContain("GET https://alice-co.acmedesk.com/api/v2/tickets/7.json");
    for (const preview of [forAlice, forBob]) {
      expect(JSON.stringify(preview)).not.toContain("{{connection.host}}");
      expect(JSON.stringify(preview)).not.toContain(ALICE);
      expect(JSON.stringify(preview)).not.toContain(BOB);
    }
    expect(state.sent).toEqual([]);

    const reviewed = await createPreviewForAction(ws, env, "update-ticket", input, { endUserId: "alice" });
    await connections.setEndUserApiKey(scope, "alice", "acmedesk", { fields: { subdomain: "alice-new", email: "alice@alice.test", apiToken: ALICE } }, actor);
    await expect(invokeAction(ws, "update-ticket", input, { ...as("alice"), effect: { previewId: reviewed.id, operationKey: "op_after_move" } }))
      .rejects.toMatchObject({ code: "PREVIEW_MISMATCH" });
    expect(state.sent).toEqual([]);
    await sql("DELETE FROM actions WHERE name = 'update-ticket'");
  });
});

describe("authoring an action on {{connection.host}}", () => {
  it("needs exactly one per-account credential, and the placeholder only as the host", async () => {
    const create = (urlTemplate: string, headers: Record<string, string>) =>
      createAction(ws, { name: `a-${Math.random().toString(36).slice(2, 8)}`, method: "GET", urlTemplate, headers }, UNSCOPED_AUTHORITY, env);
    await expect(create("https://{{connection.host}}/x", { Authorization: "Basic {{connection:acmedesk}}" })).resolves.toMatchObject({ urlTemplate: "https://{{connection.host}}/x" });
    await expect(create("https://{{connection.host}}/x", { Authorization: "Bearer {{connection:github}}" })).rejects.toThrow(/may only be sent to api\.github\.com/);
    await expect(create("https://{{connection.host}}/x", {})).rejects.toThrow(/exactly one account/);
    await expect(create("https://acme.acmedesk.com/x", { Authorization: "Basic {{connection:acmedesk}}" })).rejects.toThrow(/may only be sent to \{\{connection\.host\}\}/);
    await expect(create("https://evil.test/x", { Authorization: "Basic {{connection:acmedesk}}" })).rejects.toThrow();
    await expect(create("https://{{connection.host}}.evil.test/x", { Authorization: "Basic {{connection:acmedesk}}" })).rejects.toThrow(/whole host/);
    await expect(create("https://{{connection.host}}/x", { Authorization: "Basic {{connection:acmedesk}}", "X-Host": "{{connection.host}}" })).rejects.toThrow(/only be the host/);
    await expect(create("https://{{connection.host}}/x?k={{connection:acmedesk}}", {})).rejects.toThrow();
  });
});
