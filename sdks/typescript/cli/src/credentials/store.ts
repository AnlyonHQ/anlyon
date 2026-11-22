import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import type { Env } from '../config';
import { FileStore } from './file';
import { MacKeychainStore } from './macos';
import { SecretServiceStore } from './secret-service';
import { WindowsCredentialStore } from './windows';

/** The service name every backend files entries under. */
export const SERVICE = 'anlyon-cli';

export interface CredentialStore {
  /** Stable backend id, shown by `auth status` and `doctor`. */
  readonly name: string;
  /** Whether secrets are protected by the OS (false only for the opt-in file store). */
  readonly secure: boolean;
  /** Largest secret the backend accepts, in UTF-8 bytes. */
  readonly maxSecretBytes: number;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

export function storeUnavailable(backend: string, detail: string): CliError {
  return new CliError('CREDENTIAL_STORE_UNAVAILABLE', `The OS credential store (${backend}) is not available: ${detail}`, EXIT.ERROR, {
    hint:
      'Unlock or install the credential store (Linux: a Secret Service such as gnome-keyring, and `secret-tool`). ' +
      'For automation use ANLYON_API_KEY instead. ANLYON_CREDENTIAL_STORE=file stores credentials in a 0600 file ' +
      'under the config directory. That is an explicit opt-in because the file is not encrypted.',
  });
}

/**
 * Pick the backend. `auto`/`keychain` means the platform store; `file` must be
 * asked for by name. There is no silent fallback to plaintext.
 */
export function selectCredentialStore(env: Env, configDir: string, platform: NodeJS.Platform = process.platform): CredentialStore {
  const choice = (env.ANLYON_CREDENTIAL_STORE ?? 'auto').toLowerCase();
  if (choice === 'file') return new FileStore(configDir);
  if (choice !== 'auto' && choice !== 'keychain') {
    throw new CliError('USAGE', `ANLYON_CREDENTIAL_STORE must be auto, keychain or file (got "${choice}").`, EXIT.USAGE);
  }
  if (platform === 'darwin') return new MacKeychainStore();
  if (platform === 'win32') return new WindowsCredentialStore();
  return new SecretServiceStore();
}

/** Write, read back and delete a throwaway entry. Used by `doctor`. */
export async function probeStore(store: CredentialStore): Promise<{ ok: boolean; detail: string }> {
  const account = `probe-${process.pid}-${Date.now()}`;
  const value = `probe-${Math.random().toString(36).slice(2)}`;
  try {
    await store.set(account, value);
    const read = await store.get(account);
    await store.delete(account);
    return read === value ? { ok: true, detail: store.name } : { ok: false, detail: `${store.name}: read back a different value` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
