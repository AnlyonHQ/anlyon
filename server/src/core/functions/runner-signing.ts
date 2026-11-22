import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const RUNNER_SIGNATURE_HEADER = "Anlyon-Runner-Signature";
export const RUNNER_SIGNATURE_WINDOW_SECONDS = 60;
const LABEL = "anlyon-runner/v1";

function signedText(timestamp: number, method: string, path: string, body: string): string {
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  return `${LABEL}\n${timestamp}\n${method.toUpperCase()}\n${path}\n${bodyDigest}`;
}

export function signRunnerRequest(secret: string, method: string, path: string, body: string, now: number = Date.now()): string {
  const timestamp = Math.floor(now / 1000);
  const mac = createHmac("sha256", secret).update(signedText(timestamp, method, path, body)).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function verifyRunnerRequestWithAny(
  secrets: ReadonlyArray<string | undefined>,
  header: string | undefined | null,
  method: string,
  path: string,
  body: string,
  now: number = Date.now(),
): boolean {
  return secrets.some((secret) => verifyRunnerRequest(secret, header, method, path, body, now));
}

export function verifyRunnerRequest(
  secret: string | undefined,
  header: string | undefined | null,
  method: string,
  path: string,
  body: string,
  now: number = Date.now(),
): boolean {
  if (!secret || !header || header.length > 200) return false;
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (Math.abs(Math.floor(now / 1000) - timestamp) > RUNNER_SIGNATURE_WINDOW_SECONDS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(signedText(timestamp, method, path, body)).digest("hex"));
  const given = Buffer.from(match[2]!);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
