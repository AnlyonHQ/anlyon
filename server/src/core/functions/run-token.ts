import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.ts";
import type { FunctionRunMode } from "../../db/schema/functions.ts";

const PREFIX = "frt_v1";
const MAX_TOKEN_LENGTH = 2048;
const B64URL = /^[A-Za-z0-9_-]+$/;
export const MAX_RUN_TOKEN_SECONDS = 10 * 60;
const MARGIN_SECONDS = 60;

export interface RunTokenClaims {
  run: string;
  version: string;
  workspace: string;
  environment: string;
  endUser: string | null;
  endUserRequired: boolean;
  mode: FunctionRunMode;
  planDigest: string | null;
  exp: number;
}

function signingKey(): Buffer {
  return createHmac("sha256", env.API_KEY_SECRET).update("anlyon/function-run-token/v1").digest();
}

function mac(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function runTokenLifetimeSeconds(timeoutMs: number): number {
  return Math.min(MAX_RUN_TOKEN_SECONDS, Math.ceil(timeoutMs / 1000) + MARGIN_SECONDS);
}

export function mintRunToken(claims: Omit<RunTokenClaims, "exp">, lifetimeSeconds: number, now: number = Date.now()): string {
  const full: RunTokenClaims = { ...claims, exp: Math.floor(now / 1000) + Math.min(lifetimeSeconds, MAX_RUN_TOKEN_SECONDS) };
  const payload = `${PREFIX}.${Buffer.from(JSON.stringify(full), "utf8").toString("base64url")}`;
  return `${payload}.${mac(payload)}`;
}

export type RunTokenCheck = { ok: true; claims: RunTokenClaims } | { ok: false; reason: "malformed" | "signature" | "expired" };

export function verifyRunToken(token: string | undefined | null, now: number = Date.now()): RunTokenCheck {
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || !B64URL.test(parts[1]!) || !B64URL.test(parts[2]!)) {
    return { ok: false, reason: "malformed" };
  }
  const expected = Buffer.from(mac(`${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2]!);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "signature" };

  let claims: RunTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as RunTokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.run !== "string" || typeof claims.version !== "string" || typeof claims.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (Math.floor(now / 1000) >= claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.slice(0, MAX_TOKEN_LENGTH + 16));
  return match?.[1] ?? null;
}
