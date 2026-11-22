import { afterEach, describe, expect, it } from 'vitest';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EXIT } from '../src/exit-codes';
import { clearRegisteredSecrets } from '../src/redact';
import { CATALOGUE_PACKS, catalogueManifest } from '../src/setup/catalogue';
import { detectMcpClients, writeMcpConfig } from '../src/setup/mcp';
import { detectProject, ensureEnvIgnored, envValue, ignoresEnvFile, installCommand, setEnvValues } from '../src/setup/project';
import { startFakeAnlyon, type FakeAnlyon } from './fixtures/fake-anlyon.mjs';
import { harness, tempDir, type Harness } from './helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  clearRegisteredSecrets();
  while (cleanups.length) await cleanups.pop()!();
});

async function dir(): Promise<string> {
  const d = await tempDir();
  cleanups.push(d.cleanup);
  return d.path;
}

async function loggedIn(options: Parameters<typeof startFakeAnlyon>[0] = {}): Promise<{ server: FakeAnlyon; h: Harness }> {
  const server = await startFakeAnlyon(options);
  cleanups.push(server.close);
  const h = harness(await dir());
  const login = await h.run(['auth', 'login', '--api-url', server.origin]);
  expect(login.code, login.stderr).toBe(0);
  return { server, h };
}

