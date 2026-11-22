import type { AdoptedMcpTool, Client, McpAdoptResult, McpToolChoice, McpUpstream } from '@anlyonhq/sdk';
import { parseDuration, type OptionValue } from '../args';
import { connect } from '../context';
import { CliError, usageError } from '../errors';
import { EXIT } from '../exit-codes';
import { sanitizeRemoteText } from '../redact';
import { printSignOff, withSignOff } from '../sign-off';
import { confirm, describeTarget } from './actions-write';
import { requireArgs, type CommandSpec } from './types';

/**
 * `anlyon mcp`: put a remote MCP server behind Anlyon, so an agent calls its tools through approvals,
 * limits and receipts instead of holding the server's credential.
 *
 * A key or a CLI login can register a server and list its tools; no agent can call anything yet.
 * Adopting a tool is what lets an agent call it, so `adopt` returns a sign-off link and a person
 * approves it there, out of band (exit 15). Nothing here can approve one. A tool's class is a suggestion
 * from what the server says, and every word the server sends is untrusted, so it is sanitised here.
 */

const DOCS = 'https://docs.anlyon.com/execution/mcp-servers';
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const APPROVAL_CHOICES = ['suggested', 'all', 'none'] as const;
type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];
/** The classes the risk engine suggests approval for. */
const SUGGESTS_APPROVAL = new Set(['irreversible', 'destructive']);

const waitMsOf = (options: Record<string, OptionValue>) => (typeof options.wait === 'string' ? parseDuration(options.wait) : undefined);
const timeoutFor = (options: Record<string, OptionValue>) => {
  const waitMs = waitMsOf(options);
  return waitMs === undefined ? undefined : waitMs + 60_000;
};
const remote = (text: unknown, max = 120) => (typeof text === 'string' && text ? sanitizeRemoteText(text, max) : undefined);

/** `Authorization: Bearer {{secret:NAME}}` as a header name and value. */
export function parseHeader(text: string): [string, string] {
  const colon = text.indexOf(':');
  const name = colon > 0 ? text.slice(0, colon).trim() : '';
  const value = colon > 0 ? text.slice(colon + 1).trim() : '';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || !value) {
    throw usageError(`--header takes "Name: value". Got: ${text.slice(0, 60)}`, 'Write a credential as a reference, never a value: --header "Authorization: Bearer {{secret:NAME}}".');
  }
  return [name, value];
}

/** A short name from the host: `mcp.tracker.example` is `tracker`. */
export function nameFromUrl(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const labels = host.split('.').filter((label) => !['mcp', 'www', 'api'].includes(label));
  const candidate = (labels.length > 1 ? labels[labels.length - 2]! : (labels[0] ?? '')).replace(/[^a-z0-9-]/g, '-').slice(0, 32);
  return NAME.test(candidate) ? candidate : undefined;
}

/** A server by the name it was registered under, or its mcpu_ id. */
export async function findUpstream(client: Client, ref: string): Promise<McpUpstream> {
  if (ref.startsWith('mcpu_')) return (await client.mcpUpstreams.get(ref)).data!;
  const all = (await client.mcpUpstreams.list()).data ?? [];
  const found = all.find((upstream) => upstream.name === ref);
  if (found) return found;
  throw new CliError('MCP_SERVER_NOT_FOUND', `No MCP server named ${ref} in this environment.`, EXIT.NOT_FOUND, {
    hint: all.length ? `Registered here: ${all.map((upstream) => upstream.name).join(', ')}.` : 'Register one with `anlyon mcp add <url>`.',
    fix: { summary: all.length ? `Use one of the registered names: ${all.map((upstream) => upstream.name).join(', ')}.` : 'Register the server first.', command: all.length ? 'anlyon mcp list' : 'anlyon mcp add <url>', docs: DOCS },
  });
}

/** What the row says about one tool: adopted or not, and whether the adopted definition is still the one listed. */
function stateOf(adopted: AdoptedMcpTool | undefined): string {
  if (!adopted) return 'not adopted';
  if (adopted.state === 'changed') return 'changed: re-adopt to call it';
  return adopted.enabled ? 'adopted' : 'disabled';
}

