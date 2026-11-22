import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { providerFetch } from "./support/effects/provider-fetch.ts";

const logLines: string[] = [];
vi.mock("../src/lib/logger.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/logger.ts")>();
  const pino = (await import("pino")).default;
  const logger = pino({ level: "debug" }, { write: (line: string) => { logLines.push(line); } });
  return {
    ...actual,
    logger,
    createLogger: (context: Record<string, unknown>) => logger.child(context),
    apiLogger: logger.child({ module: "api" }),
    workerLogger: logger.child({ module: "worker" }),
    dbLogger: logger.child({ module: "database" }),
    redisLogger: logger.child({ module: "redis" }),
    authLogger: logger.child({ module: "auth" }),
  };
});

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});

const { EffectScope, loadEffectModules } = await import("./support/effects/fixture.ts");
const { HttpSimulator } = await import("./support/effects/http-simulator.ts");
const { setProviderFetchForHost } = await import("./support/effects/provider-fetch.ts");
const stores = await import("../src/core/secret-stores/service.ts");
const { storeHttp } = await import("../src/core/secret-stores/http.ts");
const { cacheClear } = await import("../src/core/secret-stores/cache.ts");

const CRM_HOST = "api.crm.example";
const VAULT_TOKEN = "<your-vault-token>";
const CRM_VALUE = "crm_value_held_only_in_the_store_7c1e";

