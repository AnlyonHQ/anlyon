import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
    return new Response(JSON.stringify({ number: 7, state: "closed" }), { status: 200, headers: { "content-type": "application/json" } });
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

const connections = await import("../src/core/end-users/connections.ts");
const { keyCheck } = await import("../src/core/connections/health.ts");
const { putSecret, getSecretMetadata } = await import("../src/core/actions/secrets.ts");
const { createAction, getAction, updateAction, invokeAction, UNSCOPED_AUTHORITY } = await import("../src/core/actions/service.ts");
const { installPack } = await import("../../sdks/typescript/sdk/src/resources/packs-core.ts");
type PackTransport = import("../../sdks/typescript/sdk/src/resources/packs-core.ts").PackTransport;

const ws = "00000000-0000-4000-8000-0000000000e7";
const env = "00000000-0000-4000-8000-0000000000f7";
const scope = { workspaceId: ws, environmentId: env };
const actor = { type: "api_key" as const, id: "00000000-0000-4000-8000-00000000bbbb" };
const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);
const manifest = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../packs/${name}/pack.json`), "utf8"));

const orNull = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return null;
    throw error;
  }
};

const created = { policies: 0, limits: 0 };
const transport: PackTransport = {
  getSecret: (name) => orNull(() => getSecretMetadata(ws, name, env)) as never,
  putSecret: (name, request) => putSecret(ws, name, request as never, env),
  getAction: (name) => orNull(() => getAction(ws, name, env)) as never,
  createAction: (request) => createAction(ws, request as never, UNSCOPED_AUTHORITY, env),
  updateAction: (name, request) => updateAction(ws, name, request as never, UNSCOPED_AUTHORITY, env),
  listPolicies: async () => [],
  createPolicy: async () => { created.policies++; },
  listLimits: async () => [],
  createLimit: async () => { created.limits++; },
};

const issue = { owner: "acme", repo: "app", issue_number: "7" };
const forUser = (endUserId: string | null) => ({ environmentId: env, endUser: { endUserId, required: false } });

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Acme Packs', 'acme-packs')", [ws]);
  await sql(
    `INSERT INTO environments (id, workspace_id, name, slug, kind, allowed_redirect_urls, default_redirect_url)
     VALUES ($1, $2, 'Production', 'prod', 'production', ARRAY['https://app.acme.test/connected'], 'https://app.acme.test/connected')`,
    [env, ws],
  );
}, 120_000);

beforeEach(() => {
  state.sent = [];
  vi.spyOn(keyCheck, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
});

describe("a catalogue pack, installed as it is", () => {
  it("installs every action with no workspace secret, each naming the connection", async () => {
    const result = await installPack(transport, manifest("github"));
    const actions = result.steps.filter((s) => s.kind === "action");
    expect(actions).toHaveLength(manifest("github").actions.length);
    expect(actions.every((s) => s.outcome === "created")).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: "connection", name: "connection:github", outcome: "skip" });
    expect((await sql("SELECT count(*)::int AS n FROM workspace_secrets WHERE workspace_id = $1", [ws])).rows[0]!.n).toBe(0);
    expect((await getAction(ws, "github-get-issue", env)).headers).toMatchObject({ Authorization: "Bearer {{connection:github}}" });
  });

  it("sends the calling end user's own key, and answers 409 for one who has not connected", async () => {
    await connections.setEndUserApiKey(scope, "alice", "github", "ghp_alice_token_000000", actor);

    const read = await invokeAction(ws, "github-get-issue", issue, forUser("alice"));
    expect(read).toMatchObject({ status: "succeeded", endUserId: "alice" });
    expect(state.sent).toEqual([{ url: "https://api.github.com/repos/acme/app/issues/7", authorization: "Bearer ghp_alice_token_000000" }]);

    await expect(invokeAction(ws, "github-get-issue", issue, forUser("bob")))
      .rejects.toMatchObject({ statusCode: 409, code: "END_USER_NOT_CONNECTED", integration: "github" });
    expect(state.sent).toHaveLength(1);
  });

  it("with no end user, sends the environment's connected account, and nothing when there is none", async () => {
    const before = await invokeAction(ws, "github-get-issue", issue, forUser(null)).catch((error: unknown) => error);
    expect(JSON.stringify(before)).toMatch(/connected GitHub account in this environment|SECRET_NOT_FOUND|failed/);
    expect(state.sent).toEqual([]);

    await putSecret(ws, "GITHUB", { value: "ghp_workspace_token_00", integrationId: "github", allowedHosts: ["api.github.com"], allowedPlacements: ["header"], checked: true }, env);
    const read = await invokeAction(ws, "github-get-issue", issue, forUser(null));
    expect(read).toMatchObject({ status: "succeeded" });
    expect(state.sent).toEqual([{ url: "https://api.github.com/repos/acme/app/issues/7", authorization: "Bearer ghp_workspace_token_00" }]);
  });
});

describe("installed bound to a workspace secret", () => {
  it("names the secret, and a call for an end user still uses the end user's key", async () => {
    const result = await installPack(transport, manifest("github"), { credential: "secret", actions: ["get-repository"], noPrefix: true });
    expect(result.steps.map((s) => `${s.kind}:${s.name}:${s.outcome}`)).toEqual(["secret:GITHUB:skip", "action:get-repository:created"]);
    expect((await getAction(ws, "get-repository", env)).headers).toMatchObject({ Authorization: "Bearer {{secret:GITHUB}}" });

    await invokeAction(ws, "get-repository", { owner: "acme", repo: "app" }, forUser("alice"));
    await invokeAction(ws, "get-repository", { owner: "acme", repo: "app" }, forUser(null));
    expect(state.sent.map((s) => s.authorization)).toEqual(["Bearer ghp_alice_token_000000", "Bearer ghp_workspace_token_00"]);
  });
});

describe("a paused integration", () => {
  it("still installs: pausing stops new connections, not the accounts already connected", async () => {
    const result = await installPack(transport, manifest("slack"));
    expect(result.steps.filter((s) => s.kind === "action").every((s) => s.outcome === "created")).toBe(true);
    expect((await getAction(ws, "slack-post-message", env)).headers).toMatchObject({ Authorization: "Bearer {{connection:slack}}" });
  });
});
