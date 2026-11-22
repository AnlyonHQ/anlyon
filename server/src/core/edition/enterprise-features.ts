import type { LicenseTier } from "../../ee/licensing/license.ts";

export const ENTERPRISE_FEATURES = [
  "sso",
  "scim",
  "byo_vault",
  "kms",
  "audit_streaming",
  "env_permissions",
  "evidence_export",
] as const;

export type EnterpriseFeature = (typeof ENTERPRISE_FEATURES)[number];

export function isEnterpriseFeature(value: string): value is EnterpriseFeature {
  return (ENTERPRISE_FEATURES as readonly string[]).includes(value);
}

export const TIER_FEATURES: Record<LicenseTier, readonly EnterpriseFeature[]> = {
  team: ["sso", "audit_streaming", "env_permissions", "evidence_export"],
  enterprise: ENTERPRISE_FEATURES,
};

export function featuresForTier(tier: LicenseTier): EnterpriseFeature[] {
  return [...TIER_FEATURES[tier]];
}

export function featuresBeyondTier(tier: LicenseTier, features: readonly string[]): string[] {
  const sold = new Set<string>(TIER_FEATURES[tier]);
  return features.filter((feature) => !sold.has(feature));
}
