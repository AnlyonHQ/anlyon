import { afterEach, describe, expect, it } from 'vitest';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { discover } from '../src/auth/discovery';
import { startLoopback, REGISTERED_REDIRECT_URI } from '../src/auth/loopback';
import { TokenManager } from '../src/auth/tokens';
import { ConfigStore, type Profile } from '../src/config';
import { readCredential, writeCredential } from '../src/credentials/credential';
import { FileStore } from '../src/credentials/file';
import { CliError } from '../src/errors';
import { EXIT } from '../src/exit-codes';
import { withLock } from '../src/lock';
import { startFakeAnlyon, type FakeAnlyon } from './fixtures/fake-anlyon.mjs';
import { MemoryStore, tempDir } from './helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fake(options?: Parameters<typeof startFakeAnlyon>[0]): Promise<FakeAnlyon> {
  const server = await startFakeAnlyon(options);
  cleanups.push(server.close);
  return server;
}

describe('loopback redirect listener', () => {
  it('binds 127.0.0.1 on an ephemeral port under the registered path', async () => {
    const listener = await startLoopback({ state: 's', issuer: 'https://x/api/auth' });
    cleanups.push(async () => listener.close());
    const url = new URL(listener.redirectUri);
    expect(url.hostname).toBe('127.0.0.1');
    expect(Number(url.port)).toBeGreaterThan(0);
    expect(`${url.protocol}//${url.hostname}${url.pathname}`).toBe(REGISTERED_REDIRECT_URI);
  });

  it('ignores a wrong state and keeps waiting for the real callback', async () => {
    const listener = await startLoopback({ state: 'right-state', issuer: 'https://x/api/auth' });
    cleanups.push(async () => listener.close());
    const wrong = await fetch(`${listener.redirectUri}?code=evil&state=wrong`);
    expect(wrong.status).toBe(400);
    const other = await fetch(listener.redirectUri.replace('/callback', '/elsewhere?code=x&state=right-state'));
    expect(other.status).toBe(404);
    const ok = await fetch(`${listener.redirectUri}?code=good&state=right-state&iss=${encodeURIComponent('https://x/api/auth')}`);
    expect(ok.status).toBe(200);
    await expect(listener.result).resolves.toEqual({ code: 'good' });
  });

  it('fails on an issuer mismatch (RFC 9207) and on an error response', async () => {
    const a = await startLoopback({ state: 's1', issuer: 'https://x/api/auth' });
    cleanups.push(async () => a.close());
    const outcome = a.result.catch((error: CliError) => error);
    await fetch(`${a.redirectUri}?code=c&state=s1&iss=${encodeURIComponent('https://evil/api/auth')}`);
    expect(((await outcome) as CliError).code).toBe('OAUTH_ISSUER_MISMATCH');

    const b = await startLoopback({ state: 's2', issuer: 'https://x/api/auth' });
    cleanups.push(async () => b.close());
    const denied = b.result.catch((error: CliError) => error);
    await fetch(`${b.redirectUri}?error=access_denied&error_description=%1B%5B31mno&state=s2`);
    const error = (await denied) as CliError;
    expect(error.code).toBe('ACCESS_DENIED');
    expect(error.exitCode).toBe(EXIT.AUTH_REQUIRED);
    expect(error.message).not.toContain('\u001b');
  });

  it('is cancelled by the abort signal', async () => {
    const controller = new AbortController();
    const listener = await startLoopback({ state: 's', issuer: 'i', signal: controller.signal });
    cleanups.push(async () => listener.close());
    controller.abort();
    await expect(listener.result).rejects.toMatchObject({ exitCode: EXIT.CANCELLED });
  });
});

describe('discovery', () => {
  it('discovers the resource, issuer and endpoints from the API origin', async () => {
    const server = await fake();
    const found = await discover(server.origin, fetch);
    expect(found.resource).toBe(`${server.origin}/mcp`);
    expect(found.issuer).toBe(`${server.origin}/api/auth`);
    expect(found.tokenEndpoint).toBe(`${server.origin}/api/auth/oauth2/token`);
  });

  it('refuses endpoints on another origin', async () => {
    const server = await fake();
    const hostile: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).includes('oauth-authorization-server')) return response;
      const body = (await response.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, token_endpoint: 'https://attacker.example/token' }), { status: 200 });
    };
    await expect(discover(server.origin, hostile)).rejects.toThrow(/not on the API origin/);
  });
});

describe('cross-process lock', () => {
  it('serialises concurrent holders', async () => {
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const lock = join(dir.path, 'locks', 'x.lock');
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withLock(lock, async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inside--;
        }),
      ),
    );
    expect(maxInside).toBe(1);
  });

  it('breaks a lock left by a process that no longer exists', async () => {
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const lock = join(dir.path, 'locks', 'x.lock');
    await mkdir(join(dir.path, 'locks'), { recursive: true });
    const { hostname } = await import('node:os');
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), token: 'dead', at: Date.now() }));
    await expect(withLock(lock, async () => 'ran', { timeoutMs: 2000 })).resolves.toBe('ran');
  });

  it('times out on a live holder rather than waiting forever', async () => {
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const lock = join(dir.path, 'locks', 'x.lock');
    await mkdir(join(dir.path, 'locks'), { recursive: true });
    const { hostname } = await import('node:os');
    await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: 'live', at: Date.now() }));
    await expect(withLock(lock, async () => 'ran', { timeoutMs: 300 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
  });
});

