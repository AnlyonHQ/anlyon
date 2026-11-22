import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

/**
 * The `.env` a self-hosted install starts from (`anlyon self-host init`, and install.sh beside the
 * compose file, which writes the same file). Everything else is configured in the console.
 *
 * Only bootstrap and infrastructure live here: the edition, the public address, the one root key
 * every master key is derived from, the one-time setup token, and the bundled Postgres and Redis.
 */

export type RandomBytes = (size: number) => Buffer;

export interface Secrets {
  /** 32 random bytes, base64url. The server derives every master key from it. */
  rootKey: string;
  /** 32 random bytes, base64url. Opens /setup once. */
  setupToken: string;
  /** 24 random bytes, hex: safe inside a connection URL without escaping. */
  postgresPassword: string;
}

export function generateSecrets(randomBytes: RandomBytes = nodeRandomBytes): Secrets {
  return {
    rootKey: randomBytes(32).toString('base64url'),
    setupToken: randomBytes(32).toString('base64url'),
    postgresPassword: randomBytes(24).toString('hex'),
  };
}

export interface PublicAddress {
  /** The URL people open: https://anlyon.example.com or http://localhost:8080. */
  url: string;
  /** Caddy's site address: the host name (Caddy gets a certificate), or ":80" for plain HTTP. */
  siteAddress: string;
  /** Host port mapped to Caddy's port 80. */
  httpPort: number;
  /** Host port mapped to Caddy's port 443. */
  httpsPort: number;
  /** Host interface the ports are published on: loopback for a plain-HTTP localhost install. */
  bind: string;
}

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Turn what someone typed (`anlyon.example.com`, `https://anlyon.example.com/`, `localhost`,
 * `localhost:9000`, `10.0.0.5`) into the address the install is served at. A real host name is
 * served over HTTPS on 80 and 443, with a certificate Caddy obtains; localhost and an IP address
 * are served over plain HTTP (no certificate can be issued for them), on 8080 unless a port is given.
 * Null when it is not a host name.
 */
export function parsePublicAddress(input: string): PublicAddress | null {
  let text = input.trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (text.includes('/') || text.includes('@')) return null;
  let host = text;
  let port: number | undefined;
  const match = /^(.*):(\d{1,5})$/.exec(text);
  if (match && !text.startsWith('[')) {
    host = match[1]!;
    port = Number(match[2]);
    if (port < 1 || port > 65535) return null;
  }
  const local = host === 'localhost' || isIP(host) !== 0;
  if (!local && !HOST.test(host)) return null;
  if (local) {
    const httpPort = port ?? 8080;
    const bind = host === 'localhost' ? '127.0.0.1' : '0.0.0.0';
    return { url: `http://${host}:${httpPort}`, siteAddress: ':80', httpPort, httpsPort: 8443, bind };
  }
  const httpsPort = port ?? 443;
  return { url: httpsPort === 443 ? `https://${host}` : `https://${host}:${httpsPort}`, siteAddress: host, httpPort: 80, httpsPort, bind: '0.0.0.0' };
}

export interface EnvFileInput {
  address: PublicAddress;
  secrets: Secrets;
  edition?: 'community' | 'team' | 'enterprise';
  now?: Date;
}

export function renderEnvFile({ address, secrets, edition = 'community', now = new Date() }: EnvFileInput): string {
  return `# Anlyon, self-hosted. Written by \`anlyon self-host init\` on ${now.toISOString().slice(0, 10)}.
# Keep this file private: it holds the install's root key.
#
# This file is only what the server needs before it can reach its database.
# Everything else (email, file storage, sign-up, licence, telemetry, OAuth apps,
# Slack) is set in the console: Settings, Instance.

# community (free), team or enterprise (licensed; paste the key in the console).
EDITION=${edition}

# Where the install is served. The console and the API share this address.
ANLYON_PUBLIC_URL=${address.url}
SITE_ADDRESS=${address.siteAddress}
ANLYON_PORT=${address.httpPort}
ANLYON_HTTPS_PORT=${address.httpsPort}
# The address the ports are published on: 127.0.0.1 for a localhost install, else every interface.
ANLYON_BIND=${address.bind}

# The one secret. Every key the server needs (sessions, API keys, stored secrets,
# connected accounts) is derived from it. Copy it somewhere other than this
# server, such as a password manager: without it, stored secrets and connected
# accounts cannot be read, and nobody can recover them.
ANLYON_ROOT_KEY=${secrets.rootKey}

# Opens the setup page once, to create the first owner. Unused afterwards.
ANLYON_SETUP_TOKEN=${secrets.setupToken}

# The bundled Postgres and Redis (docker-compose.yml).
POSTGRES_PASSWORD=${secrets.postgresPassword}
DATABASE_URL=postgresql://anlyon:${secrets.postgresPassword}@postgres:5432/anlyon
REDIS_URL=redis://redis:6379
`;
}

/** Where the console's setup page is, with the one-time token in the fragment (never sent to a server). */
export function setupUrl(address: PublicAddress, setupToken: string): string {
  return `${address.url}/setup#token=${setupToken}`;
}

export class EnvFileExistsError extends Error {
  constructor(readonly path: string) {
    super(`${path} already exists`);
    this.name = 'EnvFileExistsError';
  }
}

/**
 * Write the file readable and writable by its owner only (0600). Refuses to replace an existing one
 * unless `force`: a new file means a new root key, and anything encrypted under the old one would
 * become unreadable. A replacement is written beside it and renamed over it, so the old file is
 * never half-overwritten.
 */
export async function writeEnvFile(path: string, content: string, force: boolean): Promise<void> {
  if (!force) {
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new EnvFileExistsError(path);
      throw error;
    }
    try {
      await handle.writeFile(content, 'utf8');
      await handle.chmod(0o600).catch(() => {});
    } finally {
      await handle.close();
    }
    return;
  }
  const temporary = join(path, '..', `.env.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.chmod(0o600).catch(() => {});
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