function printTools(ctx: Parameters<CommandSpec['run']>[0], upstream: McpUpstream): void {
  const adopted = new Map(upstream.adopted.map((entry) => [entry.tool, entry]));
  const rows = upstream.tools.map((tool) => ({ tool, adopted: adopted.get(tool.name) }));
  ctx.out.table(rows, [
    { header: 'Tool', value: (row) => remote(row.tool.name, 80) },
    { header: 'Suggested', value: (row) => remote(row.tool.suggestedClass, 20) },
    { header: 'State', value: (row) => stateOf(row.adopted) },
    { header: 'Approval', value: (row) => (row.adopted ? (row.adopted.requiresApproval ? 'required' : 'no') : undefined) },
    { header: 'Action', value: (row) => (row.adopted ? remote(row.adopted.action, 100) : undefined) },
  ]);
  for (const missing of upstream.adopted.filter((entry) => entry.state === 'missing')) {
    ctx.out.info(`${remote(missing.tool, 80)} is adopted but the server no longer lists it, so it is not called.`);
  }
  ctx.out.info('Suggested classes come from what the server says, which is untrusted.');
}

/** What hosts accept (mcp-server's MAX_TOOL_NAME_LENGTH). A longer name is shortened there, ending in a hash. */
const MAX_TOOL_NAME = 51;
const toolNameNote = (action: string) =>
  `action_${action}`.length <= MAX_TOOL_NAME
    ? `agents call it as action_${action}`
    : `the action is ${action}, and agents see a shortened tool name for it, ending in a hash`;

const add: CommandSpec = {
  path: ['mcp', 'add'],
  summary: 'Register a remote MCP server and list its tools. No agent can call anything until a person signs off adopting a tool.',
  args: [{ name: 'url', description: "The server's Streamable HTTP endpoint, https." }],
  options: {
    name: { type: 'string', description: 'A short name: lowercase letters, digits and hyphens. Default: from the host.' },
    header: { type: 'string', multiple: true, description: 'A header sent on every request, "Name: value". A credential is a reference: "Authorization: Bearer {{secret:NAME}}". Naming a secret needs secrets:read.' },
    oauth: { type: 'boolean', description: 'The server signs people in with OAuth. Always waits for a sign-off, and a person then connects their account in the console.' },
    'client-id': { type: 'string', description: 'With --oauth: the client you registered with the vendor. Default: one Anlyon brings, where the server accepts it.' },
    'client-secret': { type: 'string', description: 'With --oauth: that client\'s secret, as a reference: {{secret:NAME}}.' },
    scope: { type: 'string', multiple: true, description: 'With --oauth: a scope to ask for. Repeat it for more.' },
    'end-user-key-header': { type: 'string', description: 'Each end user brings their own key in this header, which must be one of --header holding your own key as a {{secret:NAME}} reference. Your key lists the tools and is used for calls made for no end user. Not with --oauth.' },
    wait: { type: 'string', description: "If it needs a human's sign-off, wait up to this long for their decision (e.g. 10m)." },
  },
  timeoutFor,
  async run(ctx) {
    const [url] = requireArgs(ctx, add);
    const name = typeof ctx.options.name === 'string' ? ctx.options.name : nameFromUrl(url!);
    if (!name || !NAME.test(name)) throw usageError(name ? `${name} is not a valid name.` : `Could not take a name from ${url}.`, 'Give one with --name: 1 to 32 lowercase letters, digits and hyphens, starting with a letter.');
    const headerOptions = (ctx.options.header ?? []) as string[];
    const headers = Object.fromEntries(headerOptions.map(parseHeader));
    const oauthOnly = ['client-id', 'client-secret', 'scope'].filter((flag) => ctx.options[flag] !== undefined);
    if (ctx.options.oauth !== true && oauthOnly.length) throw usageError(`--${oauthOnly[0]} goes with --oauth.`);
    const endUserKeyHeader = typeof ctx.options['end-user-key-header'] === 'string' ? ctx.options['end-user-key-header'] : undefined;
    if (endUserKeyHeader !== undefined) {
      if (ctx.options.oauth === true) throw usageError('--end-user-key-header does not go with --oauth.', 'A server either signs people in with OAuth or takes each end user\'s own key.');
      if (!Object.keys(headers).some((header) => header.toLowerCase() === endUserKeyHeader.toLowerCase())) {
        throw usageError(`--end-user-key-header names ${endUserKeyHeader}, which is not one of the --header values.`, `Add it with your own key as a reference: --header "${endUserKeyHeader}: {{secret:NAME}}".`);
      }
    }
    const scopes = (ctx.options.scope ?? []) as string[];
    const oauth = ctx.options.oauth === true
      ? {
          ...(typeof ctx.options['client-id'] === 'string' ? { clientId: ctx.options['client-id'] } : {}),
          ...(typeof ctx.options['client-secret'] === 'string' ? { clientSecret: ctx.options['client-secret'] } : {}),
          ...(scopes.length ? { scopes } : {}),
        }
      : undefined;

    const { client } = await connect(ctx.globals, ctx.rt);
    const response = await withSignOff<McpUpstream>(ctx, client, waitMsOf(ctx.options), () =>
      client.mcpUpstreams.register({
        name, url: url!, ...(headerOptions.length ? { headers } : {}), ...(oauth ? { oauth } : {}),
        ...(endUserKeyHeader !== undefined ? { endUserKey: { header: endUserKeyHeader } } : {}),
      }),
    );
    const upstream = response.data;
    if (ctx.out.json) {
      ctx.out.result({ data: upstream ?? null, ...(response.signOff ? { signOffId: response.signOff.id } : {}) });
      return;
    }
    if (!upstream) {
      if (response.signOff) printSignOff(ctx.out, response.signOff);
      return;
    }
    ctx.out.line(`Registered ${upstream.name}: ${upstream.tools.length} tool${upstream.tools.length === 1 ? '' : 's'} listed, none adopted.`);
    if (upstream.tools.length) printTools(ctx, upstream);
    if (upstream.oauth && !upstream.oauth.operatorConnected && !upstream.tools.length) {
      ctx.out.info('This server signs people in. A person connects their account on its page in the console, which lists its tools.');
    }
    if (upstream.endUserKey) {
      ctx.out.info(`Each end user brings their own key, sent in ${upstream.endUserKey.header}. Your key is used for calls made for no end user.`);
    }
    ctx.out.info(`Next: anlyon mcp adopt ${upstream.name} <tool...>. A person signs that off.`);
  },
};

