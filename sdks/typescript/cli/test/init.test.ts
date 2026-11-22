import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT } from '../src/exit-codes';
import { clearRegisteredSecrets } from '../src/redact';
import { SMOKE_ACTION } from '../src/commands/init';
import { startFakeAnlyon, type FakeAnlyon } from './fixtures/fake-anlyon.mjs';
import { harness, tempDir, type Harness } from './helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  clearRegisteredSecrets();
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(options: Parameters<typeof startFakeAnlyon>[0] = {}): Promise<{ server: FakeAnlyon; h: Harness; project: string }> {
  const server = await startFakeAnlyon({ actions: [], ...options });
  cleanups.push(server.close);
  const config = await tempDir();
  const project = await tempDir();
  cleanups.push(config.cleanup, project.cleanup);
  return { server, h: harness(config.path), project: project.path };
}

const read = (path: string) => readFile(path, 'utf8').catch(() => undefined);

async function nextApp(dir: string): Promise<void> {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { next: '15.0.0' } }));
}

function noKeyPrinted(server: FakeAnlyon, ...outputs: string[]): void {
  for (const minted of server.state.mintedKeys) for (const output of outputs) expect(output).not.toContain(minted.key);
}

describe('anlyon init', () => {
  it('takes an empty Next.js project to a governed read: key in .env.local, ignored, SDK, MCP, receipt', async () => {
    const { server, h, project } = await setup();
    await nextApp(project);
    const result = await h.run(['init', '--yes', '--api-url', server.origin, '--json'], { cwd: project, env: { CLAUDECODE: '1' } });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout).data;

    expect(report.login).toMatchObject({ outcome: 'signed-in', environment: { slug: 'production' } });
    expect(result.browserUrls[0]).toContain('anlyon%3Akeys');
    expect(server.state.mintedKeys).toHaveLength(1);
    expect(server.state.mintedKeys[0]!.scopes).not.toContain('policies:write');
    expect(server.state.mintedKeys[0]!.name).toBe('anlyon init: shop');

    const env = await read(join(project, '.env.local'));
    expect(env).toContain(`ANLYON_API_KEY=${server.state.mintedKeys[0]!.key}`);
    expect(env).toContain(`ANLYON_API_URL=${server.origin}`);
    expect(await read(join(project, '.gitignore'))).toContain('.env*');
    noKeyPrinted(server, result.stdout, result.stderr);
    expect(report.key).toMatchObject({ outcome: 'created', file: '.env.local', gitignore: 'added' });

    expect(h.ran).toEqual([{ command: 'npm', args: ['install', '@anlyonhq/sdk'], cwd: project }]);
    expect(report.sdk).toMatchObject({ outcome: 'installed', package: '@anlyonhq/sdk' });

    const mcp = JSON.parse((await read(join(project, '.mcp.json')))!);
    expect(mcp.mcpServers.anlyon).toEqual({ type: 'http', url: `${server.origin}/mcp` });
    expect(report.mcp).toEqual([{ client: 'claude', file: '.mcp.json', outcome: 'added' }]);

    expect(server.state.actions.find((action) => action.name === SMOKE_ACTION)).toMatchObject({ method: 'GET', governed: true });
    const invoke = server.state.requests.find((r) => r.path === `/api/v2/actions/${SMOKE_ACTION}/invoke`)!;
    expect(invoke.headers.authorization).toBe(`Bearer ${server.state.mintedKeys[0]!.key}`);
    expect(report.smoke).toMatchObject({ outcome: 'succeeded', action: SMOKE_ACTION, grade: 'acknowledged' });
    expect(report.smoke.receiptId).toMatch(/^eff_/);
    expect(report.next.join('\n')).toContain('anlyon pull');
  });

  it('is idempotent: a second run reuses the login, keeps the key and the MCP entry, and mints nothing', async () => {
    const { server, h, project } = await setup();
    await nextApp(project);
    expect((await h.run(['init', '--yes', '--api-url', server.origin, '--mcp', 'claude,cursor,codex', '--no-install'], { cwd: project })).code).toBe(EXIT.OK);
    const before = await read(join(project, '.env.local'));
    const again = await h.run(['init', '--yes', '--api-url', server.origin, '--mcp', 'claude,cursor,codex', '--no-install', '--json'], { cwd: project });
    expect(again.code, again.stderr).toBe(EXIT.OK);
    const report = JSON.parse(again.stdout).data;
    expect(report.login.outcome).toBe('reused');
    expect(again.browserUrls).toEqual([]);
    expect(report.key.outcome).toBe('kept');
    expect(report.sdk).toMatchObject({ outcome: 'skipped', command: 'npm install @anlyonhq/sdk' });
    expect(report.mcp.map((write: { outcome: string }) => write.outcome)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(server.state.mintedKeys).toHaveLength(1);
    expect(server.state.actions.filter((action) => action.name === SMOKE_ACTION)).toHaveLength(1);
    expect(await read(join(project, '.env.local'))).toBe(before);
    expect(await read(join(project, '.codex/config.toml'))).toBe(`[mcp_servers.anlyon]\nurl = "${server.origin}/mcp"\n`);
    expect(JSON.parse((await read(join(project, '.cursor/mcp.json')))!).mcpServers.anlyon).toEqual({ url: `${server.origin}/mcp` });
  });

  it('never overwrites another MCP server, keeps CRLF, and leaves a different anlyon entry alone', async () => {
    const { server, h, project } = await setup();
    await writeFile(join(project, 'pyproject.toml'), '[project]\r\nname = "agent"\r\ndependencies = ["anlyon>=0.8"]\r\n');
    await writeFile(join(project, '.mcp.json'), '{\r\n  "mcpServers": {\r\n    "github": { "command": "gh-mcp" }\r\n  }\r\n}\r\n');
    await mkdir(join(project, '.cursor'));
    await writeFile(join(project, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { anlyon: { url: 'https://self.example/mcp' } } }));
    const result = await h.run(['init', '--yes', '--api-url', server.origin, '--mcp', 'claude,cursor', '--json', '--no-smoke'], { cwd: project });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout).data;
    const claude = (await read(join(project, '.mcp.json')))!;
    expect(claude).toContain('\r\n');
    expect(JSON.parse(claude).mcpServers).toEqual({ github: { command: 'gh-mcp' }, anlyon: { type: 'http', url: `${server.origin}/mcp` } });
    expect(JSON.parse((await read(join(project, '.cursor', 'mcp.json')))!).mcpServers.anlyon.url).toBe('https://self.example/mcp');
    expect(report.mcp.map((write: { outcome: string }) => write.outcome)).toEqual(['added', 'kept']);
    expect(report.sdk).toMatchObject({ outcome: 'present', package: 'anlyon' });
    expect(h.ran).toEqual([]);
    expect(await read(join(project, '.env'))).toContain('ANLYON_API_KEY=');
    expect(report.smoke.outcome).toBe('skipped');
  });

  it('refuses a key in .env that belongs to another environment, and changes nothing', async () => {
    const other = 'anlyon_test_xxxotherenv000000000000';
    const { server, h, project } = await setup({ apiKeys: { [other]: { scopes: ['actions:invoke'], environment: 'staging' } } });
    await writeFile(join(project, '.env'), `ANLYON_API_KEY=${other}\n`);
    const result = await h.run(['init', '--yes', '--api-url', server.origin, '--mcp', 'none', '--no-smoke'], { cwd: project });
    expect(result.code).toBe(EXIT.TARGET_MISMATCH);
    expect(result.stderr).not.toContain(other);
    expect(server.state.mintedKeys).toHaveLength(0);
    expect(await read(join(project, '.env'))).toBe(`ANLYON_API_KEY=${other}\n`);
  });

  it('needs --yes when not interactive, before anything is sent', async () => {
    const { server, h, project } = await setup();
    const result = await h.run(['init', '--api-url', server.origin], { cwd: project });
    expect(result.code).toBe(EXIT.USAGE);
    expect(server.state.requests).toEqual([]);
  });

  describe('when adding an action needs a sign-off', () => {
    it('prints the link and exits 15 without --wait', async () => {
      const { server, h, project } = await setup({ signOff: true });
      const result = await h.run(['init', '--yes', '--api-url', server.origin, '--mcp', 'none', '--json'], { cwd: project });
      expect(result.code, result.stderr).toBe(EXIT.SIGN_OFF_REQUIRED);
      const request = [...server.state.gateSignOffs.values()][0]!;
      expect(request.operation).toBe('action.create');
      expect(result.stderr).toContain(request.signOffUrl);
      expect(JSON.parse(result.stdout).data.smoke).toMatchObject({ outcome: 'needs-sign-off', signOffUrl: request.signOffUrl });
      expect(server.state.actions).toEqual([]);
    });

    it('with --wait, opens the sign-off page, follows it and finishes the smoke test', async () => {
      const { server, h, project } = await setup({ signOff: true });
      const result = await h.run(['init', '--yes', '--api-url', server.origin, '--mcp', 'none', '--wait', '1m', '--json'], { cwd: project });
      expect(result.code, result.stderr).toBe(EXIT.OK);
      const request = [...server.state.gateSignOffs.values()][0]!;
      expect(result.browserUrls).toContain(request.signOffUrl);
      expect(request.status).toBe('applied');
      expect(JSON.parse(result.stdout).data.smoke).toMatchObject({ outcome: 'succeeded', action: SMOKE_ACTION });
    });
  });

  describe('--pack github', () => {
    it('installs the catalogue pack, says how to connect a key-based account, and falls back to the smoke action', async () => {
      const { server, h, project } = await setup();
      const result = await h.run(['init', '--yes', '--api-url', server.origin, '--mcp', 'none', '--pack', 'github', '--json'], { cwd: project });
      expect(result.code, result.stderr).toBe(EXIT.OK);
      const report = JSON.parse(result.stdout).data;
      for (const group of ['anlyon:keys', 'anlyon:secrets', 'anlyon:guardrails']) expect(decodeURIComponent(result.browserUrls[0]!)).toContain(group);
      expect(report.pack).toMatchObject({ outcome: 'installed', pack: 'anlyon/github', connection: { outcome: 'pending', integration: 'github' } });
      expect(report.pack.connection.instructions).toContain('anlyon connections add github');
      expect(server.state.actions.some((action) => action.name === 'github-list-issues')).toBe(true);
      expect(report.smoke.action).toBe(SMOKE_ACTION);
    });

    it('with a connected account and a GitHub remote, the smoke test is a read of this repository', async () => {
      const github = { id: 'sec_g', name: 'GITHUB', kind: 'static', integrationId: 'github', health: { status: 'active' } };
      const { server, h, project } = await setup({ secrets: [github] });
      await mkdir(join(project, '.git'));
      await writeFile(join(project, '.git', 'config'), '[core]\r\n\tbare = false\r\n[remote "origin"]\r\n\turl = git@github.com:acme/shop.git\r\n');
      const result = await h.run(['init', '--yes', '--api-url', server.origin, '--mcp', 'none', '--pack', 'github', '--json'], { cwd: project });
      expect(result.code, result.stderr).toBe(EXIT.OK);
      const report = JSON.parse(result.stdout).data;
      expect(report.pack.connection).toMatchObject({ outcome: 'connected', secret: 'GITHUB' });
      expect(report.smoke).toMatchObject({ outcome: 'succeeded', action: 'github-list-issues' });
      expect([...server.state.invocations.values()][0]!.input).toEqual({ owner: 'acme', repo: 'shop' });
    });
  });
});
