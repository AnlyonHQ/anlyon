import type { IntegrationRoute } from '@anlyonhq/sdk';
import { connect } from '../context';
import { sanitizeRemoteText } from '../redact';
import { requireArgs, type CommandSpec } from './types';

/** What each route is called, in the CLI's own words. */
const TITLE: Record<string, string> = {
  integration: 'connect its integration',
  mcp: 'govern it with MCP',
  openapi: 'import an OpenAPI spec',
  mcp_address: 'add an MCP server by its address',
  custom_action: 'declare a custom action',
};

const titleOf = (route: IntegrationRoute): string => TITLE[route.kind] ?? sanitizeRemoteText(route.kind, 40);

const find: CommandSpec = {
  path: ['integrations', 'find'],
  summary: 'The best way for your agent to act in an app, why, and the next command or link. Works for any name, and only suggests: nothing is registered, adopted or connected.',
  args: [{ name: 'name', description: 'The app, for example stripe.' }],
  async run(ctx) {
    const [name] = requireArgs(ctx, find);
    const { client } = await connect(ctx.globals, ctx.rt);
    const data = (await client.connections.findRoute(name!)).data!;
    if (ctx.out.json) return void ctx.out.result({ data });

    const { route, alternatives } = data;
    ctx.out.info(`${sanitizeRemoteText(data.name, 80)}: ${titleOf(route)}`);
    ctx.out.info(sanitizeRemoteText(route.why));
    ctx.out.info(`Next: ${sanitizeRemoteText(route.next.summary)}`);
    if (route.next.command) ctx.out.info(`  ${sanitizeRemoteText(route.next.command)}`);
    if (route.next.url) ctx.out.info(`  ${sanitizeRemoteText(route.next.url)}`);
    if (route.next.docs) ctx.out.info(`  ${sanitizeRemoteText(route.next.docs)}`);
    if (alternatives.length) ctx.out.info(`Other ways: ${alternatives.map(titleOf).join(', ')}.`);
  },
};

export const integrationCommands: CommandSpec[] = [find];