const list: CommandSpec = {
  path: ['mcp', 'list'],
  summary: 'List the MCP servers registered in this environment.',
  async run(ctx) {
    requireArgs(ctx, list);
    const { client } = await connect(ctx.globals, ctx.rt);
    const data = (await client.mcpUpstreams.list()).data ?? [];
    if (ctx.out.json) {
      ctx.out.result({ data });
      return;
    }
    ctx.out.table(data, [
      { header: 'Name', value: (row) => row.name },
      { header: 'URL', value: (row) => row.url },
      { header: 'Tools', value: (row) => String(row.tools.length) },
      { header: 'Adopted', value: (row) => String(row.adopted.length) },
      { header: 'Changed', value: (row) => String(row.adopted.filter((entry) => entry.state !== 'current').length) },
      { header: 'Listed', value: (row) => row.listedAt ?? undefined },
      { header: 'Last error', value: (row) => remote(row.lastError?.message, 80) },
    ]);
    if (!data.length) ctx.out.info('None yet. Register one with `anlyon mcp add <url>`.');
  },
};

const tools: CommandSpec = {
  path: ['mcp', 'tools'],
  summary: "List a server's tools: what each is suggested to be, and whether it is adopted and unchanged.",
  args: [{ name: 'name', description: 'The server: its name or mcpu_ id.' }],
  options: {
    refresh: { type: 'boolean', description: 'List the server again first. Adopted tools keep the definition they were adopted at.' },
  },
  async run(ctx) {
    const [ref] = requireArgs(ctx, tools);
    const { client } = await connect(ctx.globals, ctx.rt);
    let upstream = await findUpstream(client, ref!);
    if (ctx.options.refresh === true) upstream = (await client.mcpUpstreams.refresh(upstream.id)).data!;
    if (ctx.out.json) {
      ctx.out.result({ data: { id: upstream.id, name: upstream.name, toolsHash: upstream.toolsHash, listedAt: upstream.listedAt, lastError: upstream.lastError, tools: upstream.tools, adopted: upstream.adopted } });
      return;
    }
    if (upstream.lastError) ctx.out.warn(`The last listing failed: ${remote(upstream.lastError.message, 300)} This is the listing before it.`);
    printTools(ctx, upstream);
    if (!upstream.tools.length) ctx.out.info('No tools listed. A server that signs people in lists them once a person connects their account in the console.');
  },
};

