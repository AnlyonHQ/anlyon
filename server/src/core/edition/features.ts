import { createLogger } from "../../lib/logger.ts";
import { env } from "../../config/env.ts";
import { countDistinct } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaceMembers } from "../../db/schema/workspaces.ts";
import {
  checkLicenseDates,
  readLicenseKey,
  type License,
  type LicenseCheck,
  type LicenseFailure,
  type LicenseRead,
  type LicenseTier,
} from "../../ee/licensing/license.ts";
import { LICENSE_PUBLIC_KEYS } from "../../ee/licensing/public-key.ts";
import { currentEdition, isLicensedEdition, type Edition } from "./edition.ts";
import { instanceSetting } from "../instance/settings.ts";
import { featuresBeyondTier, isEnterpriseFeature, type EnterpriseFeature } from "./enterprise-features.ts";

const logger = createLogger({ module: "edition" });

export {
  ENTERPRISE_FEATURES,
  featuresForTier,
  isEnterpriseFeature,
  TIER_FEATURES,
  type EnterpriseFeature,
} from "./enterprise-features.ts";

let read: { key: string | undefined; result: LicenseRead } | null = null;

export function enterpriseLicenseCheck(now: Date = new Date()): LicenseCheck {
  const key = isLicensedEdition() ? instanceSetting("license.key") : env.ANLYON_LICENSE_KEY;
  const current = read && read.key === key ? read : { key, result: readLicenseKey(key, LICENSE_PUBLIC_KEYS) };
  read = current;
  const { result } = current;
  return result.ok ? checkLicenseDates(result.license, now) : result;
}

export function resetEnterpriseLicenseCheck(): void {
  read = null;
}

export function isFeatureEnabled(
  feature: EnterpriseFeature,
  edition: Edition = currentEdition(),
  now: Date = new Date(),
): boolean {
  switch (edition) {
    case "cloud":
      return true;
    case "community":
      return false;
    case "team":
    case "enterprise": {
      const result = enterpriseLicenseCheck(now);
      return result.ok && result.license.features.includes(feature);
    }
  }
}

export function logEnterpriseLicenseStatus(edition: Edition = currentEdition()): void {
  if (edition === "cloud") return;
  if (edition === "community") {
    logger.info("Community edition: licensed features (SSO, SCIM, vaults, audit streaming, ...) are not included");
    return;
  }
  const result = enterpriseLicenseCheck();
  if (!result.ok) {
    logger.error({ reason: result.reason }, `Licence not valid: ${result.message} Licensed features are off; the core keeps running.`);
    return;
  }
  const { license } = result;
  const unknown = license.features.filter((feature) => !isEnterpriseFeature(feature));
  const beyondTier = featuresBeyondTier(license.tier, license.features).filter(isEnterpriseFeature);
  const fields = {
    licenseId: license.id,
    tier: license.tier,
    org: license.org,
    seats: license.seats,
    expiresAt: license.expiresAt.toISOString(),
    features: license.features.filter(isEnterpriseFeature),
    ...(beyondTier.length > 0 ? { beyondTier } : {}),
    ...(unknown.length > 0 ? { unknownFeatures: unknown } : {}),
  };
  if (result.status === "grace") logger.warn(fields, result.message);
  else logger.info(fields, result.message);
  if (license.tier !== edition) {
    logger.warn(
      { edition, tier: license.tier },
      `EDITION is ${edition} but the licence is for the ${license.tier} tier. The licence's features apply; set EDITION=${license.tier} to match.`,
    );
  }
}

export async function countSeatsInUse(): Promise<number> {
  const [row] = await db.select({ seats: countDistinct(workspaceMembers.userId) }).from(workspaceMembers);
  return Number(row?.seats ?? 0);
}

export interface LicenseSummary {
  state: "valid" | "grace" | "invalid";
  reason?: LicenseFailure;
  message: string;
  tier: LicenseTier | null;
  org: string | null;
  seats: number | null;
  seatsUsed: number;
  overSeats: boolean;
  features: EnterpriseFeature[];
  expiresAt: string | null;
  graceEndsAt: string | null;
}

export async function licenseSummary(
  edition: Edition = currentEdition(),
  seatsInUse: () => Promise<number> = countSeatsInUse,
  now: Date = new Date(),
): Promise<LicenseSummary | null> {
  if (!isLicensedEdition(edition)) return null;
  const result = enterpriseLicenseCheck(now);
  const license: License | undefined = result.license;
  const seatsUsed = await seatsInUse();
  return {
    state: result.ok ? result.status : "invalid",
    ...(result.ok ? {} : { reason: result.reason }),
    message: result.message,
    tier: license?.tier ?? null,
    org: license?.org ?? null,
    seats: license?.seats ?? null,
    seatsUsed,
    overSeats: license !== undefined && seatsUsed > license.seats,
    features: result.ok ? result.license.features.filter(isEnterpriseFeature) : [],
    expiresAt: license?.expiresAt.toISOString() ?? null,
    graceEndsAt: result.ok ? result.graceEndsAt.toISOString() : null,
  };
}

export async function logLicenseSeats(edition: Edition = currentEdition()): Promise<void> {
  const summary = await licenseSummary(edition);
  if (!summary?.overSeats) return;
  logger.warn(
    { seats: summary.seats, seatsUsed: summary.seatsUsed, org: summary.org },
    `This install has ${summary.seatsUsed} people in its workspaces and the licence covers ${summary.seats}. Nothing is blocked; renew the licence for more seats.`,
  );
}
