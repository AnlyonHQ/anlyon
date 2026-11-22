import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeRemoteText } from '../redact';
import type { McpClient } from './mcp';

/**
 * The MCP servers a coding agent can still reach without going through Anlyon, from the host's own
 * configuration. An agent that holds a direct route bypasses every approval and limit, so `anlyon setup`
 * names them. It only reads: what to remove is the developer's call. Only names leave this module, never
 * a header's or an environment variable's value, and a URL loses its query, where tokens end up.
 */
export interface DirectServer {
  name: string;
  /** The file it was found in. */
  source: string;
  /** remote: an http(s) URL, which can go behind Anlyon. local: a process the host starts, which cannot. */
  kind: 'remote' | 'local';
  url?: string;
  /** The names of the headers and environment variables it is given. They may hold a credential. */
  credentials: string[];
  /**
   * How to remove it. Absent when its name, which comes from a file the repo controls, is not safe in
   * a command: an agent may run what is printed here.
   */
  remove?: string;
}

/** What may go into a printed command. Anything else is left out of the command, never quoted into it. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_URL = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;

/** Whether this server's name and URL may be printed in a command. */
export function safeForCommand(server: Pick<DirectServer, 'name' | 'url'>): boolean {
  return SAFE_NAME.test(server.name) && (server.url === undefined || SAFE_URL.test(server.url));
}

type Servers = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const serversIn = (config: Record<string, unknown> | undefined): Servers => (isObject(config?.mcpServers) ? config.mcpServers : {});

const samePath = (a: string, b: string) => a.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(a URL that could not be read)';
  }
}

/** The address decides, never the name: a direct server named `anlyon` is still a way around Anlyon. */
function isAnlyon(url: string | undefined, apiUrl: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(apiUrl).origin && /^\/mcp(\/|$)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function collect(found: DirectServer[], servers: Servers, source: string, remove: (name: string) => string, apiUrl: string): void {
  for (const [name, entry] of Object.entries(servers)) {
    if (!isObject(entry)) continue;
    const url = typeof entry.url === 'string' ? entry.url : undefined;
    if (isAnlyon(url, apiUrl)) continue;
    const credentials = [...Object.keys(isObject(entry.headers) ? entry.headers : {}), ...Object.keys(isObject(entry.env) ? entry.env : {})];
    found.push({
      name: sanitizeRemoteText(name, 80),
      source,
      kind: url ? 'remote' : 'local',
      ...(url ? { url: withoutQuery(url) } : {}),
      credentials: credentials.map((credential) => sanitizeRemoteText(credential, 80)),
      ...(SAFE_NAME.test(name) ? { remove: remove(name) } : {}),
    });
  }
}

export async function findDirectServers(client: McpClient, dir: string, env: Record<string, string | undefined>, apiUrl: string): Promise<DirectServer[]> {
  const home = env.HOME ?? env.USERPROFILE;
  const found: DirectServer[] = [];
  if (client === 'claude') {
    collect(found, serversIn(await readJson(join(dir, '.mcp.json'))), '.mcp.json', (name) => `claude mcp remove ${name} --scope project`, apiUrl);
    if (home) {
      const user = await readJson(join(home, '.claude.json'));
      collect(found, serversIn(user), '~/.claude.json', (name) => `claude mcp remove ${name} --scope user`, apiUrl);
      const projects = isObject(user?.projects) ? user.projects : {};
      for (const [path, project] of Object.entries(projects)) {
        if (samePath(path, dir) && isObject(project)) collect(found, serversIn(project), '~/.claude.json, this project', (name) => `claude mcp remove ${name} --scope local`, apiUrl);
      }
    }
  } else if (client === 'cursor') {
    collect(found, serversIn(await readJson(join(dir, '.cursor', 'mcp.json'))), '.cursor/mcp.json', (name) => `delete "${name}" from .cursor/mcp.json`, apiUrl);
    if (home) collect(found, serversIn(await readJson(join(home, '.cursor', 'mcp.json'))), '~/.cursor/mcp.json', (name) => `delete "${name}" from ~/.cursor/mcp.json`, apiUrl);
  }
  return found;
}
