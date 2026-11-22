import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.ts";

const PREFIX = "demo_sk_v1";
const MAX_TOKEN_LENGTH = 256;
const MAX_WORKSPACE_ID_LENGTH = 128;
const B64URL = /^[A-Za-z0-9_-]+$/;

function signingKey(): Buffer {
  return createHmac("sha256", env.API_KEY_SECRET).update("anlyon/sandbox-token/v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function mintSandboxToken(workspaceId: string): string {
  const workspace = Buffer.from(workspaceId, "utf8").toString("base64url");
  const nonce = randomBytes(12).toString("base64url");
  const payload = `${PREFIX}.${workspace}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySandboxToken(token: string): string | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [prefix, workspace, nonce, signature] = parts as [string, string, string, string];
  if (prefix !== PREFIX) return null;
  if (![workspace, nonce, signature].every((p) => B64URL.test(p))) return null;

  const expected = Buffer.from(sign(`${prefix}.${workspace}.${nonce}`), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const workspaceId = Buffer.from(workspace, "base64url").toString("utf8");
  if (!workspaceId || workspaceId.length > MAX_WORKSPACE_ID_LENGTH) return null;
  return workspaceId;
}

export function sandboxWorkspaceFromAuthorization(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.slice(0, MAX_TOKEN_LENGTH + 16));
  return match?.[1] ? verifySandboxToken(match[1]) : null;
}
