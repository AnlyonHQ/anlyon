import type { SignOffRequest, SignOffStatus } from '@anlyonhq/sdk';
import { parseDuration, parseLimit, type OptionValue } from '../args';
import { connect } from '../context';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import { decodeCursor, localPage } from '../pagination';
import { sanitizeRemoteText } from '../redact';
import { SIGN_OFF_STATUSES, endedReason, exitForSignOff, followSignOff, printSignOff } from '../sign-off';
import { confirm, describeTarget } from './actions-write';
import { requireArgs, type CommandSpec } from './types';

/**
 * `anlyon sign-offs`: the loosening changes this credential asked for, which a workspace admin
 * must approve before they apply. Reading them needs no scope. Nothing here approves one: a person
 * does that at the request's link.
 */

const DEFAULT_LIMIT = 20;
const SERVER_MAX = 100;

const waitMsOf = (options: Record<string, OptionValue>) => (typeof options.wait === 'string' ? parseDuration(options.wait) : undefined);

const list: CommandSpec = {
  path: ['sign-offs', 'list'],
  summary: "List this credential's sign-off requests (--status pending for the ones still waiting).",
  options: {
    status: { type: 'string', description: 'Requests in this status.', choices: SIGN_OFF_STATUSES },
  },
  paginated: true,
  async run(ctx) {
    requireArgs(ctx, list);
    const limit = parseLimit(ctx.globals.limit) ?? DEFAULT_LIMIT;
    const cursor = decodeCursor(ctx.globals.cursor, 'sign-offs.list');
    const offset = cursor?.o ?? 0;
    const status = typeof ctx.options.status === 'string' ? (ctx.options.status as SignOffStatus) : undefined;
    const { client } = await connect(ctx.globals, ctx.rt);
    const response = await client.signOffs.list({ status, limit: Math.min(SERVER_MAX, offset + limit) });
    const page = localPage('sign-offs.list', response.data as SignOffRequest[] | undefined, offset, limit);
    if (ctx.out.json) {
      ctx.out.result({ data: page.data, nextCursor: page.nextCursor });
      return;
    }
    ctx.out.table(page.data, [
      { header: 'ID', value: (row) => row.id },
      { header: 'Status', value: (row) => row.status },
      { header: 'Operation', value: (row) => row.operation },
      { header: 'Expires', value: (row) => row.expiresAt },
      { header: 'Change', value: (row) => (row.summary ? sanitizeRemoteText(row.summary, 120) : undefined) },
    ]);
    if (page.nextCursor) ctx.out.info(`More results: add --cursor ${page.nextCursor}`);
    if (page.data.some((row) => row.status === 'pending')) {
      ctx.out.info('A workspace admin approves a pending request at its link. See it with `anlyon sign-offs get <id>`.');
    }
  },
};

const get: CommandSpec = {
  path: ['sign-offs', 'get'],
  summary: 'Show one sign-off request: its status, the change, and the link a workspace admin approves it at.',
  args: [{ name: 'id', description: 'The sor_ request id.' }],
  options: {
    wait: { type: 'string', description: 'While it is pending, wait up to this long for a decision (e.g. 10m).' },
  },
  timeoutFor: (options) => {
    const waitMs = waitMsOf(options);
    return waitMs === undefined ? undefined : waitMs + 60_000;
  },
  async run(ctx) {
    const [id] = requireArgs(ctx, get);
    const waitMs = waitMsOf(ctx.options);
    const { client } = await connect(ctx.globals, ctx.rt);
    let signOff = (await client.signOffs.get(id!)).data!;
    if (waitMs !== undefined && signOff.status === 'pending') {
      ctx.out.info(`Waiting for a decision on ${signOff.id}. A workspace admin approves it at:`);
      ctx.out.info(signOff.signOffUrl);
      signOff = await followSignOff(client, ctx.rt, signOff, waitMs);
    }

    if (ctx.out.json) ctx.out.result({ data: signOff });
    else printSignOff(ctx.out, signOff);

    if (waitMs === undefined) return EXIT.OK;
    if (signOff.status === 'pending') {
      throw new CliError('TIMEOUT', `No decision on ${signOff.id} before the wait ended. It is still pending.`, EXIT.TIMEOUT);
    }
    if (signOff.status !== 'applied') ctx.out.info(endedReason(signOff));
    else ctx.out.info('Approved and applied.');
    return exitForSignOff(signOff.status);
  },
};

const cancel: CommandSpec = {
  path: ['sign-offs', 'cancel'],
  summary: 'Withdraw a pending sign-off request. Nothing it asked for is applied.',
  args: [{ name: 'id', description: 'The sor_ request id.' }],
  options: {
    yes: { type: 'boolean', description: 'Confirm without prompting (required when not interactive).' },
  },
  async run(ctx) {
    const [id] = requireArgs(ctx, cancel);
    const connection = await connect(ctx.globals, ctx.rt);
    await confirm(ctx, `Withdraw sign-off request ${id} in ${describeTarget(connection)}?`);
    const signOff = (await connection.client.signOffs.cancel(id!)).data!;
    if (ctx.out.json) ctx.out.result({ data: signOff });
    else {
      ctx.out.fields([
        ['id', signOff.id],
        ['status', signOff.status],
      ]);
      ctx.out.info('Withdrawn. Nothing it asked for was applied.');
    }
  },
};

export const signOffCommands: CommandSpec[] = [list, get, cancel];
