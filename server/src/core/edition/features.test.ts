import { sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const keys = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey,
    spki: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
});

vi.mock("../../ee/licensing/public-key.ts", () => ({
  LICENSE_PUBLIC_KEYS: [{ kid: "test-1", spki: keys.spki }],
}));

import { env } from "../../config/env.ts";
import {
  ENTERPRISE_FEATURES,
  featuresForTier,
  isFeatureEnabled,
  licenseSummary,
  resetEnterpriseLicenseCheck,
  TIER_FEATURES,
} from "./features.ts";
import { featuresBeyondTier } from "./enterprise-features.ts";

interface KeyTerms {
  tier?: "team" | "enterprise";
  features?: string[];
  seats?: number;
  expiresAt?: string;
}

function licenseKey({ tier = "enterprise", features, seats = 10, expiresAt = "2099-01-01T00:00:00Z" }: KeyTerms = {}): string {
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      kid: "test-1",
      tier,
      id: "lic_test",
      org: "Example Corp",
      seats,
      features: features ?? featuresForTier(tier),
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt,
    }),
  ).toString("base64url");
  const signature = sign(null, Buffer.from(`anlyon_lic_v1.${body}`, "ascii"), keys.privateKey).toString("base64url");
  return `anlyon_lic_v1.${body}.${signature}`;
}

function useKey(key: string | undefined) {
  env.ANLYON_LICENSE_KEY = key;
  resetEnterpriseLicenseCheck();
}

afterEach(() => useKey(undefined));

describe("tiers", () => {
  it("sells sso, audit streaming, environment permissions and evidence export on Team", () => {
    expect([...TIER_FEATURES.team].sort()).toEqual(["audit_streaming", "env_permissions", "evidence_export", "sso"]);
  });

  it("sells every licensed feature on Enterprise, including scim, vaults and keys", () => {
    expect([...TIER_FEATURES.enterprise].sort()).toEqual([...ENTERPRISE_FEATURES].sort());
    for (const feature of ["scim", "byo_vault", "kms"]) {
      expect(TIER_FEATURES.team).not.toContain(feature);
    }
  });

  it("names the features a licence carries beyond its tier", () => {
    expect(featuresBeyondTier("team", ["sso", "kms"])).toEqual(["kms"]);
    expect(featuresBeyondTier("enterprise", [...ENTERPRISE_FEATURES])).toEqual([]);
  });
});

describe("isFeatureEnabled", () => {
  it("offers every licensed feature on cloud, licence or not", () => {
    for (const feature of ENTERPRISE_FEATURES) expect(isFeatureEnabled(feature, "cloud")).toBe(true);
  });

  it("offers none in the community edition, even with a valid key", () => {
    useKey(licenseKey());
    for (const feature of ENTERPRISE_FEATURES) expect(isFeatureEnabled(feature, "community")).toBe(false);
  });

  it("offers nothing in a licensed edition without a key", () => {
    for (const edition of ["team", "enterprise"] as const) {
      for (const feature of ENTERPRISE_FEATURES) expect(isFeatureEnabled(feature, edition)).toBe(false);
    }
  });

  it("offers a Team licence's features and nothing it does not name", () => {
    useKey(licenseKey({ tier: "team" }));
    for (const feature of TIER_FEATURES.team) expect(isFeatureEnabled(feature, "team")).toBe(true);
    for (const feature of ["scim", "byo_vault", "kms"] as const) expect(isFeatureEnabled(feature, "team")).toBe(false);
  });

  it("obeys the licence's feature list over its tier", () => {
    useKey(licenseKey({ tier: "team", features: ["sso", "kms"] }));
    expect(isFeatureEnabled("kms", "team")).toBe(true);
    expect(isFeatureEnabled("audit_streaming", "team")).toBe(false);
  });

  it("offers an Enterprise licence's features", () => {
    useKey(licenseKey({ tier: "enterprise" }));
    for (const feature of ENTERPRISE_FEATURES) expect(isFeatureEnabled(feature, "enterprise")).toBe(true);
  });

  it("turns features off once the licence is past its grace period, without a restart", () => {
    useKey(licenseKey({ features: ["sso"], expiresAt: "2027-01-01T00:00:00Z" }));
    expect(isFeatureEnabled("sso", "enterprise", new Date("2026-12-31T00:00:00Z"))).toBe(true);
    expect(isFeatureEnabled("sso", "enterprise", new Date("2027-01-05T00:00:00Z"))).toBe(true);
    expect(isFeatureEnabled("sso", "enterprise", new Date("2027-02-01T00:00:00Z"))).toBe(false);
  });

  it("offers nothing for a key that was tampered with", () => {
    const [prefix, , signature] = licenseKey({ tier: "team" }).split(".");
    const widened = Buffer.from(JSON.stringify({ v: 1, kid: "test-1", tier: "enterprise", id: "x", org: "x", seats: 1, features: [...ENTERPRISE_FEATURES], issuedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" })).toString("base64url");
    useKey(`${prefix}.${widened}.${signature}`);
    expect(isFeatureEnabled("sso", "enterprise")).toBe(false);
  });
});

describe("licenseSummary", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("is absent on cloud and community", async () => {
    expect(await licenseSummary("cloud", async () => 3, now)).toBeNull();
    expect(await licenseSummary("community", async () => 3, now)).toBeNull();
  });

  it("reports seats in use against seats licensed, and is over only past the count", async () => {
    useKey(licenseKey({ tier: "team", seats: 5 }));
    const at = await licenseSummary("team", async () => 5, now);
    expect(at).toMatchObject({ state: "valid", tier: "team", seats: 5, seatsUsed: 5, overSeats: false, org: "Example Corp" });
    const over = await licenseSummary("team", async () => 6, now);
    expect(over).toMatchObject({ seatsUsed: 6, overSeats: true });
    expect(isFeatureEnabled("sso", "team", now)).toBe(true);
  });

  it("says why a licence is not valid", async () => {
    const summary = await licenseSummary("enterprise", async () => 1, now);
    expect(summary).toMatchObject({ state: "invalid", reason: "missing", tier: null, seats: null, overSeats: false, features: [] });
  });
});
