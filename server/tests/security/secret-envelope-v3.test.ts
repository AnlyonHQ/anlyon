import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  decryptIntegrationToken,
  decryptSecret,
  encryptIntegrationToken,
  encryptSecret,
  masterKeyId,
  secretEnvelopeVersion,
} from "../../src/utils/crypto.ts";

const KEY = "a-master-key-that-is-at-least-32-characters";
const prod = { store: "vault" as const, workspaceId: "ws_1", environmentId: "env_prod", name: "STRIPE_KEY" };

function legacyV2(plaintext: string, store: string, workspaceId: string): string {
  const key = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(KEY), Buffer.from("anlyon.secret-envelope.v2"), Buffer.from(`store:${store}`), 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`v2|${store}|${workspaceId}`));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v2.${masterKeyId(KEY)}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64")}`;
}

function legacyV1(plaintext: string): string {
  const key = crypto.createHash("sha256").update(KEY).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

afterEach(() => {
  delete process.env.LEGACY_SECRET_ENVELOPE;
});

describe("v3 vault secrets", () => {
  it("round-trip in their own row", () => {
    const ct = encryptSecret("sk_live_x", KEY, prod);
    expect(secretEnvelopeVersion(ct)).toBe("v3");
    expect(decryptSecret(ct, KEY, prod)).toBe("sk_live_x");
  });

  it("do not decrypt in another environment's row", () => {
    const ct = encryptSecret("sk_live_x", KEY, prod);
    expect(() => decryptSecret(ct, KEY, { ...prod, environmentId: "env_staging" })).toThrow();
  });

  it("do not decrypt under another secret's name", () => {
    const ct = encryptSecret("sk_live_x", KEY, prod);
    expect(() => decryptSecret(ct, KEY, { ...prod, name: "LOW_VALUE_KEY" })).toThrow();
  });

  it("do not decrypt in another workspace or store", () => {
    const ct = encryptSecret("sk_live_x", KEY, prod);
    expect(() => decryptSecret(ct, KEY, { ...prod, workspaceId: "ws_2" })).toThrow();
    expect(() => decryptSecret(ct, KEY, { ...prod, store: "delivery" })).toThrow();
  });
});

describe("v3 integration tokens", () => {
  it("are bound to their workspace", () => {
    const ct = encryptIntegrationToken("xoxb-token", KEY, "ws_1");
    expect(decryptIntegrationToken(ct, KEY, "ws_1")).toBe("xoxb-token");
    expect(() => decryptIntegrationToken(ct, KEY, "ws_2")).toThrow();
  });
});

describe("rows written before v3", () => {
  it("v2 vault values still read, ignoring the environment and name they never bound", () => {
    const ct = legacyV2("sk_live_old", "vault", "ws_1");
    expect(secretEnvelopeVersion(ct)).toBe("v2");
    expect(decryptSecret(ct, KEY, prod)).toBe("sk_live_old");
    expect(() => decryptSecret(ct, KEY, { ...prod, workspaceId: "ws_2" })).toThrow();
  });

  it("v2 integration tokens, written with no workspace, still read", () => {
    const ct = legacyV2("xoxb-old", "integration", "");
    expect(decryptIntegrationToken(ct, KEY, "ws_1")).toBe("xoxb-old");
  });

  it("v1 values read by default, so nothing breaks before the backfill", () => {
    const ct = legacyV1("ancient");
    expect(secretEnvelopeVersion(ct)).toBe("v1");
    expect(decryptSecret(ct, KEY, prod)).toBe("ancient");
  });

  it("v1 values are refused once LEGACY_SECRET_ENVELOPE=deny", () => {
    const ct = legacyV1("ancient");
    process.env.LEGACY_SECRET_ENVELOPE = "deny";
    expect(() => decryptSecret(ct, KEY, prod)).toThrow(/Legacy v1 secret envelope refused/);
  });
});

describe("upgradeSecretEnvelope (the backfill's per-row step)", async () => {
  const { upgradeSecretEnvelope } = await import("../../src/utils/crypto.ts");

  it("rewrites v1 and v2 as v3 that reads back in the same row", () => {
    for (const legacy of [legacyV1("old-one"), legacyV2("old-two", "vault", "ws_1")]) {
      const result = upgradeSecretEnvelope(legacy, KEY, prod);
      expect(result.readable).toBe(true);
      expect(result.upgraded && secretEnvelopeVersion(result.upgraded)).toBe("v3");
      expect(decryptSecret(result.upgraded as string, KEY, prod)).toMatch(/^old-/);
    }
  });

  it("upgrades v1 even when v1 reads are denied, and restores the setting", () => {
    process.env.LEGACY_SECRET_ENVELOPE = "deny";
    expect(upgradeSecretEnvelope(legacyV1("old"), KEY, prod).upgraded).not.toBeNull();
    expect(process.env.LEGACY_SECRET_ENVELOPE).toBe("deny");
  });

  it("leaves v3 alone", () => {
    expect(upgradeSecretEnvelope(encryptSecret("x", KEY, prod), KEY, prod)).toEqual({ version: "v3", readable: true, upgraded: null, retiredKey: false });
  });

  it("reports, and never rewrites, a value it cannot read", () => {
    const foreign = encryptSecret("x", "a-different-master-key-of-32-characters!", prod);
    expect(upgradeSecretEnvelope(foreign, KEY, prod)).toEqual({ version: "v3", readable: false, upgraded: null, retiredKey: false });
  });
});
