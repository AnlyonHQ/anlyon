import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CredentialStore } from './store';

/**
 * Opt-in only (ANLYON_CREDENTIAL_STORE=file): one 0600 file per account in a
 * 0700 directory. Not encrypted; `auth status` and `doctor` say so. On Windows
 * the mode bits are ignored and the file inherits the profile directory's ACL.
 */
export class FileStore implements CredentialStore {
  readonly name = 'file';
  readonly secure = false;
  readonly maxSecretBytes = 1_000_000;
  private readonly dir: string;

  constructor(configDir: string) {
    this.dir = join(configDir, 'credentials');
  }

  private path(account: string): string {
    return join(this.dir, `${Buffer.from(account).toString('base64url')}.secret`);
  }

  async get(account: string): Promise<string | null> {
    try {
      return await readFile(this.path(account), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async set(account: string, secret: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => {});
    const temp = `${this.path(account)}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temp, secret, { mode: 0o600 });
    await rename(temp, this.path(account));
  }

  async delete(account: string): Promise<boolean> {
    const existed = (await this.get(account)) !== null;
    await rm(this.path(account), { force: true });
    return existed;
  }
}