describe('token refresh', () => {
  async function loggedIn(server: FakeAnlyon, dirPath: string) {
    const store = new MemoryStore();
    const config = new ConfigStore(dirPath);
    const reg = await fetch(`${server.origin}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none', scope: 'offline_access anlyon:actions' }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const { createPkce } = await import('../src/auth/pkce');
    const pkce = createPkce();
    const authorize = new URL(`${server.origin}/api/auth/oauth2/authorize`);
    Object.entries({ client_id: clientId, redirect_uri: 'http://127.0.0.1:1/callback', scope: 'offline_access anlyon:actions', state: 's', code_challenge: pkce.challenge, code_challenge_method: 'S256' }).forEach(([k, v]) => authorize.searchParams.set(k, v));
    const redirect = new URL((await fetch(authorize, { redirect: 'manual' })).headers.get('location')!);
    const { exchangeCode } = await import('../src/auth/oauth');
    const tokens = await exchangeCode(`${server.origin}/api/auth/oauth2/token`, { clientId, code: redirect.searchParams.get('code')!, redirectUri: 'http://127.0.0.1:1/callback', verifier: pkce.verifier, resource: `${server.origin}/mcp` }, fetch);
    await writeCredential(store, 'p', { v: 1, kind: 'oauth', origin: server.origin, clientId, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.expiresAt });
    const profile: Profile = {
      apiUrl: server.origin,
      authType: 'oauth',
      oauth: { issuer: `${server.origin}/api/auth`, resource: `${server.origin}/mcp`, clientId, tokenEndpoint: `${server.origin}/api/auth/oauth2/token`, scopes: [] },
      createdAt: '',
      updatedAt: '',
    };
    return { store, config, profile };
  }

  it('uses the cached access token while it is fresh', async () => {
    const server = await fake({ accessTtlSeconds: 900 });
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const { store, config, profile } = await loggedIn(server, dir.path);
    const manager = new TokenManager({ store, config, fetch });
    await manager.accessToken('p', profile);
    expect(server.state.counts.refresh).toBe(0);
  });

  it('serialises concurrent refreshes so rotation never trips reuse detection', async () => {
    const server = await fake({ accessTtlSeconds: 30, refreshDelayMs: 20 });
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const { store, config, profile } = await loggedIn(server, dir.path);
    const managers = Array.from({ length: 6 }, () => new TokenManager({ store, config, fetch }));
    const tokens = await Promise.all(managers.map((manager) => manager.accessToken('p', profile)));
    expect(tokens.every((token) => token.startsWith('eyJ'))).toBe(true);
    expect(server.state.counts.reuseDetected).toBe(0);
    expect(server.state.counts.refresh).toBe(6);
    const stored = await readCredential(store, 'p', server.origin);
    expect([...server.state.refreshTokens.entries()].find(([token]) => token === stored!.refreshToken)![1].revoked).toBe(false);
  });

  it('shows what happens without the lock: the server revokes the whole grant', async () => {
    const server = await fake({ accessTtlSeconds: 30, refreshDelayMs: 20 });
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const { store, profile } = await loggedIn(server, dir.path);
    const stored = (await readCredential(store, 'p', server.origin))!;
    const { refreshTokens } = await import('../src/auth/oauth');
    const results = await Promise.allSettled(
      [1, 2].map(() => refreshTokens(profile.oauth!.tokenEndpoint, { clientId: profile.oauth!.clientId, refreshToken: stored.refreshToken!, resource: profile.oauth!.resource }, fetch)),
    );
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(server.state.counts.reuseDetected).toBe(1);
    expect([...server.state.refreshTokens.values()].every((record) => record.revoked)).toBe(true);
  });

  it('deletes a dead credential and asks for login (exit 3) when the grant is gone', async () => {
    const server = await fake({ accessTtlSeconds: 30 });
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const { store, config, profile } = await loggedIn(server, dir.path);
    for (const record of server.state.refreshTokens.values()) record.revoked = true;
    await expect(new TokenManager({ store, config, fetch }).accessToken('p', profile)).rejects.toMatchObject({ code: 'SESSION_EXPIRED', exitCode: EXIT.AUTH_REQUIRED });
    expect(store.entries.size).toBe(0);
  });

  it('never reads a credential stored for a different origin', async () => {
    const store = new MemoryStore();
    await writeCredential(store, 'p', { v: 1, kind: 'api_key', origin: 'https://a.example', apiKey: 'anlyon_test_xxxaaaaaaaaaaaaa' });
    expect(await readCredential(store, 'p', 'https://b.example')).toBeNull();
  });

  it('drops the cached access token rather than overflow a small store', async () => {
    const store = new MemoryStore();
    store.maxSecretBytes = 200;
    await writeCredential(store, 'p', { v: 1, kind: 'oauth', origin: 'https://a', refreshToken: 'r'.repeat(40), accessToken: 'a'.repeat(400), accessTokenExpiresAt: 1 });
    const parsed = JSON.parse(store.entries.get('profile.p')!);
    expect(parsed.refreshToken).toBe('r'.repeat(40));
    expect(parsed.accessToken).toBeUndefined();
  });
});

describe('file credential store (opt-in)', () => {
  it('writes 0600 files and round-trips', async () => {
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const store = new FileStore(dir.path);
    await store.set('profile.x', 'secret-value');
    expect(await store.get('profile.x')).toBe('secret-value');
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises');
      const { readdir } = await import('node:fs/promises');
      const [file] = await readdir(join(dir.path, 'credentials'));
      expect((await stat(join(dir.path, 'credentials', file!))).mode & 0o777).toBe(0o600);
    }
    expect(await store.delete('profile.x')).toBe(true);
    expect(await store.get('profile.x')).toBeNull();
    expect(await readFile(join(dir.path, 'credentials', 'none'), 'utf8').catch(() => null)).toBeNull();
  });
});
