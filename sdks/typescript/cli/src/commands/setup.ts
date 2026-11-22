import { DEFAULT_API_URL, normaliseApiUrl } from '../config';
import { envApiUrl } from '../context';
import { findDirectServers, safeForCommand, type DirectServer } from '../setup/direct-servers';
import { writeMcpConfig, type McpClient } from '../setup/mcp';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import { requireArgs, type CommandContext, type CommandSpec } from './types';

/**
 * `anlyon setup <host>`: put a coding agent behind Anlyon, in one command, with no app and no end users.
 * Calls use the developer's own connection. It writes the host's MCP config, which holds a URL and no
 * secret, because the host signs in through a browser. It sends nothing and needs no login. It also names
 * the servers the agent can still reach directly, since those bypass Anlyon, and leaves removing them to
 * the developer. `init` is the command for a project that builds on the SDK.
 */
const DOCS = 'https://docs.anlyon.com/agents/coding-agents-behind-anlyon';

const SIGN_IN: Record<'claude' | 'cursor', string> = {
  claude: 'In Claude Code, run /mcp, choose anlyon and authenticate. A browser opens. No key is written anywhere.',
  cursor: 'In Cursor, open Settings, then MCP, and connect anlyon. A browser opens. No key is written anywhere.',
};

async function apiUrlFor(ctx: CommandContext): Promise<string> {
  if (typeof ctx.options['api-url'] === 'string') return normaliseApiUrl(ctx.options['api-url']);
  const config = await ctx.rt.config.read();
  const name = ctx.globals.profile ?? config.defaultProfile ?? '';
  return normaliseApiUrl(config.profiles[name]?.apiUrl ?? envApiUrl(ctx.rt.env) ?? DEFAULT_API_URL);
}

function nextFor(server: DirectServer): string | undefined {
  if (server.kind === 'remote' && !safeForCommand(server)) return undefined;
  return server.kind === 'remote' ? `anlyon mcp add ${server.url}${server.name === 'anlyon' ? '' : ` --name ${server.name}`}` : 'It runs on this machine, so it cannot go behind Anlyon: only remote servers can.';
}

function hostCommand(hostName: string, client: 'claude' | 'cursor'): CommandSpec {
  const command: CommandSpec = {
    path: ['setup', hostName],
    summary: `Point ${client === 'claude' ? 'Claude Code' : 'Cursor'} at Anlyon: writes its MCP config, with no secret in it, and names the servers it can still reach directly.`,
    options: {
      'api-url': { type: 'string', description: 'The Anlyon API to point at. Default: this profile\'s, or the hosted one.' },
    },
    async run(ctx) {
      requireArgs(ctx, command);
      const apiUrl = await apiUrlFor(ctx);
      const url = `${apiUrl}/mcp`;
      const write = await writeMcpConfig(ctx.rt.cwd, client as McpClient, url);
      if (write.outcome === 'skipped') {
        throw new CliError('MCP_CONFIG_UNREADABLE', write.detail ?? `${write.file} could not be read.`, EXIT.REJECTED, {
          hint: `Add the server by hand, with the URL ${url}.`,
          fix: { summary: `Fix ${write.file}, or add the anlyon server to it by hand, with the URL ${url}.`, docs: DOCS },
        });
      }
      const direct = await findDirectServers(client, ctx.rt.cwd, ctx.rt.env, apiUrl);
      const next = [SIGN_IN[client], ...(direct.length ? ['Remove the direct servers listed above, and the credentials they use. Until then the agent can skip Anlyon.'] : []), 'Put a server behind Anlyon: anlyon mcp add <url>, then anlyon mcp adopt <name> <tool...>.'];

      if (ctx.out.json) {
        ctx.out.result({ data: { host: hostName, file: write.file, outcome: write.outcome, url, direct: direct.map((server) => ({ ...server, next: nextFor(server) })), next } });
        return;
      }
      if (write.outcome === 'added') ctx.out.line(`Added Anlyon to ${write.file}. The entry holds a URL and no secret, so it is safe to commit.`);
      else if (write.outcome === 'unchanged') ctx.out.line(`${write.file} already points at Anlyon.`);
      else ctx.out.warn(`${write.detail} It should have the URL ${url}.`);

      if (direct.length) {
        ctx.out.line('');
        ctx.out.line(`Your agent can still reach ${direct.length === 1 ? 'this server' : 'these servers'} directly, which skips approvals, limits and receipts:`);
        for (const server of direct) {
          ctx.out.line(`  ${server.name} (${server.kind === 'remote' ? server.url : 'runs locally'}), in ${server.source}`);
          if (server.credentials.length) ctx.out.line(`    It is given ${server.credentials.join(', ')}. If that is a credential, revoke it or take it out of the agent's reach.`);
          const next = nextFor(server);
          if (next) ctx.out.line(`    ${server.kind === 'remote' ? 'Behind Anlyon: ' : ''}${next}`);
          ctx.out.line(server.remove ? `    Remove it: ${server.remove}` : `    Its name or address has characters Anlyon will not put in a command. Remove it from ${server.source} by hand.`);
        }
      }
      ctx.out.line('');
      for (const line of next) ctx.out.line(`Next: ${line}`);
    },
  };
  return command;
}

export const setupCommands: CommandSpec[] = [hostCommand('claude-code', 'claude'), hostCommand('cursor', 'cursor')];
