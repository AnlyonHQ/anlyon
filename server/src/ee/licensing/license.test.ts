import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GRACE_DAYS, LICENSE_PREFIX, verifyLicenseKey, type LicensePayload, type LicensePublicKey } from "./license.ts";

const testKeys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");

function spkiOf(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

const publicKeys: LicensePublicKey[] = [{ kid: "test-1", spki: spkiOf(testKeys.publicKey) }];

const DAY = 24 * 60 * 60 * 1000;
const issuedAt = new Date("2026-10-01T00:00:00Z");
const expiresAt = new Date("2027-10-01T00:00:00Z");

function payload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    v: 1,
    kid: "test-1",
    tier: "team",
    id: "lic_test",
    org: "Example Corp",
    seats: 25,
    features: ["sso", "scim", "audit_streaming"],
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ...overrides,
  };
}

function makeKey(body: unknown, privateKey: KeyObject = testKeys.privateKey): string {
  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  const signature = sign(null, Buffer.from(`${LICENSE_PREFIX}.${encoded}`, "ascii"), privateKey).toString("base64url");
  return `${LICENSE_PREFIX}.${encoded}.${signature}`;
}

const during = new Date("2027-01-01T00:00:00Z");

describe("verifyLicenseKey", () => {
  it("accepts a key signed by a known key and returns its terms", () => {
    const result = verifyLicenseKey(makeKey(payload()), { publicKeys, now: during });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("valid");
    expect(result.license).toMatchObject({ org: "Example Corp", seats: 25, kid: "test-1", id: "lic_test", tier: "team" });
    expect(result.license.features).toEqual(["sso", "scim", "audit_streaming"]);
    expect(result.license.expiresAt.toISOString()).toBe(expiresAt.toISOString());
  });

  it("tolerates surrounding whitespace from a pasted key", () => {
    expect(verifyLicenseKey(`  ${makeKey(payload())}\n`, { publicKeys, now: during }).ok).toBe(true);
  });

  it("refuses a missing key", () => {
    const result = verifyLicenseKey(undefined, { publicKeys, now: during });
    expect(result).toMatchObject({ ok: false, reason: "missing" });
    if (!result.ok) expect(result.message).toContain("ANLYON_LICENSE_KEY");
  });

  it("refuses everything when the build carries no public key", () => {
    expect(verifyLicenseKey(makeKey(payload()), { publicKeys: [], now: during })).toMatchObject({ ok: false, reason: "no_public_key" });
  });

  it("refuses a key in the wrong format", () => {
    for (const key of ["nonsense", "anlyon_lic_v2.a.b", `${LICENSE_PREFIX}.only-two`, `${LICENSE_PREFIX}.a+b.c`]) {
      expect(verifyLicenseKey(key, { publicKeys, now: during })).toMatchObject({ ok: false, reason: "malformed" });
    }
  });

  it("refuses a payload missing a term", () => {
    const { seats: _seats, ...withoutSeats } = payload();
    expect(verifyLicenseKey(makeKey(withoutSeats), { publicKeys, now: during })).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("refuses a payload with an unknown tier", () => {
    const bad = { ...payload(), tier: "platinum" };
    expect(verifyLicenseKey(makeKey(bad), { publicKeys, now: during })).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("refuses a key signed by a key this build does not know", () => {
    const result = verifyLicenseKey(makeKey(payload({ kid: "test-9" })), { publicKeys, now: during });
    expect(result).toMatchObject({ ok: false, reason: "unknown_key" });
  });

  it("refuses a key signed by someone else under a known key id", () => {
    const forged = makeKey(payload(), otherKeys.privateKey);
    expect(verifyLicenseKey(forged, { publicKeys, now: during })).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("refuses a key whose terms were edited after signing", () => {
    const [prefix, , signature] = makeKey(payload()).split(".");
    const raised = Buffer.from(JSON.stringify(payload({ seats: 10_000 }))).toString("base64url");
    expect(verifyLicenseKey(`${prefix}.${raised}.${signature}`, { publicKeys, now: during })).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a key that only starts in the future, beyond a day of clock skew", () => {
    const key = makeKey(payload());
    expect(verifyLicenseKey(key, { publicKeys, now: new Date(issuedAt.getTime() - 2 * DAY) })).toMatchObject({
      ok: false,
      reason: "not_yet_valid",
    });
    expect(verifyLicenseKey(key, { publicKeys, now: new Date(issuedAt.getTime() - DAY / 2) }).ok).toBe(true);
  });

  it("keeps an expired licence working through the grace period, then turns it off", () => {
    const key = makeKey(payload());
    const inGrace = verifyLicenseKey(key, { publicKeys, now: new Date(expiresAt.getTime() + DAY) });
    expect(inGrace).toMatchObject({ ok: true, status: "grace" });
    if (inGrace.ok) expect(inGrace.message).toContain("renew");

    const after = verifyLicenseKey(key, { publicKeys, now: new Date(expiresAt.getTime() + (GRACE_DAYS + 1) * DAY) });
    expect(after).toMatchObject({ ok: false, reason: "expired" });
    if (!after.ok) expect(after.message).toContain("Enterprise features are off");
  });

  it("verifies against the right key when several are built in", () => {
    const rotated: LicensePublicKey[] = [{ kid: "old", spki: spkiOf(otherKeys.publicKey) }, ...publicKeys];
    expect(verifyLicenseKey(makeKey(payload()), { publicKeys: rotated, now: during }).ok).toBe(true);
  });

  it("refuses a public key that is not Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const wrong: LicensePublicKey[] = [{ kid: "test-1", spki: spkiOf(rsa.publicKey) }];
    expect(verifyLicenseKey(makeKey(payload()), { publicKeys: wrong, now: during })).toMatchObject({ ok: false, reason: "unknown_key" });
  });
});
