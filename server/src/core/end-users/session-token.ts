import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.ts";
import { isEndUserId } from "./identity.ts";

export const SESSION_TOKEN_PREFIX = "eus_";
const PREFIX = "eus_v1";
const MAX_TOKEN_LENGTH = 2048;
const B64URL = /^[A-Za-z0-9_-]+$/;

export const DEFAULT_SESSION_SECONDS = 15 * 60;
export const MIN_SESSION_SECONDS = 60;
export const MAX_SESSION_SECONDS = 60 * 60;

export type SessionCapability = "connections" | "approvals";
export const SESSION_CAPABILITIES: readonly SessionCapability[] = ["connections", "approvals"];

export interface SessionClaims {
  v: 1;
  ws: string;
  env: string;
  eu: string;
  kid: string;
  cap: SessionCapability[];
  iat: number;
  exp: number;
  jti: string;
}

function signingKey(): Buffer {
  return createHmac("sha256", env.API_KEY_SECRET).update("anlyon/end-user-session/v1").digest();
}

function mac(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function sessionLifetimeSeconds(requested: number | undefined, keyExpiresAt: Date | null, now = Date.now()): number {
  let seconds = Math.min(Math.max(Math.floor(requested ?? DEFAULT_SESSION_SECONDS), MIN_SESSION_SECONDS), MAX_SESSION_SECONDS);
  if (keyExpiresAt) seconds = Math.min(seconds, Math.floor((keyExpiresAt.getTime() - now) / 1000));
  return seconds;
}

export function mintSessionToken(
  input: { workspaceId: string; environmentId: string; endUserId: string; keyId: string; capabilities: SessionCapability[] },
  lifetimeSeconds: number,
  now = Date.now(),
): { token: string; expiresAt: Date; claims: SessionClaims } {
  const iat = Math.floor(now / 1000);
  const claims: SessionClaims = {
    v: 1,
    ws: input.workspaceId,
    env: input.environmentId,
    eu: input.endUserId,
    kid: input.keyId,
    cap: [...input.capabilities],
    iat,
    exp: iat + lifetimeSeconds,
    jti: randomBytes(12).toString("base64url"),
  };
  const payload = `${PREFIX}.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}`;
  return { token: `${payload}.${mac(payload)}`, expiresAt: new Date(claims.exp * 1000), claims };
}

export type SessionTokenCheck =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: "malformed" | "signature" | "expired"; claims?: SessionClaims };

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;

export function verifySessionToken(token: string | undefined | null, now = Date.now()): SessionTokenCheck {
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || !B64URL.test(parts[1]!) || !B64URL.test(parts[2]!)) {
    return { ok: false, reason: "malformed" };
  }
  const expected = Buffer.from(mac(`${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2]!);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "signature" };

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as SessionClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    claims?.v !== 1 || !isString(claims.ws) || !isString(claims.env) || !isEndUserId(claims.eu) || !isString(claims.kid) ||
    !Array.isArray(claims.cap) || !claims.cap.every((c) => SESSION_CAPABILITIES.includes(c)) ||
    typeof claims.iat !== "number" || typeof claims.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp * 1000 <= now) return { ok: false, reason: "expired", claims };
  return { ok: true, claims };
}
