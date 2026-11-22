import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT } from '../src/exit-codes';
import { clearRegisteredSecrets } from '../src/redact';
import { ENVIRONMENTS, WORKSPACE_ID, startFakeAnlyon, type FakeAnlyon } from './fixtures/fake-anlyon.mjs';
import { harness, storedSecrets, tempDir, type Harness } from './helpers';

const API_KEY = 'anlyon_test_operatorkey_fixture';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  clearRegisteredSecrets();
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(options?: Parameters<typeof startFakeAnlyon>[0]): Promise<{ server: FakeAnlyon; h: Harness }> {
  const server = await startFakeAnlyon({
    apiKeys: { [API_KEY]: { scopes: ['actions:read', 'policies:read', 'runs:read'], environment: 'production', id: 'key_op' } },
    ...options,
  });
  cleanups.push(server.close);
  const dir = await tempDir();
  cleanups.push(dir.cleanup);
  return { server, h: harness(dir.path, { ANLYON_NO_BROWSER: undefined }) };
}

async function login(h: Harness, server: FakeAnlyon, extra: string[] = []) {
  const result = await h.run(['auth', 'login', '--api-url', server.origin, '--json', ...extra]);
  expect(result.code, result.stderr).toBe(0);
  return result;
}

function assertNoSecrets(h: Harness, ...texts: string[]) {
  for (const secret of storedSecrets(h.store)) for (const text of texts) expect(text).not.toContain(secret);
}

