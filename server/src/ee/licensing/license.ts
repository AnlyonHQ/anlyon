import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { legacyDatetime } from "../../utils/zod-compat.ts";

export const LICENSE_PREFIX = "anlyon_lic_v1";

export const LICENSE_TIERS = ["team", "enterprise"] as const;
export type LicenseTier = (typeof LICENSE_TIERS)[number];
export const GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISSUE_SKEW_MS = DAY_MS;

export interface LicensePublicKey {
  kid: string;
  spki: string;
}

const payloadSchema = z.object({
  v: z.literal(1),
  kid: z.string().min(1),
  id: z.string().min(1),
  org: z.string().min(1),
  tier: z.enum(LICENSE_TIERS),
  seats: z.number().int().positive(),
  features: z.array(z.string().min(1)),
  issuedAt: legacyDatetime({ offset: true }),
  expiresAt: legacyDatetime({ offset: true }),
});

export type LicensePayload = z.infer<typeof payloadSchema>;

export interface License {
  id: string;
  kid: string;
  org: string;
  seats: number;
  tier: LicenseTier;
  features: string[];
  issuedAt: Date;
  expiresAt: Date;
}

export type LicenseFailure =
  | "missing"
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "not_yet_valid"
  | "expired"
  | "no_public_key";

export type LicenseCheck =
  | { ok: true; status: "valid" | "grace"; license: License; graceEndsAt: Date; message: string }
  | { ok: false; reason: LicenseFailure; message: string; license?: License };

export type LicenseRead =
  | { ok: true; license: License }
  | { ok: false; reason: Exclude<LicenseFailure, "not_yet_valid" | "expired">; message: string };

export interface VerifyOptions {
  publicKeys: readonly LicensePublicKey[];
  now?: Date;
}

function decodeBase64Url(part: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return null;
  return Buffer.from(part, "base64url");
}

function publicKeyObject(key: LicensePublicKey): KeyObject | null {
  try {
    const object = createPublicKey({ key: Buffer.from(key.spki, "base64"), format: "der", type: "spki" });
    return object.asymmetricKeyType === "ed25519" ? object : null;
  } catch {
    return null;
  }
}

function toLicense(payload: LicensePayload): License {
  return {
    id: payload.id,
    kid: payload.kid,
    org: payload.org,
    seats: payload.seats,
    tier: payload.tier,
    features: [...new Set(payload.features)],
    issuedAt: new Date(payload.issuedAt),
    expiresAt: new Date(payload.expiresAt),
  };
}

export function verifyLicenseKey(key: string | undefined | null, options: VerifyOptions): LicenseCheck {
  const read = readLicenseKey(key, options.publicKeys);
  if (!read.ok) return read;
  return checkLicenseDates(read.license, options.now ?? new Date());
}

export function readLicenseKey(key: string | undefined | null, publicKeys: readonly LicensePublicKey[]): LicenseRead {
  const trimmed = key?.trim();
  if (!trimmed) {
    return { ok: false, reason: "missing", message: "No licence key is set. Paste the key Anlyon issued you in the console (Settings, Instance), or set ANLYON_LICENSE_KEY." };
  }
  if (publicKeys.length === 0) {
    return {
      ok: false,
      reason: "no_public_key",
      message: "This build carries no licence public key, so no licence can be verified. Use an official Anlyon release image.",
    };
  }

  const parts = trimmed.split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) {
    return { ok: false, reason: "malformed", message: `The licence key is not in the expected format (${LICENSE_PREFIX}.<payload>.<signature>). Copy it again without line breaks.` };
  }
  const [, payloadPart, signaturePart] = parts;
  const payloadBytes = decodeBase64Url(payloadPart);
  const signature = decodeBase64Url(signaturePart);
  if (!payloadBytes || !signature) {
    return { ok: false, reason: "malformed", message: "The licence key contains characters a key never has. Copy it again without line breaks." };
  }

  let payload: LicensePayload;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(payloadBytes.toString("utf8")));
    if (!parsed.success) {
      return { ok: false, reason: "malformed", message: "The licence key's contents are incomplete. Ask Anlyon for a new key." };
    }
    payload = parsed.data;
  } catch {
    return { ok: false, reason: "malformed", message: "The licence key's contents cannot be read. Copy it again without line breaks." };
  }

  const publicKey = publicKeys.find((candidate) => candidate.kid === payload.kid);
  const keyObject = publicKey ? publicKeyObject(publicKey) : null;
  if (!keyObject) {
    return {
      ok: false,
      reason: "unknown_key",
      message: `The licence key was signed with key "${payload.kid}", which this release does not know. Upgrade to a newer release or ask Anlyon for a new key.`,
    };
  }

  const signedText = Buffer.from(`${LICENSE_PREFIX}.${payloadPart}`, "ascii");
  let signatureOk = false;
  try {
    signatureOk = verify(null, signedText, keyObject, signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return { ok: false, reason: "bad_signature", message: "The licence key's signature does not match. The key was altered or was not issued by Anlyon." };
  }

  return { ok: true, license: toLicense(payload) };
}

export function checkLicenseDates(license: License, now: Date): LicenseCheck {
  if (license.issuedAt.getTime() - ISSUE_SKEW_MS > now.getTime()) {
    return {
      ok: false,
      reason: "not_yet_valid",
      license,
      message: `The licence for ${license.org} starts on ${license.issuedAt.toISOString()}. Check this server's clock.`,
    };
  }

  const graceEndsAt = new Date(license.expiresAt.getTime() + GRACE_DAYS * DAY_MS);
  if (now.getTime() < license.expiresAt.getTime()) {
    return {
      ok: true,
      status: "valid",
      license,
      graceEndsAt,
      message: `Licensed to ${license.org} for ${license.seats} seats until ${license.expiresAt.toISOString()}.`,
    };
  }
  if (now.getTime() < graceEndsAt.getTime()) {
    return {
      ok: true,
      status: "grace",
      license,
      graceEndsAt,
      message: `The licence for ${license.org} expired on ${license.expiresAt.toISOString()}. Enterprise features stay on until ${graceEndsAt.toISOString()}; renew before then.`,
    };
  }
  return {
    ok: false,
    reason: "expired",
    license,
    message: `The licence for ${license.org} expired on ${license.expiresAt.toISOString()} and its ${GRACE_DAYS}-day grace period has ended. Enterprise features are off until a renewed key is set.`,
  };
}
