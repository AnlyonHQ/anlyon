import { registerSecret } from '../redact';
import type { CredentialStore } from './store';

/**
 * What the credential store holds for a profile: one JSON document per profile.
 * `origin` is checked on every read, so a profile recreated against another API
 * can never pick up (and send) a credential issued by the old one.
 */
export interface StoredCredential {
  v: 1;
  kind: 'oauth' | 'api_key';
  origin: string;
  apiKey?: string;
  clientId?: string;
  refreshToken?: string;
  accessToken?: string;
  /** Epoch milliseconds. */
  accessTokenExpiresAt?: number;
}

export const accountFor = (profile: string) => `profile.${profile}`;

export async function readCredential(store: CredentialStore, profile: string, origin: string): Promise<StoredCredential | null> {
  const raw = await store.get(accountFor(profile));
  if (!raw) return null;
  let parsed: StoredCredential;
  try {
    parsed = JSON.parse(raw) as StoredCredential;
  } catch {
    return null;
  }
  registerSecret(parsed.apiKey);
  registerSecret(parsed.refreshToken);
  registerSecret(parsed.accessToken);
  if (parsed.v !== 1 || parsed.origin !== origin) return null;
  return parsed;
}

export async function writeCredential(store: CredentialStore, profile: string, credential: StoredCredential): Promise<void> {
  registerSecret(credential.apiKey);
  registerSecret(credential.refreshToken);
  registerSecret(credential.accessToken);
  let text = JSON.stringify(credential);
  if (Buffer.byteLength(text, 'utf8') > store.maxSecretBytes && credential.accessToken) {
    const { accessToken: _a, accessTokenExpiresAt: _e, ...rest } = credential;
    text = JSON.stringify(rest);
  }
  await store.set(accountFor(profile), text);
}

export async function deleteCredential(store: CredentialStore, profile: string): Promise<boolean> {
  return store.delete(accountFor(profile));
}