describe('auth login (browser, PKCE, loopback)', () => {
  it('logs in, stores the credential in the store and nothing secret in config', async () => {
    const { server, h } = await setup();
    const result = await login(h, server);
    const out = JSON.parse(result.stdout);
    expect(out).toMatchObject({ profile: 'default', apiUrl: server.origin, workspaceId: WORKSPACE_ID, environment: { slug: 'production' }, default: true });
    expect(out.grantedGroups).toEqual(expect.arrayContaining(['anlyon:actions', 'anlyon:observability', 'offline_access']));
    expect(out.grantedGroups).not.toContain('anlyon:approvals.decide');

    const url = new URL(result.browserUrls[0]!);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(`${server.origin}/mcp`);
    expect(new URL(url.searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1');
    expect(url.searchParams.get('state')!.length).toBeGreaterThanOrEqual(43);

    const config = await readFile(join(h.configDir, 'config.json'), 'utf8');
    expect(config).toContain('"authType": "oauth"');
    assertNoSecrets(h, config, result.stdout, result.stderr);
    expect(storedSecrets(h.store).length).toBeGreaterThanOrEqual(2);
  });

  it('refuses browser login under --no-input, and stores nothing on denied consent', async () => {
    const { server, h } = await setup();
    const noInput = await h.run(['auth', 'login', '--api-url', server.origin, '--no-input']);
    expect(noInput.code).toBe(EXIT.USAGE);
    expect(server.state.counts.register).toBe(0);

    const denied = await setup({ denyConsent: true });
    const result = await denied.h.run(['auth', 'login', '--api-url', denied.server.origin]);
    expect(result.code).toBe(EXIT.AUTH_REQUIRED);
    expect(result.stderr).toContain('access_denied');
    expect(denied.h.store.entries.size).toBe(0);
  });

  it('refuses an --environment the login is not bound to, and revokes what it got', async () => {
    const { server, h } = await setup();
    const result = await h.run(['auth', 'login', '--api-url', server.origin, '--environment', 'staging']);
    expect(result.code).toBe(EXIT.TARGET_MISMATCH);
    expect(h.store.entries.size).toBe(0);
    expect(server.state.counts.revoke).toBe(1);
  });

  it('rejects a consent group the server does not offer', async () => {
    const { server, h } = await setup();
    const result = await h.run(['auth', 'login', '--api-url', server.origin, '--scope', 'anlyon:everything']);
    expect(result.code).toBe(EXIT.USAGE);
  });
});

describe('commands resolve the target before any request', () => {
  it('whoami, status and scopes report the server-side binding', async () => {
    const { server, h } = await setup();
    await login(h, server);
    const who = JSON.parse((await h.run(['whoami', '--json'])).stdout);
    expect(who).toMatchObject({ profile: 'default', credentialType: 'oauth', workspaceId: WORKSPACE_ID, environment: { id: ENVIRONMENTS.production.id }, user: { email: 'dev@example.com' } });

    const status = await h.run(['auth', 'status', '--json']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ profile: 'default', profileSource: 'default', stored: true, hasRefreshToken: true, live: { ok: true } });
    assertNoSecrets(h, status.stdout, status.stderr);

    const scopes = JSON.parse((await h.run(['auth', 'scopes', '--json'])).stdout);
    const byCommand = Object.fromEntries(scopes.commands.map((c: { command: string }) => [c.command, c]));
    expect(byCommand['runs list'].available).toBe(true);
    expect(byCommand['policies list']).toMatchObject({ available: false, oauthGroup: 'anlyon:guardrails' });
    expect(byCommand['effects list']).toMatchObject({ scope: 'actions:read', oauthGroup: 'anlyon:actions' });
    expect(byCommand['impact-limits list']).toMatchObject({ scope: 'impact-limits:read', oauthGroup: 'anlyon:actions' });
    expect(byCommand['effects list'].pending).toBeUndefined();
  });

  it('--environment asserts and never overrides; no override header is ever sent', async () => {
    const { server, h } = await setup();
    await login(h, server);
    expect((await h.run(['runs', 'list', '--environment', 'production', '--json'])).code).toBe(0);
    expect((await h.run(['runs', 'list', '--environment', ENVIRONMENTS.production.id, '--json'])).code).toBe(0);
    const before = server.state.requests.filter((r) => r.path === '/api/v2/runs').length;
    const mismatch = await h.run(['runs', 'list', '--environment', 'staging', '--json']);
    expect(mismatch.code).toBe(EXIT.TARGET_MISMATCH);
    expect(JSON.parse(mismatch.stderr).error.code).toBe('ENVIRONMENT_MISMATCH');
    expect(mismatch.stdout).toBe('');
    expect(server.state.requests.filter((r) => r.path === '/api/v2/runs').length).toBe(before);
    for (const request of server.state.requests) {
      expect(request.headers['x-environment-id']).toBeUndefined();
      expect(request.headers['x-workspace-id']).toBeUndefined();
    }
  });

  it('refuses when the credential has been rebound since login (exit 10)', async () => {
    const { server, h } = await setup();
    await login(h, server);
    server.state.environment = 'staging';
    const result = await h.run(['approvals', 'list', '--json']);
    expect(result.code).toBe(EXIT.TARGET_MISMATCH);
    expect(JSON.parse(result.stderr).error.code).toBe('BINDING_CHANGED');
    expect(server.state.requests.some((r) => r.path === '/api/v2/approvals')).toBe(false);
  });

  it('two profiles in two terminals do not retarget each other', async () => {
    const { server, h } = await setup();
    await login(h, server, ['--profile', 'work']);
    const piped = await h.run(['auth', 'login', '--api-key-stdin', '--api-url', server.origin, '--profile', 'ops', '--json'], { stdin: API_KEY });
    expect(piped.code, piped.stderr).toBe(0);
    const a = { ANLYON_PROFILE: 'work' };
    const b = { ANLYON_PROFILE: 'ops' };
    expect((await h.run(['profile', 'use', 'ops'], { env: b })).code).toBe(0);
    expect(JSON.parse((await h.run(['whoami', '--json'], { env: a })).stdout)).toMatchObject({ profile: 'work', credentialType: 'oauth' });
    expect(JSON.parse((await h.run(['whoami', '--json'], { env: b })).stdout)).toMatchObject({ profile: 'ops', credentialType: 'api_key', apiKeyId: 'key_op' });
    expect([...h.store.entries.keys()].sort()).toEqual(['profile.ops', 'profile.work']);
    const list = JSON.parse((await h.run(['profile', 'list', '--json'], { env: a })).stdout);
    expect(list).toMatchObject({ defaultProfile: 'ops', active: 'work' });
  });

  it('concurrent logins to different profiles keep both in the config file', async () => {
    const { server, h } = await setup();
    await Promise.all(['one', 'two', 'three'].map((name) => login(h, server, ['--profile', name])));
    const config = JSON.parse(await readFile(join(h.configDir, 'config.json'), 'utf8'));
    expect(Object.keys(config.profiles).sort()).toEqual(['one', 'three', 'two']);
    expect(new Set(Object.values(config.profiles).map((p) => (p as { oauth: { clientId: string } }).oauth.clientId)).size).toBe(3);
  });

  it('ANLYON_API_KEY is automation mode and conflicts with an explicit profile', async () => {
    const { server, h } = await setup();
    const env = { ANLYON_API_KEY: API_KEY, ANLYON_API_URL: server.origin };
    const who = await h.run(['whoami', '--json'], { env });
    expect(who.code, who.stderr).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({ profile: null, credentialType: 'api_key' });
    const both = await h.run(['whoami', '--profile', 'x'], { env });
    expect(both.code).toBe(EXIT.USAGE);
    assertNoSecrets(h, who.stdout, who.stderr, both.stderr);
    expect(both.stderr).not.toContain(API_KEY);
  });

  it('never sends a profile credential to an overridden API origin', async () => {
    const { server, h } = await setup();
    await login(h, server);
    const result = await h.run(['whoami'], { env: { ANLYON_API_URL: 'https://api.anlyon.com' } });
    expect(result.code).toBe(EXIT.TARGET_MISMATCH);
  });

  it('not logged in → exit 3 with a login hint', async () => {
    const { h } = await setup();
    const result = await h.run(['runs', 'list']);
    expect(result.code).toBe(EXIT.AUTH_REQUIRED);
    expect(result.stderr).toContain('anlyon auth login');
  });
});

describe('read commands and the output contract', () => {
  it('pages with --limit/--cursor and keeps stdout pure JSON', async () => {
    const { server, h } = await setup();
    await login(h, server);
    const first = await h.run(['runs', 'list', '--limit', '3', '--json']);
    const page1 = JSON.parse(first.stdout);
    expect(page1.data.map((r: { id: string }) => r.id)).toEqual(['run_0', 'run_1', 'run_2']);
    const page2 = JSON.parse((await h.run(['runs', 'list', '--limit', '3', '--cursor', page1.nextCursor, '--json'])).stdout);
    expect(page2.data.map((r: { id: string }) => r.id)).toEqual(['run_3', 'run_4', 'run_5']);
    const page3 = JSON.parse((await h.run(['runs', 'list', '--limit', '3', '--cursor', page2.nextCursor, '--json'])).stdout);
    expect(page3).toMatchObject({ nextCursor: null, total: 7 });

    const actions = JSON.parse((await h.run(['actions', 'list', '--limit', '2', '--json'])).stdout);
    expect(actions.data).toHaveLength(2);
    expect(actions.nextCursor).not.toBeNull();
    const wrong = await h.run(['approvals', 'list', '--cursor', page1.nextCursor]);
    expect(wrong.code).toBe(EXIT.USAGE);
  });

  it('human output goes to stdout, the next-page hint to stderr', async () => {
    const { server, h } = await setup();
    await login(h, server);
    const result = await h.run(['runs', 'list', '--limit', '2']);
    expect(result.stdout.split('\n')[0]).toMatch(/^ID\s+NAME\s+STATUS/);
    expect(result.stderr).toContain('--cursor');
    expect(result.stdout).not.toContain('--cursor');
  });

  it('a scope OAuth cannot grant fails with exit 4; an API key with it succeeds', async () => {
    const { server, h } = await setup();
    await login(h, server);
    const denied = await h.run(['policies', 'list', '--json']);
    expect(denied.code).toBe(EXIT.PERMISSION_DENIED);
    expect(JSON.parse(denied.stderr).error).toMatchObject({ status: 403, exitCode: 4 });
    const withKey = await h.run(['policies', 'list', '--json'], { env: { ANLYON_API_KEY: API_KEY, ANLYON_API_URL: server.origin, ANLYON_PROFILE: undefined } });
    expect(withKey.code, withKey.stderr).toBe(0);
  });

  it('effects and impact-limits read the governed-effects endpoints, with filters as query parameters', async () => {
    const { server, h } = await setup();
    await login(h, server);
    await h.run(['effects', 'list', '--outcome', 'unknown', '--unresolved', '--json']);
    const effects = server.state.requests.filter((r) => r.path === '/api/v2/actions/effects').at(-1);
    expect(effects, 'effects list must call GET /api/v2/actions/effects').toBeDefined();
    expect(effects!.method).toBe('GET');
    expect(effects!.query).toMatchObject({ outcome: 'unknown', unresolved: 'true' });
    await h.run(['effects', 'get', 'eff_1', '--json']);
    expect(server.state.requests.some((r) => r.path === '/api/v2/actions/effects/eff_1' && r.method === 'GET')).toBe(true);
    await h.run(['impact-limits', 'list', '--json']);
    expect(server.state.requests.some((r) => r.path === '/api/v2/impact-limits' && r.method === 'GET')).toBe(true);
    await h.run(['impact-limits', 'get', 'lim_1', '--json']);
    expect(server.state.requests.some((r) => r.path === '/api/v2/impact-limits/lim_1' && r.method === 'GET')).toBe(true);
  });

  it('--input supplies options from a file or stdin; flags win; unknown keys are refused', async () => {
    const { server, h } = await setup();
    await login(h, server);
    const file = join(h.configDir, 'in.json');
    await writeFile(file, JSON.stringify({ status: 'failed', limit: 2 }));
    expect((await h.run(['runs', 'list', '--input', file, '--json'])).code).toBe(0);
    const runsCall = server.state.requests.filter((r) => r.path === '/api/v2/runs').at(-1)!;
    expect(runsCall).toBeDefined();
    expect((await h.run(['runs', 'list', '--input', '-', '--json'], { stdin: '{"status":"running"}' })).code).toBe(0);
    expect((await h.run(['runs', 'list', '--input', '-'], { stdin: '{"stauts":"x"}' })).code).toBe(EXIT.USAGE);
    expect((await h.run(['runs', 'list', '--input', '-'], { stdin: '{"status":"bogus"}' })).code).toBe(EXIT.USAGE);
    expect((await h.run(['runs', 'list', '--input', '-'], { stdin: '[1]' })).code).toBe(EXIT.USAGE);
  });

  it('--timeout gives exit 9; SIGINT gives exit 130', async () => {
    const { server, h } = await setup({ apiDelayMs: 2_000 });
    await h.run(['auth', 'login', '--api-key-stdin', '--api-url', server.origin, '--timeout', '10s'], { stdin: API_KEY });
    const slow = await h.run(['actions', 'list', '--timeout', '300ms', '--json']);
    expect(slow.code).toBe(EXIT.TIMEOUT);
    expect(JSON.parse(slow.stderr).error.code).toBe('TIMEOUT');

    const seen = server.state.requests.length;
    const pending = h.run(['actions', 'list', '--json'], { handleSignals: true });
    const deadline = Date.now() + 5_000;
    while (!server.state.requests.slice(seen).some((r) => r.path === '/api/v2/actions') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    process.emit('SIGINT');
    const cancelled = await pending;
    expect(cancelled.code).toBe(EXIT.CANCELLED);
  });

  it('usage errors: unknown command, stray args, list flags on non-lists', async () => {
    const { h } = await setup();
    expect((await h.run(['frobnicate'])).code).toBe(EXIT.USAGE);
    expect((await h.run(['whoami', 'extra'])).code).toBe(EXIT.USAGE);
    expect((await h.run(['whoami', '--limit', '5'])).code).toBe(EXIT.USAGE);
    expect((await h.run(['--help'])).code).toBe(0);
    expect((await h.run(['runs', '--help'])).code).toBe(0);
    const version = await h.run(['--version', '--json']);
    expect(JSON.parse(version.stdout)).toMatchObject({ cli: expect.any(String), sdk: expect.any(String) });
  });
});

describe('auth logout', () => {
  it('revokes the refresh token server-side and deletes the stored credential', async () => {
    const { server, h } = await setup();
    await login(h, server);
    const result = await h.run(['auth', 'logout', '--json']);
    expect(JSON.parse(result.stdout)).toMatchObject({ profile: 'default', revoked: true, deleted: true });
    expect(h.store.entries.size).toBe(0);
    expect([...server.state.refreshTokens.values()].every((record) => record.revoked)).toBe(true);
    expect((await h.run(['whoami'])).code).toBe(EXIT.AUTH_REQUIRED);
    await h.run(['auth', 'logout', '--forget']);
    expect(JSON.parse(await readFile(join(h.configDir, 'config.json'), 'utf8')).profiles).toEqual({});
  });
});

describe('api key login', () => {
  it('stores a key read from a pipe, and never prints or writes it to config', async () => {
    const { server, h } = await setup();
    const result = await h.run(['auth', 'login', '--api-key-stdin', '--api-url', server.origin, '--json'], { stdin: `${API_KEY}\n` });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(API_KEY);
    const config = await readFile(join(h.configDir, 'config.json'), 'utf8');
    expect(config).not.toContain(API_KEY);
    expect(JSON.parse(config).profiles.default.authType).toBe('api_key');
  });
});
