import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { lineEnding } from './project';

/**
 * MCP configuration for the coding agents in a project. Each gets the hosted server at
 * `<api>/mcp` over HTTP: the agent signs in through the browser the first time it connects, so
 * no key is written to a file that may be committed. Only the `anlyon` entry is ever added;
 * every other server in the file is left exactly as it was.
 */
export const MCP_CLIENTS = ['claude', 'cursor', 'codex'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export const MCP_FILES: Record<McpClient, string> = {
  claude: '.mcp.json',
  cursor: '.cursor/mcp.json',
  codex: '.codex/config.toml',
};

const exists = (path: string) => access(path).then(() => true, () => false);

/**
 * Which coding agents this project uses: their files in the project, or the agent running this
 * command (Claude Code sets CLAUDECODE, Cursor's agent CURSOR_AGENT or CURSOR_TRACE_ID, Codex
 * CODEX_SANDBOX or CODEX_THREAD_ID).
 */
export async function detectMcpClients(dir: string, env: Record<string, string | undefined>): Promise<McpClient[]> {
  const found = new Set<McpClient>();
  if (env.CLAUDECODE || (await exists(join(dir, '.mcp.json'))) || (await exists(join(dir, '.claude'))) || (await exists(join(dir, 'CLAUDE.md')))) found.add('claude');
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID || (await exists(join(dir, '.cursor'))) || (await exists(join(dir, '.cursorrules')))) found.add('cursor');
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID || (await exists(join(dir, '.codex'))) || (await exists(join(dir, 'AGENTS.md')))) found.add('codex');
  return MCP_CLIENTS.filter((client) => found.has(client));
}

export interface McpWrite {
  client: McpClient;
  file: string;
  /** added: new entry; unchanged: already this; kept: an `anlyon` entry that differs was left alone; skipped: the file could not be read as config. */
  outcome: 'added' | 'unchanged' | 'kept' | 'skipped';
  detail?: string;
}

function entryFor(client: Exclude<McpClient, 'codex'>, url: string): Record<string, unknown> {
  return client === 'claude' ? { type: 'http', url } : { url };
}

async function writeJsonConfig(dir: string, client: 'claude' | 'cursor', url: string): Promise<McpWrite> {
  const file = MCP_FILES[client];
  const path = join(dir, file);
  let before: string | undefined;
  try {
    before = await readFile(path, 'utf8');
  } catch {
    before = undefined;
  }
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (before !== undefined && before.trim()) {
    try {
      config = JSON.parse(before);
    } catch {
      return { client, file, outcome: 'skipped', detail: `${file} is not plain JSON; add the anlyon server by hand.` };
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { client, file, outcome: 'skipped', detail: `${file} is not a JSON object.` };
  }
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) as Record<string, unknown>;
  const wanted = entryFor(client, url);
  if (servers.anlyon !== undefined) {
    const same = JSON.stringify(servers.anlyon) === JSON.stringify(wanted);
    return same ? { client, file, outcome: 'unchanged' } : { client, file, outcome: 'kept', detail: `${file} already has an anlyon server; it was left as it is.` };
  }
  config.mcpServers = { ...servers, anlyon: wanted };
  const eol = lineEnding(before);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2).replace(/\n/g, eol)}${eol}`, 'utf8');
  return { client, file, outcome: 'added' };
}

async function writeCodexConfig(dir: string, url: string): Promise<McpWrite> {
  const file = MCP_FILES.codex;
  const path = join(dir, file);
  let before: string | undefined;
  try {
    before = await readFile(path, 'utf8');
  } catch {
    before = undefined;
  }
  const table = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:anlyon|"anlyon")[ \t]*\][ \t]*\r?$/m;
  if (before !== undefined && table.test(before)) {
    const body = before.slice(before.search(table)).split(/\r?\n/).slice(1);
    const end = body.findIndex((line) => /^\s*\[/.test(line));
    const same = (end === -1 ? body : body.slice(0, end)).some((line) => line.trim() === `url = "${url}"`);
    return same ? { client: 'codex', file, outcome: 'unchanged' } : { client: 'codex', file, outcome: 'kept', detail: `${file} already has an anlyon server; it was left as it is.` };
  }
  const eol = lineEnding(before);
  const block = ['[mcp_servers.anlyon]', `url = "${url}"`].join(eol);
  const text = before === undefined || before.trim() === '' ? `${block}${eol}` : `${before}${before.endsWith('\n') ? '' : eol}${eol}${block}${eol}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  return { client: 'codex', file, outcome: 'added' };
}

export async function writeMcpConfig(dir: string, client: McpClient, url: string): Promise<McpWrite> {
  return client === 'codex' ? writeCodexConfig(dir, url) : writeJsonConfig(dir, client, url);
}