class VaultSimulator {
  mode: "ok" | "down" | "denied" | "missing" = "ok";
  reads = 0;
  fetch = async (url: string, init: { headers: Record<string, string> }): Promise<Response> => {
    if (init.headers["x-vault-token"] !== VAULT_TOKEN) return new Response("{}", { status: 403 });
    if (url.endsWith("/v1/auth/token/lookup-self")) return new Response(JSON.stringify({ data: {} }), { status: 200 });
    if (!url.includes("/v1/secret/data/crm/prod")) return new Response("{}", { status: 404 });
    this.reads++;
    if (this.mode === "down") return new Response("{}", { status: 503 });
    if (this.mode === "denied") return new Response("{}", { status: 403 });
    if (this.mode === "missing") return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ data: { data: { token: CRM_VALUE } } }), { status: 200 });
  };
}

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("external secrets (real Postgres)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let m: Awaited<ReturnType<typeof loadEffectModules>>;
  let s: InstanceType<typeof EffectScope>;
  let crm: InstanceType<typeof HttpSimulator>;
  let vault: VaultSimulator;

  beforeAll(async () => {
    await pool.query("SELECT 1");
    m = await loadEffectModules();
  });
  beforeEach(async () => {
    s = await new EffectScope(pool, m).seed();
    crm = new HttpSimulator();
    crm.tokens.clear();
    crm.tokens.add(CRM_VALUE);
    setProviderFetchForHost(CRM_HOST, crm.fetch);
    vault = new VaultSimulator();
    storeHttp.fetch = vault.fetch as typeof storeHttp.fetch;
    cacheClear();
    logLines.length = 0;
  });
  afterEach(async () => {
    await pool.query("DELETE FROM workspace_secrets WHERE workspace_id = $1", [s.workspaceId]);
    await s.cleanup();
  });
  afterAll(async () => { await pool.end(); });

  const scope = () => ({ workspaceId: s.workspaceId, environmentId: s.environmentId });

  async function storeAndSecret(cacheTtlSeconds = 0) {
    await stores.createSecretStore(scope(), {
      name: "prod-vault", type: "hashicorp_vault",
      config: { address: "https://vault.example.com", auth: "token" },
      credential: { token: VAULT_TOKEN }, cacheTtlSeconds,
    });
    const { secret } = await m.secrets.putExternalSecret(s.workspaceId, "CRM_TOKEN", {
      external: { store: "prod-vault", path: "crm/prod", key: "token" },
      allowedHosts: [CRM_HOST], allowedPlacements: ["header"],
    }, s.environmentId);
    return secret;
  }

  function noteAction(name = "note-crm", governed = true) {
    const notes = `https://${CRM_HOST}/v1/notes`;
    return m.actions.createAction(s.workspaceId, {
      name,
      description: "Add a note. Limitation: no provider idempotency.",
      method: "PUT",
      urlTemplate: `${notes}/{{input.noteId}}`,
      headers: { Authorization: "Bearer {{secret:CRM_TOKEN}}" },
      bodyTemplate: { body: "{{input.body}}" },
      inputSchema: {
        type: "object", required: ["noteId", "body"],
        properties: { noteId: { type: "string", pattern: "^[a-z0-9-]{1,40}$" }, body: { type: "string" } },
      },
      ...(governed ? {
        impact: { dimension: "resource_mutations", amount: "1", bound: "exact" as const },
        verify: { url: `${notes}/{{input.noteId}}`, status: 200, match: [{ path: "body", equals: "{{input.body}}" }] },
      } : {}),
    }, m.actions.UNSCOPED_AUTHORITY, s.environmentId);
  }

  async function rowsContaining(needle: string): Promise<Record<string, number>> {
    const tables = (await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    )).rows.map((r) => r.table_name as string);
    const hits: Record<string, number> = {};
    for (const table of tables) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${table}" t WHERE t::text LIKE $1`, [`%${needle}%`]);
      if (rows[0].n > 0) hits[table] = rows[0].n;
    }
    return hits;
  }

  it("dispatches with the store's value, and neither the value nor the store's token is persisted or logged", async () => {
    const secret = await storeAndSecret();
    expect(secret).toMatchObject({ kind: "external", external: { store: "prod-vault", path: "crm/prod", key: "token" }, health: { status: "active" } });
    await noteAction();

    const result = await s.invoke("note-crm", { noteId: "n-1", body: "Refunded order 1042" });
    expect(result).toMatchObject({ status: "succeeded", grade: "confirmed" });
    expect(crm.requests.find((r) => r.method === "PUT")!.authorization).toBe(`Bearer ${CRM_VALUE}`);

    expect(await rowsContaining(CRM_VALUE)).toEqual({});
    expect(await rowsContaining(VAULT_TOKEN)).toEqual({});
    expect(logLines.filter((l) => l.includes(CRM_VALUE) || l.includes(VAULT_TOKEN))).toEqual([]);
  });

  it("a store that stops answering refuses a governed action at admission, with nothing sent", async () => {
    await storeAndSecret();
    await noteAction();
    vault.mode = "down";
    const refused = await s.invoke("note-crm", { noteId: "n-2", body: "not sent" }).catch((e) => e);
    expect(refused).toMatchObject({ code: "EXTERNAL_SECRET_UNAVAILABLE", statusCode: 424, details: { reason: "store_unreachable" } });
    expect(refused.message).toMatch(/Nothing was sent/);
    expect(crm.requests).toHaveLength(0);
    expect((await m.secrets.getSecretMetadata(s.workspaceId, "CRM_TOKEN", s.environmentId)).health)
      .toMatchObject({ status: "unreachable", reason: "store_unreachable" });
  });

  it("a secret removed from the store fails a template action as failed, with nothing sent", async () => {
    await storeAndSecret();
    await noteAction("note-plain", false);
    vault.mode = "missing";
    const result = await s.invoke("note-plain", { noteId: "n-3", body: "not sent" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/no secret at that path, version or key\. Nothing was sent/);
    expect(crm.requests).toHaveLength(0);
  });

  it("caches for the store's TTL, and a store with secrets pointing at it cannot be deleted", async () => {
    await storeAndSecret(60);
    await noteAction("note-plain", false);
    const readsAfterSave = vault.reads;
    await s.invoke("note-plain", { noteId: "n-4", body: "one" });
    await s.invoke("note-plain", { noteId: "n-5", body: "two" });
    expect(vault.reads - readsAfterSave).toBe(1);
    await expect(stores.deleteSecretStore(scope(), "prod-vault", { confirmProtected: true })).rejects.toMatchObject({ code: "SECRET_STORE_IN_USE" });
  });

  it("refuses a store it cannot sign in to, and saves a secret the store cannot produce yet, failing closed", async () => {
    await expect(stores.createSecretStore(scope(), {
      name: "wrong-token", type: "hashicorp_vault",
      config: { address: "https://vault.example.com", auth: "token" }, credential: { token: "<your-other-token>" },
    })).rejects.toMatchObject({ code: "SECRET_STORE_CHECK_FAILED", details: { reason: "store_denied" } });
    await storeAndSecret();
    await noteAction("note-plain", false);
    vault.mode = "missing";
    const saved = await m.secrets.putExternalSecret(s.workspaceId, "CRM_TOKEN", {
      external: { store: "prod-vault", path: "crm/prod", key: "token" },
    }, s.environmentId);
    expect(saved.warning).toMatchObject({ code: "EXTERNAL_SECRET_UNREADABLE", reason: "reference_not_found" });
    expect(saved.secret.health).toMatchObject({ status: "unreachable", reason: "reference_not_found" });
    const result = await s.invoke("note-plain", { noteId: "n-6", body: "not sent" });
    expect(result.status).toBe("failed");
    expect(crm.requests).toHaveLength(0);
  });
});
