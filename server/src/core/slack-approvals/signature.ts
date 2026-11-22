import { createHmac, timingSafeEqual } from "node:crypto";

export const SLACK_SIGNATURE_WINDOW_SECONDS = 5 * 60;

export type SlackSignatureResult =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" };

export function signSlackRequest(signingSecret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowSeconds?: number;
}): SlackSignatureResult {
  const { signingSecret, timestamp, signature, rawBody } = input;
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "stale_timestamp" };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > SLACK_SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const expected = Buffer.from(signSlackRequest(signingSecret, timestamp, rawBody), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}
