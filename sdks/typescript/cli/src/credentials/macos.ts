import { runProcess } from './process';
import { SERVICE, storeUnavailable, type CredentialStore } from './store';

const SECURITY = '/usr/bin/security';
const NOT_FOUND = 44;

/**
 * macOS login keychain via /usr/bin/security.
 *
 * Writes go through `security -i`, which reads its command from stdin, so the
 * secret never appears in argv. The secret is base64-encoded first so it cannot
 * collide with that command language's quoting.
 */
export class MacKeychainStore implements CredentialStore {
  readonly name = 'macos-keychain';
  readonly secure = true;
  readonly maxSecretBytes = 16_384;

  async get(account: string): Promise<string | null> {
    const result = await runProcess(SECURITY, ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
    if (result.spawnError) throw storeUnavailable(this.name, result.spawnError.message);
    if (result.code === NOT_FOUND) return null;
    if (result.code !== 0) throw storeUnavailable(this.name, result.stderr.trim() || `security exited ${result.code}`);
    return Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
  }

  async set(account: string, secret: string): Promise<void> {
    const encoded = Buffer.from(secret, 'utf8').toString('base64');
    const command = `add-generic-password -U -s ${SERVICE} -a ${account} -w ${encoded}\n`;
    const result = await runProcess(SECURITY, ['-i'], { input: command });
    if (result.spawnError) throw storeUnavailable(this.name, result.spawnError.message);
    if ((await this.get(account)) !== secret) {
      throw storeUnavailable(this.name, result.stderr.trim() || 'the keychain did not accept the entry');
    }
  }

  async delete(account: string): Promise<boolean> {
    const result = await runProcess(SECURITY, ['delete-generic-password', '-s', SERVICE, '-a', account]);
    if (result.spawnError) throw storeUnavailable(this.name, result.spawnError.message);
    if (result.code === NOT_FOUND) return false;
    if (result.code !== 0) throw storeUnavailable(this.name, result.stderr.trim() || `security exited ${result.code}`);
    return true;
  }
}
