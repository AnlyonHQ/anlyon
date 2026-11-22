import type { Context } from "hono";

const CREDENTIAL_REJECTED = "credentialRejected";

export function markCredentialRejected(c: Context): void {
  c.set(CREDENTIAL_REJECTED, true);
}

export function credentialWasRejected(c: Context): boolean {
  return c.get(CREDENTIAL_REJECTED) === true;
}
