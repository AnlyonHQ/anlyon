import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CliError, usageError } from './errors';
import { EXIT } from './exit-codes';
import { withLock } from './lock';

export const DEFAULT_API_URL = 'https://api.anlyon.com';

/**
 * A profile is a named target: which API origin, which kind of credential, and
 * what that credential resolved to when it was stored. It never contains a
 * secret; secrets live in the OS credential store (credentials/).
 */
export interface Profile {
  apiUrl: string;
  authType: 'oauth' | 'api_key';
  /** OAuth: what discovery returned at login. Pinned so a later metadata change cannot redirect the refresh token. */
  oauth?: {
    issuer: string;
    resource: string;
    clientId: string;
    tokenEndpoint: string;
    revocationEndpoint?: string;
    userinfoEndpoint?: string;
    scopes: string[];
  };
  /** The server-side binding observed at login. A later request that resolves elsewhere is refused. */
  binding?: {
    workspaceId: string;
    environmentId: string;
    environmentSlug?: string;
    environmentName?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ConfigFile {
  version: 1;
  defaultProfile?: string;
  profiles: Record<string, Profile>;
}

export type Env = Record<string, string | undefined>;

/** Where config lives. ANLYON_CONFIG_DIR wins (tests, portable installs). */
export function configDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.ANLYON_CONFIG_DIR) return env.ANLYON_CONFIG_DIR;
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'anlyon');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'anlyon');
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function assertProfileName(name: string): string {
  if (!PROFILE_NAME.test(name)) {
    throw usageError(`Invalid profile name "${name}". Use letters, digits, ".", "_" or "-" (max 64).`);
  }
  return name;
}

/** Normalise an API URL to its origin; only https, or http to a loopback host. */
export function normaliseApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`Invalid API URL "${raw}".`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw usageError(`API URL must use https (http is allowed only for localhost): ${raw}`);
  }
  if (url.username || url.password) throw usageError('API URL must not contain credentials.');
  return url.origin;
}

/**
 * Windows refuses to replace a file another process has open (a concurrent reader),
 * with EPERM/EBUSY/EACCES. Readers hold it for microseconds, so a short bounded retry
 * is enough; anything longer is a real error.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export class ConfigStore {
  readonly dir: string;
  readonly file: string;

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, 'config.json');
  }

  lockPath(name: string): string {
    return join(this.dir, 'locks', `${name}.lock`);
  }

  async read(): Promise<ConfigFile> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: {} };
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as ConfigFile;
      if (parsed.version !== 1 || typeof parsed.profiles !== 'object' || parsed.profiles === null) throw new Error('shape');
      return parsed;
    } catch {
      throw new CliError('CONFIG_INVALID', `${this.file} is not a valid anlyon config file.`, EXIT.ERROR, {
        hint: 'Fix or remove it. It holds no secrets.',
      });
    }
  }

  /**
   * Read-modify-write under the config lock, replacing the file atomically, so
   * two terminals logging in to different profiles cannot drop each other's.
   */
  async update(mutate: (config: ConfigFile) => void | Promise<void>): Promise<ConfigFile> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return withLock(this.lockPath('config'), async () => {
      const config = await this.read();
      await mutate(config);
      const temp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await renameWithRetry(temp, this.file);
      await chmod(this.file, 0o600).catch(() => {});
      return config;
    });
  }
}
