import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MASTER = "a-master-key-that-is-at-least-32-chars";
const VALUE = "store_value_9f3a_not_a_key";
const TOKEN = "<your-vault-token>";

const dbState: { selectResults: unknown[][]; updated: unknown[]; inserted: unknown[] } = { selectResults: [], updated: [], inserted: [] };
const mockDb = {
  select: vi.fn(() => {
    const node: Record<string, unknown> = {};
    for (const m of ["from", "where", "limit", "orderBy"]) node[m] = vi.fn(() => node);
    node.then = (resolve: (rows: unknown[]) => void) => resolve(dbState.selectResults.shift() ?? []);
    return node;
  }),
  insert: vi.fn(() => ({
    values: vi.fn((v: Record<string, unknown>) => {
      dbState.inserted.push(v);
      return {
        returning: vi.fn().mockResolvedValue([{ secretId: "sec_new", lastUsedAt: null, createdAt: new Date(), updatedAt: new Date(), ...v }]),
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      };
    }),
  })),
  update: vi.fn(() => ({
    set: vi.fn((v: unknown) => {
      dbState.updated.push(v);
      return { where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]), then: (r: (x: unknown) => unknown) => Promise.resolve(undefined).then(r) })) };
    }),
  })),
};
vi.mock("../../db/index.ts", () => ({ db: mockDb }));
vi.mock("../../lib/logger.ts", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("../../config/env.ts", () => ({ env: { DELIVERY_SECRET_MASTER_KEY: MASTER } }));
vi.mock("../../lib/safe-http.ts", () => ({ safeFetch: vi.fn() }));
vi.mock("../billing/usage-enforcement.ts", () => ({ checkSecretQuota: vi.fn() }));
vi.mock("../events/emitter.ts", () => ({ emitEvent: vi.fn() }));
vi.mock("../connections/provider.ts", () => ({ requireConnectionProvider: vi.fn(), ConnectionRevokedError: class extends Error {} }));
vi.mock("../environments/service.ts", () => ({ assertNotProtected: vi.fn() }));
const edition = { enabled: true, cloud: true };
vi.mock("../edition/features.ts", () => ({ isFeatureEnabled: () => edition.enabled }));
vi.mock("../edition/edition.ts", () => ({
  isCloudEdition: () => edition.cloud,
  currentEdition: () => (edition.cloud ? "cloud" : "enterprise"),
}));

const { encryptSecret } = await import("../../utils/crypto.ts");
const { resolveSecrets, checkExternalSecret, putExternalSecret } = await import("../actions/secrets.ts");
const { updateSecretStoreSettings, getSecretStoreSettings, updateSecretStore, destinationChanges } = await import("./service.ts");
const { redactSecrets } = await import("../actions/template.ts");
const { storeHttp } = await import("./http.ts");
const { cacheClear } = await import("./cache.ts");
const { setStoredInstanceSettingsForTest } = await import("../instance/settings.ts");

const WS = "ws_1";
const ENV = "env_1";

function storeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "store-row-1", workspaceId: WS, environmentId: ENV, storeId: "sst_1", name: "prod-vault", type: "hashicorp_vault",
    config: { address: "https://vault.example.com", mount: "secret", auth: "token" },
    credentialEncrypted: encryptSecret(JSON.stringify({ token: TOKEN }), MASTER, { store: "secret-store", workspaceId: WS, environmentId: ENV, name: "sst_1" }),
    allowedPaths: null, cacheTtlSeconds: 30, health: null, description: null,
    createdAt: new Date(), updatedAt: new Date("2026-10-19T00:00:00Z"),
    ...overrides,
  };
}

