import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const VERSION = "v1";

export interface SignOffLinkClaims {
  signOffId: string;
  userId: string;
  expiresAt: number;
}

function linkKey(masterKey: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(masterKey, "utf8"), Buffer.from("anlyon-sign-off-link"), Buffer.from("sign-off-link:v1"), 32));
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

export function signSignOffLink(claims: SignOffLinkClaims, masterKey: string): string {
  const body = b64(JSON.stringify({ s: claims.signOffId, u: claims.userId, e: claims.expiresAt }));
  const mac = createHmac("sha256", linkKey(masterKey)).update(`${VERSION}.${body}`).digest("base64url");
  return `${VERSION}.${body}.${mac}`;
}

export function verifySignOffLink(token: string, masterKey: string, nowSeconds = Math.floor(Date.now() / 1000)): SignOffLinkClaims | null {
  if (typeof token !== "string" || token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const expected = createHmac("sha256", linkKey(masterKey)).update(`${VERSION}.${parts[1]}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { s?: unknown; u?: unknown; e?: unknown };
    if (typeof parsed.s !== "string" || typeof parsed.u !== "string" || typeof parsed.e !== "number") return null;
    if (parsed.e <= nowSeconds) return null;
    return { signOffId: parsed.s, userId: parsed.u, expiresAt: parsed.e };
  } catch {
    return null;
  }
}
