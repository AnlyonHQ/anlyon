import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client), pool: { end: async () => {} } };
});

const { db } = await import("../src/db/index.ts");
const { drizzleAdapter } = await import("better-auth/adapters/drizzle");
const { sso } = await import("@better-auth/sso");
const schema = await import("../src/db/schema/index.ts");
const { withSsoSecretEncryption } = await import("../src/core/sso/secret-fields.ts");
const { encryptExistingSsoSecrets } = await import("../src/core/sso/secret-backfill.ts");

const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  state.client!.query<T>(text, params).then((r) => r.rows);

const SECRET = "<your-client-secret>-test-value";
const SAML_KEY = "<your-saml-private-key>-test-key-material";

type Adapter = {
  create: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  findOne: (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  findMany: (input: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  update: (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  transaction: <R>(fn: (trx: Adapter) => Promise<R>) => Promise<R>;
};

let adapter: Adapter;

beforeAll(async () => {
  const factory = withSsoSecretEncryption(
    drizzleAdapter(db as never, {
      provider: "pg",
      schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification, ssoProvider: schema.ssoProvider },
    }),
  );
  adapter = factory({ plugins: [sso({ domainVerification: { enabled: true } })] } as never) as unknown as Adapter;
  await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('u-enc', 'A', 'a@acme.com', true, now(), now())`);
}, 120_000);

const where = (providerId: string) => [{ field: "providerId", value: providerId }];
const raw = async (providerId: string) =>
  (await sql<{ oidc_config: string | null; saml_config: string | null }>("SELECT oidc_config, saml_config FROM sso_provider WHERE provider_id = $1", [providerId]))[0];

describe("SSO provider secrets at rest", () => {
  it("stores the OIDC client secret encrypted and returns it to the plugin decrypted", async () => {
    const created = await adapter.create({
      model: "ssoProvider",
      data: {
        issuer: "https://acme.okta.com",
        domain: "acme.com",
        providerId: "p-oidc",
        userId: "u-enc",
        oidcConfig: JSON.stringify({ clientId: "client-id", clientSecret: SECRET, issuer: "https://acme.okta.com" }),
      },
    });
    expect(JSON.parse(created.oidcConfig as string).clientSecret).toBe(SECRET);

    const stored = await raw("p-oidc");
    expect(stored.oidc_config).not.toContain(SECRET);
    const storedSecret = JSON.parse(stored.oidc_config!).clientSecret as string;
    expect(storedSecret.startsWith("enc:v3.")).toBe(true);
    expect(JSON.parse(stored.oidc_config!).clientId).toBe("client-id");

    const found = await adapter.findOne({ model: "ssoProvider", where: where("p-oidc") });
    expect(JSON.parse(found!.oidcConfig as string).clientSecret).toBe(SECRET);
    const all = await adapter.findMany({ model: "ssoProvider" });
    expect(JSON.parse(all.find((p) => p.providerId === "p-oidc")!.oidcConfig as string).clientSecret).toBe(SECRET);
  });

  it("encrypts SAML private key material, including nested SP and IdP keys, and inside a transaction", async () => {
    await adapter.transaction((trx) =>
      trx.create({
        model: "ssoProvider",
        data: {
          issuer: "https://idp.example/entity",
          domain: "acme.io",
          providerId: "p-saml",
          userId: "u-enc",
          samlConfig: JSON.stringify({
            entryPoint: "https://idp.example/sso",
            cert: "public-cert",
            privateKey: SAML_KEY,
            spMetadata: { entityID: "sp", privateKey: SAML_KEY, encPrivateKey: SAML_KEY },
            idpMetadata: { entityID: "idp", encPrivateKey: SAML_KEY },
          }),
        },
      }),
    );
    const stored = await raw("p-saml");
    expect(stored.saml_config).not.toContain("test-key-material");
    expect(JSON.parse(stored.saml_config!).cert).toBe("public-cert");

    const found = await adapter.findOne({ model: "ssoProvider", where: where("p-saml") });
    const config = JSON.parse(found!.samlConfig as string);
    expect([config.privateKey, config.spMetadata.privateKey, config.spMetadata.encPrivateKey, config.idpMetadata.encPrivateKey]).toEqual([
      SAML_KEY,
      SAML_KEY,
      SAML_KEY,
      SAML_KEY,
    ]);
  });

  it("encrypts on update", async () => {
    await adapter.update({
      model: "ssoProvider",
      where: where("p-oidc"),
      update: { oidcConfig: JSON.stringify({ clientId: "client-id", clientSecret: "rotated-secret" }) },
    });
    expect((await raw("p-oidc")).oidc_config).not.toContain("rotated-secret");
    const found = await adapter.findOne({ model: "ssoProvider", where: where("p-oidc") });
    expect(JSON.parse(found!.oidcConfig as string).clientSecret).toBe("rotated-secret");
  });

  it("refuses a ciphertext copied to another provider", async () => {
    const stolen = (await raw("p-oidc")).oidc_config;
    await sql(
      `INSERT INTO sso_provider (id, issuer, provider_id, domain, oidc_config) VALUES ('copy', 'https://x', 'p-copy', 'x.com', $1)`,
      [stolen],
    );
    await expect(adapter.findOne({ model: "ssoProvider", where: where("p-copy") })).rejects.toThrow();
    await sql("DELETE FROM sso_provider WHERE provider_id = 'p-copy'");
  });

  it("backfills rows stored in the clear, then has nothing left to do", async () => {
    await sql(
      `INSERT INTO sso_provider (id, issuer, provider_id, domain, oidc_config, saml_config) VALUES ('legacy', 'https://old', 'p-legacy', 'old.com', $1, NULL)`,
      [JSON.stringify({ clientId: "c", clientSecret: "legacy-secret" })],
    );
    const before = await adapter.findOne({ model: "ssoProvider", where: where("p-legacy") });
    expect(JSON.parse(before!.oidcConfig as string).clientSecret).toBe("legacy-secret");

    expect(await encryptExistingSsoSecrets(false)).toMatchObject({ plaintext: 1, rewritten: 0 });
    expect((await raw("p-legacy")).oidc_config).toContain("legacy-secret");

    expect(await encryptExistingSsoSecrets(true)).toMatchObject({ plaintext: 1, rewritten: 1 });
    expect((await raw("p-legacy")).oidc_config).not.toContain("legacy-secret");
    const after = await adapter.findOne({ model: "ssoProvider", where: where("p-legacy") });
    expect(JSON.parse(after!.oidcConfig as string).clientSecret).toBe("legacy-secret");

    expect(await encryptExistingSsoSecrets(true)).toMatchObject({ plaintext: 0, rewritten: 0 });
  });
});