function secretRow(overrides: Record<string, unknown> = {}) {
  const ref = { storeRowId: "store-row-1", store: "prod-vault", storeType: "hashicorp_vault", path: "payments/stripe", key: "apiKey", version: null };
  return {
    id: "secret-row-1", workspaceId: WS, environmentId: ENV, secretId: "sec_1", name: "STRIPE_KEY",
    valueEncrypted: encryptSecret(JSON.stringify(ref), MASTER, { store: "vault", workspaceId: WS, environmentId: ENV, name: "STRIPE_KEY" }),
    description: null, lastUsedAt: null, allowedHosts: ["api.stripe.com"], allowedPlacements: ["header"],
    kind: "external", connection: null, integrationId: null, health: { status: "active", checkedAt: null, reason: null },
    secretStoreId: "store-row-1", external: ref, createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

let answers: Response[] = [];
let calls = 0;
const privateNetworkSeen: boolean[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectResults = [];
  dbState.updated = [];
  dbState.inserted = [];
  answers = [];
  calls = 0;
  privateNetworkSeen.length = 0;
  edition.enabled = true;
  edition.cloud = true;
  setStoredInstanceSettingsForTest({});
  vi.stubEnv("PRIVATE_NETWORK_DESTINATIONS", undefined);
  cacheClear();
  storeHttp.fetch = vi.fn(async (_url, init) => {
    calls++;
    privateNetworkSeen.push(init.privateNetwork ?? false);
    const next = answers.shift();
    if (!next) throw new Error("connect ECONNREFUSED");
    return next;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const vaultAnswer = () => new Response(JSON.stringify({ data: { data: { apiKey: VALUE } } }), { status: 200 });

describe("resolveSecrets with an external secret", () => {
  it("puts the store's value in the dispatch map, and redaction scrubs it like a stored value", async () => {
    dbState.selectResults.push([secretRow()], [storeRow()]);
    answers.push(vaultAnswer());
    const map = await resolveSecrets(WS, ["STRIPE_KEY"], ENV);
    expect(map.get("STRIPE_KEY")).toBe(VALUE);
    expect(redactSecrets(`upstream echoed ${VALUE}`, map)).toBe("upstream echoed [REDACTED]");
    expect(JSON.stringify(dbState.updated)).not.toContain(VALUE);
  });

  it("serves a second dispatch from memory within the TTL, and asks the store again after it", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-19T10:00:00Z") });
    try {
      dbState.selectResults.push([secretRow()], [storeRow()], [secretRow()], [storeRow()], [secretRow()], [storeRow()]);
      answers.push(vaultAnswer(), vaultAnswer());
      await resolveSecrets(WS, ["STRIPE_KEY"], ENV);
      await resolveSecrets(WS, ["STRIPE_KEY"], ENV);
      expect(calls).toBe(1);
      vi.advanceTimersByTime(31_000);
      await resolveSecrets(WS, ["STRIPE_KEY"], ENV);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads on every dispatch when the store's TTL is 0, and a changed store drops what it cached", async () => {
    dbState.selectResults.push([secretRow()], [storeRow({ cacheTtlSeconds: 0 })], [secretRow()], [storeRow({ cacheTtlSeconds: 0 })]);
    answers.push(vaultAnswer(), vaultAnswer());
    await resolveSecrets(WS, ["STRIPE_KEY"], ENV);
    await resolveSecrets(WS, ["STRIPE_KEY"], ENV);
    expect(calls).toBe(2);

    dbState.selectResults.push([secretRow()], [storeRow()], [secretRow()], [storeRow({ updatedAt: new Date("2026-10-19T01:00:00Z") })]);
    answers.push(vaultAnswer(), vaultAnswer());
    await resolveSecrets(WS, ["STRIPE_KEY"], ENV);
    await resolveSecrets(WS, ["STRIPE_KEY"], ENV);
    expect(calls).toBe(4);
  });

  it.each([
    [() => new Response("{}", { status: 503 }), "store_unreachable", /did not answer/],
    [() => new Response("{}", { status: 403 }), "store_denied", /refused Anlyon's credential/],
    [() => new Response("{}", { status: 404 }), "reference_not_found", /no secret at that path/],
  ])("fails closed before dispatch, named and gradeable (%#)", async (answer, reason, text) => {
    dbState.selectResults.push([secretRow()], [storeRow()]);
    answers.push(answer());
    const error = await resolveSecrets(WS, ["STRIPE_KEY"], ENV).then(() => null, (e: unknown) => e) as Record<string, unknown>;
    expect(error).toMatchObject({ statusCode: 424, code: "EXTERNAL_SECRET_UNAVAILABLE", details: { secret: "STRIPE_KEY", store: "prod-vault", reason } });
    expect(String(error.message)).toMatch(text);
    expect(String(error.message)).toContain("Nothing was sent");
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(dbState.updated).toContainEqual({ health: expect.objectContaining({ status: "unreachable", reason }) });
  });

  it("a store that does not answer at all fails closed too", async () => {
    dbState.selectResults.push([secretRow()], [storeRow()]);
    await expect(resolveSecrets(WS, ["STRIPE_KEY"], ENV)).rejects.toMatchObject({ code: "EXTERNAL_SECRET_UNAVAILABLE", details: { reason: "store_unreachable" } });
  });

  it("refuses a path the store's allowed paths no longer cover, without calling the store", async () => {
    dbState.selectResults.push([secretRow()], [storeRow({ allowedPaths: ["billing"] })]);
    await expect(resolveSecrets(WS, ["STRIPE_KEY"], ENV)).rejects.toMatchObject({ details: { reason: "store_denied" } });
    expect(calls).toBe(0);
  });

  it("fails closed on an edition without secret stores", async () => {
    edition.enabled = false;
    dbState.selectResults.push([secretRow()]);
    await expect(resolveSecrets(WS, ["STRIPE_KEY"], ENV)).rejects.toMatchObject({ code: "SECRET_STORES_UNAVAILABLE" });
    expect(calls).toBe(0);
  });
});

describe("checkExternalSecret", () => {
  it("records reachability as health, bypassing the cache, and returns no value", async () => {
    dbState.selectResults.push([secretRow()], [storeRow()]);
    answers.push(vaultAnswer());
    const view = await checkExternalSecret(WS, ENV, "STRIPE_KEY");
    expect(view).toMatchObject({ kind: "external", health: { status: "active", reason: null }, external: { store: "prod-vault", path: "payments/stripe", key: "apiKey" } });
    expect(JSON.stringify(view)).not.toContain(VALUE);

    dbState.selectResults.push([secretRow()], [storeRow()]);
    answers.push(new Response("{}", { status: 403 }));
    expect(await checkExternalSecret(WS, ENV, "STRIPE_KEY")).toMatchObject({ health: { status: "unreachable", reason: "store_denied" } });
  });
});

describe("putExternalSecret", () => {
  const external = { store: "prod-vault", path: "payments/stripe", key: "apiKey" };
  const allowedHosts = ["api.stripe.com"];

  it("saves a reference the store cannot produce yet, as unreachable, with a warning", async () => {
    dbState.selectResults.push([], [storeRow()], [storeRow()]);
    answers.push(new Response("{}", { status: 404 }));
    const { secret, warning } = await putExternalSecret(WS, "STRIPE_KEY", { external, allowedHosts }, ENV);
    expect(warning).toMatchObject({ code: "EXTERNAL_SECRET_UNREADABLE", reason: "reference_not_found" });
    expect(warning!.message).toMatch(/was saved.*fail before anything is sent/);
    expect(secret).toMatchObject({ kind: "external", health: { status: "unreachable", reason: "reference_not_found" } });
    expect(dbState.inserted[0]).toMatchObject({ kind: "external", health: { status: "unreachable", reason: "reference_not_found" } });
    expect(JSON.stringify(dbState.inserted)).not.toContain(VALUE);
  });

  it("saves a readable reference as active, with no warning, and keeps no value", async () => {
    dbState.selectResults.push([], [storeRow()], [storeRow()]);
    answers.push(vaultAnswer());
    const { secret, warning } = await putExternalSecret(WS, "STRIPE_KEY", { external, allowedHosts }, ENV);
    expect(warning).toBeNull();
    expect(secret.health).toMatchObject({ status: "active" });
    expect(JSON.stringify(dbState.inserted)).not.toContain(VALUE);
  });

  it("refuses an external secret that names no hosts, and defaults its placement to a header", async () => {
    dbState.selectResults.push([]);
    await expect(putExternalSecret(WS, "STRIPE_KEY", { external }, ENV)).rejects.toThrow(/must name the hosts/);
    dbState.selectResults.push([]);
    await expect(putExternalSecret(WS, "STRIPE_KEY", { external, allowedHosts: [] }, ENV)).rejects.toThrow(/must name the hosts/);
    expect(dbState.inserted).toEqual([]);
    dbState.selectResults.push([], [storeRow()], [storeRow()]);
    answers.push(vaultAnswer());
    await putExternalSecret(WS, "STRIPE_KEY", { external, allowedHosts }, ENV);
    expect(dbState.inserted[0]).toMatchObject({ allowedHosts, allowedPlacements: ["header"] });
  });

  it("still refuses a reference that is wrong in itself", async () => {
    dbState.selectResults.push([], [storeRow({ allowedPaths: ["billing"] })]);
    await expect(putExternalSecret(WS, "STRIPE_KEY", { external, allowedHosts }, ENV)).rejects.toThrow(/allows only paths under billing/);
    expect(dbState.inserted).toEqual([]);
  });
});

describe("the private network setting", () => {
  it("is honoured on a self-hosted edition when the admin turned it on", async () => {
    edition.cloud = false;
    dbState.selectResults.push([secretRow()], [storeRow()], [{ allow: true }]);
    answers.push(vaultAnswer());
    await resolveSecrets(WS, ["STRIPE_KEY"], ENV);
    expect(privateNetworkSeen).toEqual([true]);
  });

  it("is off by default on a self-hosted edition", async () => {
    edition.cloud = false;
    dbState.selectResults.push([secretRow()], [storeRow()], []);
    answers.push(vaultAnswer());
    await resolveSecrets(WS, ["STRIPE_KEY"], ENV);
    expect(privateNetworkSeen).toEqual([false]);
  });

  it("is never honoured on the hosted service, and cannot be set there", async () => {
    dbState.selectResults.push([secretRow()], [storeRow()]);
    answers.push(vaultAnswer());
    await resolveSecrets(WS, ["STRIPE_KEY"], ENV);
    expect(privateNetworkSeen).toEqual([false]);
    await expect(updateSecretStoreSettings(WS, { allowPrivateNetwork: true }, "user_1")).rejects.toThrow(/self-hosted setting/);
    dbState.selectResults.push([{ workspaceId: WS, allowPrivateNetwork: true, updatedAt: new Date() }]);
    expect(await getSecretStoreSettings(WS)).toMatchObject({ allowPrivateNetwork: true, available: false, effective: false });
  });

  it("is not honoured where an instance admin turned private destinations off, whatever the workspace chose", async () => {
    edition.cloud = false;
    setStoredInstanceSettingsForTest({ "network.private_destinations": "off" });
    dbState.selectResults.push([secretRow()], [storeRow()]);
    answers.push(vaultAnswer());
    await resolveSecrets(WS, ["STRIPE_KEY"], ENV);
    expect(privateNetworkSeen).toEqual([false]);
    dbState.selectResults.push([{ workspaceId: WS, allowPrivateNetwork: true, updatedAt: new Date() }]);
    expect(await getSecretStoreSettings(WS)).toMatchObject({ allowPrivateNetwork: true, available: false, effective: false });
  });

  it("cannot be turned on where an instance admin turned private destinations off, and can be turned off", async () => {
    edition.cloud = false;
    vi.stubEnv("PRIVATE_NETWORK_DESTINATIONS", "off");
    await expect(updateSecretStoreSettings(WS, { allowPrivateNetwork: true }, "user_1")).rejects.toThrow(/instance admin has turned off private network destinations/);
    expect(dbState.inserted).toEqual([]);
    dbState.selectResults.push([{ workspaceId: WS, allowPrivateNetwork: false, updatedAt: new Date() }]);
    const view = await updateSecretStoreSettings(WS, { allowPrivateNetwork: false }, "user_1");
    expect(dbState.inserted[0]).toMatchObject({ workspaceId: WS, allowPrivateNetwork: false });
    expect(view).toMatchObject({ allowPrivateNetwork: false, available: false, effective: false });
  });

  it("is honoured again when the instance admins leave it to the workspaces", async () => {
    edition.cloud = false;
    setStoredInstanceSettingsForTest({ "network.private_destinations": "workspace" });
    dbState.selectResults.push([secretRow()], [storeRow()], [{ allow: true }]);
    answers.push(vaultAnswer());
    await resolveSecrets(WS, ["STRIPE_KEY"], ENV);
    expect(privateNetworkSeen).toEqual([true]);
  });

  it("is saved by a workspace admin on a self-hosted edition", async () => {
    edition.cloud = false;
    dbState.selectResults.push([{ workspaceId: WS, allowPrivateNetwork: true, updatedAt: new Date() }]);
    const view = await updateSecretStoreSettings(WS, { allowPrivateNetwork: true }, "user_1");
    expect(dbState.inserted[0]).toMatchObject({ workspaceId: WS, allowPrivateNetwork: true, updatedBy: "user_1" });
    expect(view).toMatchObject({ allowPrivateNetwork: true, available: true, effective: true });
  });
});

describe("changing where a store's credential is sent", () => {
  const scope = { workspaceId: WS, environmentId: ENV };
  const NEW_TOKEN = "<your-new-vault-token>";

  it("refuses a new Vault address without the credential, before anything is sent", async () => {
    dbState.selectResults.push([storeRow()]);
    await expect(updateSecretStore(scope, "prod-vault", { config: { address: "https://vault.attacker.example" } }))
      .rejects.toThrow(/config\.address sends the store's credential somewhere new, so send credential again/);
    expect(calls).toBe(0);
    expect(dbState.updated).toEqual([]);
  });

  it("refuses every field that moves the credential, for both store types", () => {
    const vault = { address: "https://vault.example.com", mount: "secret", auth: "token" as const };
    expect(destinationChanges("hashicorp_vault", vault, { ...vault, namespace: "team-b" })).toEqual(["namespace"]);
    expect(destinationChanges("hashicorp_vault", vault, { ...vault, mount: "kv" })).toEqual(["mount"]);
    expect(destinationChanges("hashicorp_vault", { ...vault, auth: "approle", authMount: "approle" }, { ...vault, auth: "approle", authMount: "other" })).toEqual(["authMount"]);
    const aws = { region: "eu-west-1", auth: "assume_role" as const, roleArn: "arn:aws:iam::123456789012:role/a", externalId: null };
    expect(destinationChanges("aws_secrets_manager", aws, { ...aws, region: "us-east-1" })).toEqual(["region"]);
    expect(destinationChanges("aws_secrets_manager", aws, { ...aws, roleArn: "arn:aws:iam::210987654321:role/b" })).toEqual(["roleArn"]);
    expect(destinationChanges("aws_secrets_manager", aws, { ...aws, externalId: "ext-2" })).toEqual(["externalId"]);
    expect(destinationChanges("hashicorp_vault", vault, { ...vault, namespace: null })).toEqual([]);
  });

  it("accepts a new address with a new credential, and checks the new credential there", async () => {
    dbState.selectResults.push([storeRow()]);
    answers.push(new Response("{}", { status: 200 }));
    const sent: Array<{ url: string; token: string | undefined }> = [];
    const original = storeHttp.fetch;
    storeHttp.fetch = vi.fn(async (url, init) => { sent.push({ url, token: init.headers["x-vault-token"] }); return original(url, init); });
    mockDb.update.mockImplementationOnce(() => ({
      set: vi.fn((v: unknown) => {
        dbState.updated.push(v);
        return { where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([storeRow({ config: { address: "https://vault2.example.com", mount: "secret", auth: "token" } })]) })) };
      }),
    }) as never);
    const view = await updateSecretStore(scope, "prod-vault", { config: { address: "https://vault2.example.com" }, credential: { token: NEW_TOKEN } });
    expect(view.config).toMatchObject({ address: "https://vault2.example.com" });
    expect(sent).toEqual([{ url: "https://vault2.example.com/v1/auth/token/lookup-self", token: NEW_TOKEN }]);
  });

  it("still lets a change that does not move the credential reuse the stored one", async () => {
    dbState.selectResults.push([storeRow()]);
    answers.push(new Response("{}", { status: 200 }));
    mockDb.update.mockImplementationOnce(() => ({
      set: vi.fn((v: unknown) => {
        dbState.updated.push(v);
        return { where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([storeRow()]) })) };
      }),
    }) as never);
    await updateSecretStore(scope, "prod-vault", { config: { address: "https://vault.example.com" } });
    expect(calls).toBe(1);
    expect(dbState.updated).toHaveLength(1);
  });
});