/** What the adopt request asks for each tool. The server shows a person exactly this. */
export function adoptionChoices(upstream: McpUpstream, names: string[], approval: ApprovalChoice): Record<string, McpToolChoice> {
  const listed = new Map(upstream.tools.map((tool) => [tool.name, tool]));
  const unknown = names.filter((name) => !listed.has(name));
  if (unknown.length) {
    throw new CliError('MCP_TOOL_NOT_LISTED', `Not in the last listing of ${upstream.name}: ${unknown.map((name) => remote(name, 80)).join(', ')}.`, EXIT.REJECTED, {
      hint: `See what it lists with \`anlyon mcp tools ${upstream.name} --refresh\`.`,
      fix: { summary: 'Adopt only tools the server lists. List it again if it added them.', command: `anlyon mcp tools ${upstream.name} --refresh`, docs: DOCS },
    });
  }
  return Object.fromEntries(names.map((name) => {
    const suggested = SUGGESTS_APPROVAL.has(listed.get(name)!.suggestedClass);
    return [name, { requiresApproval: approval === 'all' || (approval === 'suggested' && suggested) }];
  }));
}

const adopt: CommandSpec = {
  path: ['mcp', 'adopt'],
  summary: "Ask to adopt a server's tools as governed actions. A person approves it at the link this prints; nothing here can. Exits 15 until they do.",
  args: [{ name: 'name', description: 'The server: its name or mcpu_ id.' }, { name: 'tool...', description: 'The tools to adopt, by name. A tool that changed is re-adopted the same way.' }],
  options: {
    approval: { type: 'string', choices: APPROVAL_CHOICES, description: 'Which adopted tools wait for approval on every call: "suggested" (what the risk engine calls irreversible or destructive, the default), "all" or "none".' },
    wait: { type: 'string', description: 'Wait up to this long for their decision (e.g. 15m).' },
  },
  timeoutFor,
  async run(ctx) {
    const [ref, ...names] = ctx.args;
    if (!ref || !names.length) throw usageError('Expected a server and at least one tool.', 'Usage: anlyon mcp adopt <name> <tool...>');
    const approval = (typeof ctx.options.approval === 'string' ? ctx.options.approval : 'suggested') as ApprovalChoice;
    const { client } = await connect(ctx.globals, ctx.rt);
    const upstream = await findUpstream(client, ref);
    const choices = adoptionChoices(upstream, [...new Set(names)], approval);
    const response = await withSignOff<McpAdoptResult>(ctx, client, waitMsOf(ctx.options), () => client.mcpUpstreams.adopt(upstream.id, choices));
    const result = response.data;
    if (ctx.out.json) {
      ctx.out.result({ data: result ?? null, ...(response.signOff ? { signOffId: response.signOff.id } : {}) });
      return;
    }
    for (const entry of result?.adopted ?? []) {
      ctx.out.line(`${entry.readopted ? 'Re-adopted' : 'Adopted'} ${remote(entry.tool, 80)}: ${toolNameNote(entry.action.name)}.`);
    }
    for (const entry of result?.skipped ?? []) ctx.out.line(`Skipped ${remote(entry.tool, 80)}: ${remote(entry.reason, 300)}`);
  },
};

const archive: CommandSpec = {
  path: ['mcp', 'archive'],
  summary: 'Archive a server and every action adopted from it. Applies at once: it only takes away what an agent can call.',
  args: [{ name: 'name', description: 'The server: its name or mcpu_ id.' }],
  options: {
    yes: { type: 'boolean', description: 'Confirm without prompting (required when not interactive).' },
  },
  async run(ctx) {
    const [ref] = requireArgs(ctx, archive);
    const connection = await connect(ctx.globals, ctx.rt);
    const upstream = await findUpstream(connection.client, ref!);
    await confirm(ctx, `Archive ${upstream.name} in ${describeTarget(connection)} and archive the ${upstream.adopted.length} action(s) adopted from it?`);
    const archived = (await connection.client.mcpUpstreams.archive(upstream.id)).data!;
    if (ctx.out.json) ctx.out.result({ data: archived });
    else ctx.out.line(`Archived ${archived.name}. ${upstream.adopted.length} action(s) archived with it; their call history stays.`);
  },
};

export const mcpCommands: CommandSpec[] = [add, list, tools, adopt, archive];
