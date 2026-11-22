import { afterEach, describe, expect, it } from 'vitest';
import { EXIT } from '../src/exit-codes';
import { clearRegisteredSecrets } from '../src/redact';
import { startFakeAnlyon, type FakeAnlyon } from './fixtures/fake-anlyon.mjs';
import { harness, tempDir, type Harness } from './helpers';

const KEY = 'anlyon_test_xxxsecrets0000000000';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  clearRegisteredSecrets();
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(options: Record<string, unknown> = {}): Promise<{ server: FakeAnlyon; h: Harness; env: Record<string, string> }> {
  const server = await startFakeAnlyon({ apiKeys: { [KEY]: { scopes: ['secrets:read', 'secrets:write'] } }, ...options });
  cleanups.push(server.close);
  const dir = await tempDir();
  cleanups.push(dir.cleanup);
  return { server, h: harness(dir.path), env: { ANLYON_API_KEY: KEY, ANLYON_API_URL: server.origin } };
}

describe('anlyon integrations find', () => {
  it('answers with the route and the next command as JSON, with no scope', async () => {
    const { h, env } = await setup({ apiKeys: { [KEY]: { scopes: [] } } });
    const result = await h.run(['integrations', 'find', 'figma', '--json'], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    const { data } = JSON.parse(result.stdout);
    expect(data.route).toMatchObject({ kind: 'mcp', next: { command: 'anlyon mcp add https://mcp.figma.com/mcp' }, mcp: { host: 'mcp.figma.com' } });
    expect(data.alternatives.map((route: { kind: string }) => route.kind)).toEqual(['openapi']);
  });

  it('says why and what next for a person, and is not an error for an unknown name', async () => {
    const { h, env } = await setup();
    const result = await h.run(['integrations', 'find', 'figma'], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    const printed = result.stdout + result.stderr;
    expect(printed).toMatch(/figma: govern it with MCP/);
    expect(printed).toMatch(/Next: Add mcp\.figma\.com/);
    expect(printed).toMatch(/anlyon mcp add https:\/\/mcp\.figma\.com\/mcp/);
    expect(printed).toMatch(/Other ways: import an OpenAPI spec/);

    const unknown = await h.run(['integrations', 'find', 'acme'], { env });
    expect(unknown.code).toBe(EXIT.OK);
    expect(unknown.stdout + unknown.stderr).toMatch(/If acme publishes an OpenAPI spec/);
  });

  it('sends the name encoded, and strips control characters from what it prints', async () => {
    const { server, h, env } = await setup();
    const result = await h.run(['integrations', 'find', 'acme \u001b[31mred&x=1'], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(result.stdout + result.stderr).not.toContain('\u001b');
    const asked = server.state.requests.filter((r: { path: string }) => r.path.endsWith('/integrations/find'));
    expect(asked).toHaveLength(1);
  });

  it('needs a name', async () => {
    const { h, env } = await setup();
    expect((await h.run(['integrations', 'find'], { env })).code).toBe(EXIT.USAGE);
  });
});

describe('anlyon connections', () => {
  it('add refuses a name with no integration before asking anything, with the route as fix', async () => {
    const { server, h, env } = await setup();
    const result = await h.run(['connections', 'add', 'acme', '--json'], { env });
    expect(result.code).toBe(EXIT.REJECTED);
    const { error } = JSON.parse(result.stdout + result.stderr);
    expect(error.fix).toMatchObject({ summary: 'Import the spec.', url: expect.stringContaining('vendor=acme') });
    expect(server.state.connectSessions.size).toBe(0);
  });

  it('lists integrations', async () => {
    const { h, env } = await setup();
    const result = await h.run(['connections', 'integrations', '--json'], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout).data[0]).toMatchObject({ id: 'hubspot', hosts: ['api.hubapi.com'] });
  });

  it('add opens the consent page, polls until consent finishes, and prints the secret', async () => {
    const { server, h, env } = await setup({ consentAfterPolls: 2 });
    const result = await h.run(['connections', 'add', 'hubspot', '--secret', 'HUBSPOT', '--yes', '--json'], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(result.browserUrls).toHaveLength(1);
    expect(result.browserUrls[0]).toMatch(/\/connect\/csn_/);
    expect(JSON.parse(result.stdout).data).toMatchObject({ name: 'HUBSPOT', kind: 'connection', allowedHosts: ['api.hubapi.com'] });
    const completes = server.state.requests.filter((r: { path: string }) => r.path.endsWith('/complete'));
    expect(completes.length).toBe(3);
    const listed = await h.run(['connections', 'list', '--json'], { env });
    expect(JSON.parse(listed.stdout).data.map((s: { name: string }) => s.name)).toEqual(['HUBSPOT']);
  }, 20_000);

  it('defaults the secret name from the integration and prints the URL with --no-browser', async () => {
    const { h, env } = await setup({ consentAfterPolls: 0 });
    const result = await h.run(['connections', 'add', 'hubspot', '--no-browser', '--yes'], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(result.browserUrls).toHaveLength(0);
    expect(result.stderr).toMatch(/Open this URL in a browser/);
    expect(result.stdout).toMatch(/secret\s+HUBSPOT/);
  });

  it('refuses a bad secret name, an unknown integration, and a write without --yes', async () => {
    const { server, h, env } = await setup();
    expect((await h.run(['connections', 'add', 'hubspot', '--secret', 'lower', '--yes'], { env })).code).toBe(EXIT.USAGE);
    expect((await h.run(['connections', 'add', 'hubspot'], { env })).code).toBe(EXIT.USAGE);
    expect(server.state.connectSessions.size).toBe(0);
    expect((await h.run(['connections', 'add', 'nope', '--yes'], { env })).code).toBe(EXIT.REJECTED);
  });

  it('connects an API-key integration from stdin, never opens a browser, and never prints the key', async () => {
    const { server, h, env } = await setup();
    const apiKey = 'fixture-github-token-not-a-key-0000';
    const result = await h.run(['connections', 'add', 'github', '--api-key-stdin', '--yes', '--json'], { env, stdin: `${apiKey}\n` });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(result.browserUrls).toHaveLength(0);
    expect(result.stdout + result.stderr).not.toContain(apiKey);
    expect(result.stderr).toMatch(/fine-grained token/);
    expect(JSON.parse(result.stdout).data).toMatchObject({ name: 'GITHUB', kind: 'static', integrationId: 'github', allowedHosts: ['api.github.com'] });
    expect(server.state.keyConnects).toEqual([{ integrationId: 'github', secretName: 'GITHUB', apiKey }]);
    expect(server.state.connectSessions.size).toBe(0);
    const listed = await h.run(['connections', 'list', '--json'], { env });
    expect(JSON.parse(listed.stdout).data.map((s: { name: string }) => s.name)).toEqual(['GITHUB']);
  });

  it('says so when the provider does not accept the key, and stores nothing', async () => {
    const { server, h, env } = await setup();
    const result = await h.run(['connections', 'add', 'github', '--api-key-stdin', '--yes'], { env, stdin: 'fixture-rejected-token-0000' });
    expect(result.code).toBe(EXIT.REJECTED);
    expect(result.stderr).toMatch(/did not accept that key/);
    expect(result.stdout + result.stderr).not.toContain('fixture-rejected-token-0000');
    expect(server.state.secrets).toEqual([]);
  });

  it('refuses an API-key integration with no key to read, a key with a space in it, and --api-key-stdin for a sign-in integration', async () => {
    const { server, h, env } = await setup();
    const noKey = await h.run(['connections', 'add', 'github', '--yes'], { env });
    expect(noKey.code).toBe(EXIT.USAGE);
    expect(noKey.stderr).toMatch(/--api-key-stdin/);
    expect((await h.run(['connections', 'add', 'github', '--api-key-stdin', '--yes'], { env, stdin: '' })).code).toBe(EXIT.USAGE);
    expect((await h.run(['connections', 'add', 'github', '--api-key-stdin', '--yes'], { env, stdin: 'two words' })).code).toBe(EXIT.USAGE);
    expect((await h.run(['connections', 'add', 'hubspot', '--api-key-stdin', '--yes'], { env, stdin: 'x' })).code).toBe(EXIT.USAGE);
    expect(server.state.requests.filter((r: { method: string }) => r.method !== 'GET')).toEqual([]);
  });

  it('check prints an account with its health, and says how to reconnect one that no longer works', async () => {
    const { server, h, env } = await setup({ checkAnswer: 'rejected' });
    await h.run(['connections', 'add', 'github', '--api-key-stdin', '--yes'], { env, stdin: 'fixture-github-token-not-a-key-0000' });
    const result = await h.run(['connections', 'check', 'GITHUB', '--json'], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout).data).toMatchObject({ name: 'GITHUB', health: { status: 'needs_reauth', reason: 'key_rejected' } });
    expect(server.state.checks).toEqual(['GITHUB']);
    const human = await h.run(['connections', 'check', 'GITHUB'], { env });
    expect(human.code).toBe(EXIT.OK);
    expect(human.stdout).toMatch(/status\s+needs_reauth/);
    expect(human.stderr).toMatch(/refused the stored key/);
    expect(human.stderr).toMatch(/anlyon connections reconnect GITHUB/);
    const listed = await h.run(['connections', 'list'], { env });
    expect(listed.stdout).toMatch(/needs_reauth/);
    expect((await h.run(['connections', 'check', 'NOPE'], { env })).code).toBe(EXIT.NOT_FOUND);
    expect((await h.run(['connections', 'check', 'lower'], { env })).code).toBe(EXIT.USAGE);
  });

  it('reconnect asks for a new key for a key integration, never echoes it, and keeps the secret name', async () => {
    const { server, h, env } = await setup();
    await h.run(['connections', 'add', 'github', '--api-key-stdin', '--yes'], { env, stdin: 'fixture-github-token-not-a-key-0000' });
    const renewed = 'fixture-github-token-renewed-1111';
    const result = await h.run(['connections', 'reconnect', 'GITHUB', '--api-key-stdin', '--yes', '--json'], { env, stdin: `${renewed}\n` });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(result.browserUrls).toHaveLength(0);
    expect(result.stdout + result.stderr).not.toContain(renewed);
    expect(result.stderr).toMatch(/fine-grained token/);
    expect(JSON.parse(result.stdout).data).toMatchObject({ name: 'GITHUB', integrationId: 'github', health: { status: 'active' } });
    expect(server.state.reconnects).toEqual([{ secretName: 'GITHUB', apiKey: renewed }]);
    expect(server.state.secrets.map((s) => s.name)).toEqual(['GITHUB']);

    const refused = await h.run(['connections', 'reconnect', 'GITHUB', '--api-key-stdin', '--yes'], { env, stdin: 'fixture-rejected-token-0000' });
    expect(refused.code).toBe(EXIT.REJECTED);
    expect(refused.stderr).toMatch(/did not accept that key/);
    expect(refused.stdout + refused.stderr).not.toContain('fixture-rejected-token-0000');
  });

  it('reconnect opens the consent page again for a sign-in account, and refuses --api-key-stdin for it', async () => {
    const { server, h, env } = await setup({ consentAfterPolls: 1 });
    await h.run(['connections', 'add', 'hubspot', '--yes'], { env });
    const result = await h.run(['connections', 'reconnect', 'HUBSPOT', '--yes', '--json'], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(result.browserUrls).toHaveLength(1);
    expect(JSON.parse(result.stdout).data).toMatchObject({ name: 'HUBSPOT', kind: 'connection', health: { status: 'active' } });
    expect(server.state.reconnects).toEqual([{ secretName: 'HUBSPOT', apiKey: undefined }]);
    expect(server.state.secrets).toHaveLength(1);
    expect((await h.run(['connections', 'reconnect', 'HUBSPOT', '--api-key-stdin', '--yes'], { env, stdin: 'x' })).code).toBe(EXIT.USAGE);
    expect((await h.run(['connections', 'reconnect', 'NOPE', '--yes'], { env })).code).toBe(EXIT.NOT_FOUND);
    expect((await h.run(['connections', 'reconnect', 'HUBSPOT'], { env })).code).toBe(EXIT.USAGE);
  }, 20_000);

  it('stops with a timeout exit when consent does not finish in time', async () => {
    const { h, env } = await setup({ consentAfterPolls: 1000 });
    const result = await h.run(['connections', 'add', 'hubspot', '--wait', '1s', '--yes'], { env });
    expect(result.code).toBe(EXIT.TIMEOUT);
    expect(result.stderr).toMatch(/Nothing was recorded/);
  });
});
