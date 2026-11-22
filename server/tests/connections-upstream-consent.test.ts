import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined, store: new Map<string, string>() }));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client), pool: { end: async () => {} } };
});
vi.mock("../src/lib/redis.ts", () => {
  const redis = {
    async set(key: string, value: string) {
      state.store.set(key, value);
      return "OK";
    },
    async get(key: string) {
      return state.store.get(key) ?? null;
    },
    async getdel(key: string) {
      const value = state.store.get(key) ?? null;
      state.store.delete(key);
      return value;
    },
    async pttl(key: string) {
      return state.store.has(key) ? 60_000 : -2;
    },
    async del(key: string) {
      return state.store.delete(key) ? 1 : 0;
    },
  };
  return { redis, redisBlocking: redis, RedisKeys: {}, createBlockingConnection: () => redis };
});

const { createNativeProvider, readJson } = await import("../src/core/connections/native.ts");
const { OAUTH_APPS } = await import("../src/core/connections/oauth-apps.ts");

const ISSUER = "https://auth.vendor.example";
const KEY = "test-connections-encryption-key-32chars";
const UPSTREAM = "mcp-00000000-0000-4000-8000-000000000001";

function setup(options: { requireIss?: boolean; namesDeveloper?: boolean } = {}) {
  const exchanges: string[] = [];
  const spec = {
    credentials: "MCP_UPSTREAM", authorizeUrl: `${ISSUER}/authorize`, tokenUrl: `${ISSUER}/token`, scopeSeparator: " ", pkce: true,
    clientAuth: "none", response: "standard", issuer: ISSUER, requireIssuerInResponse: options.requireIss ?? false,
  };
  const provider = createNativeProvider({
    origin: "https://api.anlyon.test",
    encryptionKey: KEY,
    clientFor: () => ({ clientId: "catalogue-client", clientSecret: "catalogue-secret" }),
    upstreamApp: async () => ({ spec: spec as never, scopes: [], client: { clientId: "c", clientSecret: "" }, ...(options.namesDeveloper === undefined ? {} : { namesDeveloper: options.namesDeveloper }) }),
    fetch: async (url: string) => {
      exchanges.push(url);
      return new Response(JSON.stringify({ access_token: "tok", token_type: "bearer" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { provider, exchanges };
}

describe("an upstream's consent", () => {
  let endUserId: string;

  beforeAll(async () => {
    const { rows: [ws] } = await state.client!.query<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Up', 'up-consent') RETURNING id`);
    const { rows: [env] } = await state.client!.query<{ id: string }>(
      `INSERT INTO environments (workspace_id, name, slug, is_default) VALUES ($1, 'Production', 'production-up', true) RETURNING id`, [ws!.id],
    );
    endUserId = `ws_${ws!.id}:env_${env!.id}:csn_abcdefghij`;
  }, 120_000);
  beforeEach(() => state.store.clear());

  async function finish(provider: ReturnType<typeof createNativeProvider>, iss: string | null | undefined, integrationKey = UPSTREAM) {
    const { sessionToken } = await provider.createConnectSession({ endUserId, integrationKey });
    const authorize = new URL((await provider.beginConsent(sessionToken))!);
    return provider.finishConsent({ state: authorize.searchParams.get("state"), code: "code", error: null, ...(iss === undefined ? {} : { iss }) });
  }

  it("refuses a code from another authorization server, and sends it nowhere", async () => {
    const { provider, exchanges } = setup();
    expect(await finish(provider, "https://honest.vendor.example")).toMatchObject({ ok: false, reason: "provider_error" });
    expect(exchanges).toEqual([]);
  });

  it("takes the issuer it was started for, trailing slash or not", async () => {
    for (const iss of [ISSUER, `${ISSUER}/`]) {
      const { provider, exchanges } = setup();
      expect(await finish(provider, iss)).toMatchObject({ ok: true });
      expect(exchanges).toEqual([`${ISSUER}/token`]);
    }
  });

  it("takes a redirect with no issuer, unless the server said it always sends one", async () => {
    const lax = setup();
    expect(await finish(lax.provider, null)).toMatchObject({ ok: true });
    const strict = setup({ requireIss: true });
    expect(await finish(strict.provider, null)).toMatchObject({ ok: false, reason: "provider_error" });
    expect(strict.exchanges).toEqual([]);
    const strictWithIt = setup({ requireIss: true });
    expect(await finish(strictWithIt.provider, ISSUER)).toMatchObject({ ok: true });
  });

  it("a catalogue integration ignores `iss`, as it always has", async () => {
    expect(OAUTH_APPS.github).toBeDefined();
    const { provider } = setup();
    expect(await finish(provider, "https://anything.example", "github")).toMatchObject({ ok: true });
  });

  it("tells the page who the vendor's screen will name", async () => {
    const peek = async (namesDeveloper?: boolean) => {
      const { provider } = setup({ namesDeveloper });
      const { sessionToken } = await provider.createConnectSession({ endUserId, integrationKey: UPSTREAM });
      return (await provider.peekConsent(sessionToken))?.ownApp;
    };
    expect(await peek(true)).toBe(true);
    expect(await peek(false)).toBe(false);
  });
});

describe("a provider's answer", () => {
  it("is read to a limit and no further: an endless token endpoint cannot fill the process", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(32);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
    });
    expect(await readJson(new Response(body))).toBeNull();
    expect(pulled * chunk.byteLength).toBeLessThan(4 * 1024 * 1024);
  });

  it("reads a normal answer", async () => {
    expect(await readJson(new Response(JSON.stringify({ access_token: "t" })))).toEqual({ access_token: "t" });
    expect(await readJson(new Response("not json"))).toBeNull();
  });
});
