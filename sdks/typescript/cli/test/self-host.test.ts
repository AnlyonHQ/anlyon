import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EnvFileExistsError,
  generateSecrets,
  parsePublicAddress,
  renderEnvFile,
  setupUrl,
  writeEnvFile,
} from '../src/self-host/env-file';
import { harness, tempDir } from './helpers';

const POSIX = process.platform !== 'win32';

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

describe('secrets', () => {
  it('draws every secret from the random source, at full length', () => {
    const calls: number[] = [];
    const secrets = generateSecrets((size) => {
      calls.push(size);
      return Buffer.alloc(size, calls.length);
    });
    expect(calls).toEqual([32, 32, 24]);
    expect(secrets.rootKey).toBe(Buffer.alloc(32, 1).toString('base64url'));
    expect(secrets.setupToken).toBe(Buffer.alloc(32, 2).toString('base64url'));
    expect(secrets.postgresPassword).toBe(Buffer.alloc(24, 3).toString('hex'));
  });

  it('makes different, URL-safe secrets each time', () => {
    const a = generateSecrets();
    const b = generateSecrets();
    expect(a.rootKey).not.toBe(b.rootKey);
    expect(a.setupToken).not.toBe(b.setupToken);
    expect(a.postgresPassword).not.toBe(b.postgresPassword);
    expect(a.rootKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.postgresPassword).toMatch(/^[0-9a-f]{48}$/);
  });
});

describe('public address', () => {
  it('serves a real domain over HTTPS on 80 and 443', () => {
    for (const input of ['anlyon.example.com', 'https://anlyon.example.com/', ' Anlyon.Example.com ']) {
      expect(parsePublicAddress(input)).toEqual({ url: 'https://anlyon.example.com', siteAddress: 'anlyon.example.com', httpPort: 80, httpsPort: 443, bind: '0.0.0.0' });
    }
  });

  it('serves localhost and an IP address over plain HTTP', () => {
    expect(parsePublicAddress('localhost')).toEqual({ url: 'http://localhost:8080', siteAddress: ':80', httpPort: 8080, httpsPort: 8443, bind: '127.0.0.1' });
    expect(parsePublicAddress('localhost:9000')?.url).toBe('http://localhost:9000');
    expect(parsePublicAddress('10.0.0.5')?.url).toBe('http://10.0.0.5:8080');
    expect(parsePublicAddress('10.0.0.5')?.bind).toBe('0.0.0.0');
  });

  it('refuses what is not a host name', () => {
    for (const input of ['', 'not a host', 'example.com/path', 'user@example.com', 'localhost:99999', '-bad.example.com']) {
      expect(parsePublicAddress(input), input).toBeNull();
    }
  });
});

describe('the .env file', () => {
  it('holds only bootstrap and infrastructure', () => {
    const secrets = generateSecrets();
    const env = parseEnv(renderEnvFile({ address: parsePublicAddress('anlyon.example.com')!, secrets }));
    expect(Object.keys(env).sort()).toEqual(
      ['ANLYON_BIND', 'ANLYON_HTTPS_PORT', 'ANLYON_PORT', 'ANLYON_PUBLIC_URL', 'ANLYON_ROOT_KEY', 'ANLYON_SETUP_TOKEN', 'DATABASE_URL', 'EDITION', 'POSTGRES_PASSWORD', 'REDIS_URL', 'SITE_ADDRESS'].sort(),
    );
    expect(env.ANLYON_ROOT_KEY).toBe(secrets.rootKey);
    expect(env.DATABASE_URL).toBe(`postgresql://anlyon:${secrets.postgresPassword}@postgres:5432/anlyon`);
    expect(env.ANLYON_PUBLIC_URL).toBe('https://anlyon.example.com');
    expect(env.EDITION).toBe('community');
  });

  it('puts the setup token in the URL fragment', () => {
    expect(setupUrl(parsePublicAddress('anlyon.example.com')!, 'tok')).toBe('https://anlyon.example.com/setup#token=tok');
  });
});

describe('writing the .env', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  it.runIf(POSIX)('is readable and writable by its owner only', async () => {
    const path = join(dir.path, '.env');
    await writeEnvFile(path, 'A=1\n', false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeEnvFile(path, 'A=2\n', true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('never overwrites an existing file without force', async () => {
    const path = join(dir.path, '.env');
    await writeFile(path, 'ANLYON_ROOT_KEY=keep-me\n');
    await expect(writeEnvFile(path, 'ANLYON_ROOT_KEY=new\n', false)).rejects.toBeInstanceOf(EnvFileExistsError);
    expect(await readFile(path, 'utf8')).toBe('ANLYON_ROOT_KEY=keep-me\n');
    await writeEnvFile(path, 'ANLYON_ROOT_KEY=new\n', true);
    expect(await readFile(path, 'utf8')).toBe('ANLYON_ROOT_KEY=new\n');
  });
});

describe('anlyon self-host init', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let install: string;
  beforeEach(async () => {
    dir = await tempDir();
    install = join(dir.path, 'self-host');
    await mkdir(install);
    await writeFile(join(install, 'docker-compose.yml'), 'services: {}\n');
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  it('writes the .env, prints the setup URL, and never prints the root key or database password', async () => {
    const h = harness(join(dir.path, 'config'));
    const result = await h.run(['self-host', 'init', '--yes', '--domain', 'anlyon.example.com', '--dir', install]);
    expect(result.code).toBe(0);
    const env = parseEnv(await readFile(join(install, '.env'), 'utf8'));
    const output = result.stdout + result.stderr;
    expect(output).toContain(`https://anlyon.example.com/setup#token=${env.ANLYON_SETUP_TOKEN}`);
    expect(output).not.toContain(env.ANLYON_ROOT_KEY);
    expect(output).not.toContain(env.POSTGRES_PASSWORD);
    expect(output).toContain('docker compose up -d --build');
    if (POSIX) expect((await stat(join(install, '.env'))).mode & 0o777).toBe(0o600);
  });

  it('defaults to localhost when not interactive', async () => {
    const h = harness(join(dir.path, 'config'));
    const result = await h.run(['self-host', 'init', '--yes', '--dir', install, '--json']);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout) as { publicUrl: string; setupUrl: string; started: boolean };
    expect(doc.publicUrl).toBe('http://localhost:8080');
    expect(doc.setupUrl).toMatch(/^http:\/\/localhost:8080\/setup#token=[A-Za-z0-9_-]{43}$/);
    expect(doc.started).toBe(false);
  });

  it('refuses to replace an existing .env without --force, and changes nothing', async () => {
    await writeFile(join(install, '.env'), 'ANLYON_ROOT_KEY=existing\n');
    const h = harness(join(dir.path, 'config'));
    const refused = await h.run(['self-host', 'init', '--yes', '--dir', install]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/already exists/);
    expect(await readFile(join(install, '.env'), 'utf8')).toBe('ANLYON_ROOT_KEY=existing\n');

    const forced = await h.run(['self-host', 'init', '--yes', '--force', '--dir', install]);
    expect(forced.code).toBe(0);
    expect(parseEnv(await readFile(join(install, '.env'), 'utf8')).ANLYON_ROOT_KEY).not.toBe('existing');
  });

  it('refuses a domain that is not a host name, and a missing directory', async () => {
    const h = harness(join(dir.path, 'config'));
    expect((await h.run(['self-host', 'init', '--yes', '--domain', 'not a host', '--dir', install])).code).toBe(2);
    expect((await h.run(['self-host', 'init', '--yes', '--dir', join(dir.path, 'missing')])).code).toBe(2);
  });
});
