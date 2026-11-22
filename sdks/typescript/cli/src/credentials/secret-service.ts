import { runProcess } from './process';
import { SERVICE, storeUnavailable, type CredentialStore } from './store';

/**
 * Linux (and other freedesktop systems): the Secret Service API (gnome-keyring,
 * KWallet) through libsecret's `secret-tool`. `store` reads the secret from stdin.
 */
export class SecretServiceStore implements CredentialStore {
  readonly name = 'secret-service';
  readonly secure = true;
  readonly maxSecretBytes = 16_384;

  private attrs(account: string): string[] {
    return ['service', SERVICE, 'account', account];
  }

  async get(account: string): Promise<string | null> {
    const result = await runProcess('secret-tool', ['lookup', ...this.attrs(account)]);
    if (result.spawnError) throw storeUnavailable(this.name, `secret-tool not found (${result.spawnError.code ?? 'spawn failed'})`);
    if (result.code !== 0) {
      if (!result.stderr.trim()) return null;
      throw storeUnavailable(this.name, result.stderr.trim());
    }
    return result.stdout.replace(/\n$/, '');
  }

  async set(account: string, secret: string): Promise<void> {
    const result = await runProcess('secret-tool', ['store', `--label=Anlyon CLI (${account})`, ...this.attrs(account)], {
      input: secret,
    });
    if (result.spawnError) throw storeUnavailable(this.name, `secret-tool not found (${result.spawnError.code ?? 'spawn failed'})`);
    if (result.code !== 0) throw storeUnavailable(this.name, result.stderr.trim() || `secret-tool exited ${result.code}`);
  }

  async delete(account: string): Promise<boolean> {
    const existed = (await this.get(account)) !== null;
    const result = await runProcess('secret-tool', ['clear', ...this.attrs(account)]);
    if (result.spawnError) throw storeUnavailable(this.name, `secret-tool not found (${result.spawnError.code ?? 'spawn failed'})`);
    if (result.code !== 0 && result.stderr.trim()) throw storeUnavailable(this.name, result.stderr.trim());
    return existed;
  }
}