describe('anlyon billing', () => {
  it('status shows the plan and this month\'s action calls', async () => {
    const { h } = await loggedIn();
    const result = await h.run(['billing', 'status', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout).data).toMatchObject({ plan: 'free', planName: 'Free', usage: { actionInvokes: 0, included: 1000 } });
    const human = await h.run(['billing', 'status']);
    expect(human.stdout).toContain('Free (free)');
    expect(human.stderr).toContain('anlyon billing upgrade --plan starter');
  });

  it('upgrade prints the checkout link, opens it, and with --wait sees the new plan', async () => {
    const { server, h } = await loggedIn();
    const result = await h.run(['billing', 'upgrade', '--plan', 'starter', '--wait', '1m', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(server.state.checkouts).toEqual([{ plan: 'starter', interval: 'month' }]);
    expect(result.browserUrls).toEqual([`${server.origin}/checkout/starter`]);
    expect(JSON.parse(result.stdout).data).toMatchObject({ plan: 'starter', status: 'active', checkoutUrl: `${server.origin}/checkout/starter` });
  });

  it('upgrade with --no-browser only prints the link', async () => {
    const { server, h } = await loggedIn();
    const result = await h.run(['billing', 'upgrade', '--plan', 'growth', '--interval', 'year', '--no-browser']);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout.trim()).toBe(`${server.origin}/checkout/growth`);
    expect(result.browserUrls).toEqual([]);
  });

  it('an existing subscription points at the console, and an API key cannot buy', async () => {
    const { h } = await loggedIn({ plan: 'starter' });
    const exists = await h.run(['billing', 'upgrade', '--plan', 'growth']);
    expect(exists.code).toBe(EXIT.REJECTED);
    expect(exists.stderr).toContain('Change its plan under Billing in the console');

    const key = 'anlyon_test_xxxbilling000000000000';
    const server = await startFakeAnlyon({ apiKeys: { [key]: { scopes: ['billing:read'] } } });
    cleanups.push(server.close);
    const bot = harness(await dir(), { ANLYON_API_KEY: key, ANLYON_API_URL: server.origin });
    const refused = await bot.run(['billing', 'upgrade', '--plan', 'starter']);
    expect(refused.code).toBe(EXIT.PERMISSION_DENIED);
    expect(server.state.checkouts).toEqual([]);
    expect((await bot.run(['billing', 'status'])).code).toBe(EXIT.OK);
  });

  it('needs a plan', async () => {
    const { h } = await loggedIn();
    expect((await h.run(['billing', 'upgrade'])).code).toBe(EXIT.USAGE);
    expect((await h.run(['billing', 'upgrade', '--plan', 'platinum'])).code).toBe(EXIT.USAGE);
  });
});

describe('setup helpers', () => {
  it('the bundled catalogue is exactly packs/*/pack.json', async () => {
    const root = resolve(__dirname, '../../../../packs');
    const onDisk: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = await readFile(join(root, entry.name, 'pack.json'), 'utf8').catch(() => undefined);
      if (manifest) onDisk.push(JSON.parse(manifest).pack);
    }
    expect(Object.values(CATALOGUE_PACKS).map((pack) => (pack as { pack: string }).pack).sort()).toEqual(onDisk.sort());
    expect((catalogueManifest('github') as { pack: string }).pack).toBe('anlyon/github');
    expect((catalogueManifest('anlyon/github') as { pack: string }).pack).toBe('anlyon/github');
    expect(catalogueManifest('nope')).toBeUndefined();
  });

  it('detects the project, its package manager and env file', async () => {
    const d = await dir();
    expect(await detectProject(d)).toMatchObject({ language: null, envFile: '.env', packageManager: null });
    await writeFile(join(d, 'package.json'), JSON.stringify({ name: 'web', dependencies: { next: '15', '@anlyonhq/sdk': '0.9' } }));
    await writeFile(join(d, 'pnpm-lock.yaml'), '');
    expect(await detectProject(d)).toMatchObject({ name: 'web', language: 'typescript', framework: 'next', packageManager: 'pnpm', hasSdk: true, envFile: '.env.local' });
    const py = await dir();
    await writeFile(join(py, 'pyproject.toml'), '[project]\nname = "bot"\ndependencies = ["anlyon-langchain"]\n');
    await writeFile(join(py, 'uv.lock'), '');
    const project = await detectProject(py);
    expect(project).toMatchObject({ name: 'bot', language: 'python', packageManager: 'uv', hasSdk: false });
    expect(installCommand(project)).toEqual({ command: 'uv', args: ['add', 'anlyon'] });
  });

  it('sets env values in place, keeping other lines and CRLF', async () => {
    const d = await dir();
    const path = join(d, '.env');
    await writeFile(path, '# app\r\nDATABASE_URL=postgres://fake\r\nexport ANLYON_API_KEY="old"\r\n');
    expect(envValue(await readFile(path, 'utf8'), 'ANLYON_API_KEY')).toBe('old');
    expect(await setEnvValues(path, { ANLYON_API_KEY: 'anlyon_test_xxxnew', ANLYON_API_URL: 'http://127.0.0.1:1' })).toBe('updated');
    expect(await readFile(path, 'utf8')).toBe('# app\r\nDATABASE_URL=postgres://fake\r\nANLYON_API_KEY=anlyon_test_xxxnew\r\nANLYON_API_URL=http://127.0.0.1:1\r\n');
    expect(await setEnvValues(path, { ANLYON_API_KEY: 'anlyon_test_xxxnew' })).toBe('unchanged');
  });

  it('adds .env* to .gitignore only when it is not already ignored', async () => {
    expect(ignoresEnvFile('node_modules\n.env*\n', '.env.local')).toBe(true);
    expect(ignoresEnvFile('.env.local\n', '.env.local')).toBe(true);
    expect(ignoresEnvFile('# .env\n', '.env')).toBe(false);
    const d = await dir();
    await writeFile(join(d, '.gitignore'), 'node_modules');
    expect(await ensureEnvIgnored(d, '.env')).toBe('added');
    expect(await readFile(join(d, '.gitignore'), 'utf8')).toBe('node_modules\n\n# Environment files hold keys: never commit them.\n.env*\n!.env.example\n');
    expect(await ensureEnvIgnored(d, '.env.local')).toBe('present');
  });

  it('detects coding agents from the environment and project files, and appends to Codex TOML', async () => {
    const d = await dir();
    expect(await detectMcpClients(d, {})).toEqual([]);
    expect(await detectMcpClients(d, { CURSOR_TRACE_ID: 'x' })).toEqual(['cursor']);
    await writeFile(join(d, 'AGENTS.md'), '');
    await mkdir(join(d, '.codex'));
    await writeFile(join(d, '.codex', 'config.toml'), 'model = "o4"\r\n[mcp_servers.docs]\r\ncommand = "docs"\r\n');
    expect(await detectMcpClients(d, { CLAUDECODE: '1' })).toEqual(['claude', 'codex']);
    expect((await writeMcpConfig(d, 'codex', 'https://api.example/mcp')).outcome).toBe('added');
    expect(await readFile(join(d, '.codex', 'config.toml'), 'utf8')).toBe('model = "o4"\r\n[mcp_servers.docs]\r\ncommand = "docs"\r\n\r\n[mcp_servers.anlyon]\r\nurl = "https://api.example/mcp"\r\n');
    expect((await writeMcpConfig(d, 'codex', 'https://api.example/mcp')).outcome).toBe('unchanged');
    expect((await writeMcpConfig(d, 'codex', 'https://other.example/mcp')).outcome).toBe('kept');
    await writeFile(join(d, '.mcp.json'), '{ "mcpServers": { // comments\n } }');
    expect((await writeMcpConfig(d, 'claude', 'https://api.example/mcp')).outcome).toBe('skipped');
  });
});
