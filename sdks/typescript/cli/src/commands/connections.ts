import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import type { ConnectionIntegration, ConnectSession, ConnectSessionCompletion, Secret } from '@anlyonhq/sdk';
import { parseDuration } from '../args';
import { connect } from '../context';
import { CliError, usageError } from '../errors';
import { EXIT } from '../exit-codes';
import { registerSecret, sanitizeRemoteText } from '../redact';
import { confirm, describeTarget } from './actions-write';
import { requireArgs, type CommandContext, type CommandSpec } from './types';

const POLL_MS = 2_000;
const SECRET_NAME = /^[A-Z0-9_]+$/;
const DEFAULT_WAIT_MS = 15 * 60_000;

/** One word for whether the account works, the same for a key and a sign-in. */
function statusOf(secret: Secret): string | undefined {
  return secret.health?.status ?? secret.connection?.status ?? (secret.integrationId ? 'active' : undefined);
}

function reasonText(reason: string | null | undefined): string {
  switch (reason) {
    case 'key_rejected': return 'the provider refused the stored key';
    case 'access_revoked': return 'the provider no longer honours its access';
    case 'refresh_failed': return 'its token could not be renewed';
    default: return 'it no longer works';
  }
}

function secretFields(secret: Secret): [string, unknown][] {
  return [
    ['secret', secret.name],
    ['kind', secret.kind],
    ['integration', secret.integrationId ?? secret.connection?.integrationId],
    ['status', statusOf(secret)],
    ['checked', secret.health?.checkedAt ?? undefined],
    ['reason', secret.health?.reason ?? undefined],
    ['hosts', secret.allowedHosts?.join(', ')],
    ['placements', secret.allowedPlacements?.join(', ')],
  ];
}

function requireSecretName(name: string | undefined): string {
  if (!name || !SECRET_NAME.test(name)) throw usageError('The secret name is uppercase letters, digits and underscores, for example GITHUB.');
  return name;
}

function sleep(ctx: CommandContext, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    ctx.rt.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new CliError('CANCELLED', 'Cancelled.', EXIT.CANCELLED));
    }, { once: true });
  });
}

/**
 * The API key for an `api_key` integration. It is never a command-line argument: an argument stays
 * in shell history and shows in the process list. Piped, it is read from stdin; at a terminal it is
 * typed at a prompt that does not echo.
 */
async function readApiKey(ctx: CommandContext, integration: ConnectionIntegration): Promise<string> {
  const stdin = ctx.rt.stdin as NodeJS.ReadableStream & { isTTY?: boolean };
  let key: string;
  if (ctx.options['api-key-stdin'] === true) {
    if (stdin.isTTY) {
      throw usageError(
        '--api-key-stdin reads the key from a pipe, so it is never echoed or kept in shell history.',
        `printf %s "$KEY" | anlyon connections add ${integration.id} --api-key-stdin --yes`,
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    key = Buffer.concat(chunks).toString('utf8').trim();
  } else {
    if (!stdin.isTTY || ctx.globals.noInput) {
      throw usageError(
        `${integration.name} is connected with an API key, which this command reads from a prompt or from stdin.`,
        `printf %s "$KEY" | anlyon connections add ${integration.id} --api-key-stdin --yes`,
      );
    }
    ctx.rt.streams.stderr.write(`${integration.name} API key (input is hidden): `);
    const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
    const rl = createInterface({ input: stdin, output: muted, terminal: true });
    key = (await new Promise<string>((resolve) => rl.question('', resolve))).trim();
    rl.close();
    ctx.rt.streams.stderr.write('\n');
  }
  if (!key) throw usageError('No API key was given.');
  if (!/^[\x21-\x7e]+$/.test(key)) throw usageError('The API key must be the key alone, with no spaces or line breaks.');
  registerSecret(key);
  return key;
}

const integrations: CommandSpec = {
  path: ['connections', 'integrations'],
  summary: 'The integrations an account can be connected for, how each is connected, and the hosts its credential may reach.',
  async run(ctx) {
    requireArgs(ctx, integrations);
    const { client } = await connect(ctx.globals, ctx.rt);
    const data = (await client.connections.integrations()).data ?? [];
    if (ctx.out.json) return void ctx.out.result({ data });
    ctx.out.table(data, [
      { header: 'id', value: (row) => row.id },
      { header: 'name', value: (row) => row.name },
      { header: 'connect with', value: (row) => (row.auth?.kind === 'api_key' ? 'API key' : 'sign-in') },
      { header: 'hosts', value: (row) => (row.hostsFromAccount ? "the account's own" : row.hosts?.join(', ')) },
      { header: 'scopes', value: (row) => row.scopes.join(' ') },
    ]);
  },
};

const list: CommandSpec = {
  path: ['connections', 'list'],
  summary: "Connected accounts in the credential's environment.",
  async run(ctx) {
    requireArgs(ctx, list);
    const { client } = await connect(ctx.globals, ctx.rt);
    const data = (await client.connections.list()).data ?? [];
    if (ctx.out.json) return void ctx.out.result({ data });
    ctx.out.table(data, [
      { header: 'secret', value: (row) => row.name },
      { header: 'integration', value: (row) => row.integrationId ?? row.connection?.integrationId },
      { header: 'status', value: (row) => statusOf(row) },
      { header: 'checked', value: (row) => row.health?.checkedAt ?? undefined },
      { header: 'hosts', value: (row) => row.allowedHosts?.join(', ') },
      { header: 'last used', value: (row) => row.lastUsedAt },
    ]);
  },
};

/** Open the consent page for a session and poll until it finishes. Shared by `add` and `reconnect`. */
async function finishConsent(ctx: CommandContext, connection: Awaited<ReturnType<typeof connect>>, session: ConnectSession, waitMs: number, verb: 'connect' | 'reconnect'): Promise<Secret> {
  const noBrowser = ctx.options['no-browser'] === true || ctx.rt.env.ANLYON_NO_BROWSER === '1';
  ctx.out.info(noBrowser ? `Open this URL in a browser to ${verb} the account:` : `Opening your browser to ${verb} the account. If it does not open, visit:`);
  ctx.out.info(`  ${session.connectUrl}`);
  if (session.integration.scopes.length) ctx.out.info(`Access requested: ${session.integration.scopes.join(', ')}`);
  if (!noBrowser) ctx.rt.openBrowser(session.connectUrl);
  ctx.out.info('Waiting for consent to finish (Ctrl-C to cancel)…');

  const deadline = Math.min(Date.now() + waitMs, Date.parse(session.expiresAt));
  let result: ConnectSessionCompletion = (await connection.client.connections.complete(session.sessionId)).data!;
  while (result.status === 'pending') {
    if (Date.now() + POLL_MS > deadline) {
      throw new CliError(
        'CONNECTION_PENDING',
        'Consent did not finish before the wait ended. Nothing was recorded.',
        EXIT.TIMEOUT,
        { hint: 'Run the command again, or finish it from Integrations in the console.' },
      );
    }
    await sleep(ctx, POLL_MS);
    result = (await connection.client.connections.complete(session.sessionId)).data!;
  }
  return result.secret;
}

/**
 * A name with no integration behind it is refused before asking anything, with the way to reach that
 * app. Should the question itself fail, the server's own answer to the connect request still stands.
 */
async function refuseIfNoIntegration(connection: Awaited<ReturnType<typeof connect>>, name: string): Promise<void> {
  const found = await connection.client.connections.findRoute(name).then((response) => response.data, () => undefined);
  if (!found || found.route.kind === 'integration') return;
  throw new CliError('VALIDATION_ERROR', `No integration named "${sanitizeRemoteText(name, 80)}" can be connected. ${sanitizeRemoteText(found.route.why)}`, EXIT.REJECTED, {
    fix: found.route.next,
    hint: `See every route with: anlyon integrations find <name>`,
  });
}

const add: CommandSpec = {
  path: ['connections', 'add'],
  summary: "Connect an account as a secret bound to its hosts: by the provider's consent page, or with an API key for an integration that uses one.",
  args: [{ name: 'integration', description: 'Integration id, for example hubspot or github. See `anlyon connections integrations`.' }],
  options: {
    'api-key-stdin': { type: 'boolean', description: 'For an API-key integration: read the key from stdin instead of a hidden prompt.' },
    secret: { type: 'string', description: 'The secret name actions reference as {{secret:NAME}}. Defaults to the integration id in capitals.' },
    description: { type: 'string', description: 'What this account is for.' },
    'no-browser': { type: 'boolean', description: 'Print the consent URL instead of opening a browser.' },
    wait: { type: 'string', description: 'How long to wait for consent to finish (default 15m, the session lifetime).' },
    yes: { type: 'boolean', description: 'Confirm without prompting (required when not interactive).' },
  },
  timeoutFor: (options) => (typeof options.wait === 'string' ? parseDuration(options.wait) : DEFAULT_WAIT_MS) + 60_000,
  async run(ctx) {
    const [integrationId] = requireArgs(ctx, add);
    const secretName = typeof ctx.options.secret === 'string' ? ctx.options.secret : integrationId!.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (!SECRET_NAME.test(secretName)) throw usageError('--secret must be uppercase letters, digits and underscores, for example HUBSPOT.');
    const waitMs = typeof ctx.options.wait === 'string' ? parseDuration(ctx.options.wait) : DEFAULT_WAIT_MS;
    const description = typeof ctx.options.description === 'string' ? ctx.options.description : undefined;

    const connection = await connect(ctx.globals, ctx.rt);
    const integration = ((await connection.client.connections.integrations()).data ?? []).find((entry) => entry.id === integrationId);

    if (integration?.auth?.kind === 'api_key') {
      ctx.out.info(integration.auth.instructions);
      ctx.out.info(`  ${integration.auth.instructionsUrl}`);
      const apiKey = await readApiKey(ctx, integration);
      await confirm(ctx, `Connect ${integration.name} as secret ${secretName} in ${describeTarget(connection)}?`);
      const secret = (await connection.client.connections.connectWithApiKey({ integrationId: integration.id, secretName, apiKey, ...(description ? { description } : {}) })).data!;
      if (ctx.out.json) return void ctx.out.result({ data: secret });
      ctx.out.fields(secretFields(secret));
      ctx.out.info(`Connected. ${integration.name} accepted the key. Reference it in an action as {{secret:${secret.name}}}.`);
      return;
    }
    if (ctx.options['api-key-stdin'] === true) {
      throw usageError(`${integration?.name ?? integrationId} is connected by signing in, not with an API key. Run the command without --api-key-stdin.`);
    }

    if (!integration) await refuseIfNoIntegration(connection, integrationId!);
    await confirm(ctx, `Connect a ${integrationId} account as secret ${secretName} in ${describeTarget(connection)}?`);
    const session = (await connection.client.connections.createSession({ integrationId: integrationId!, secretName, ...(description ? { description } : {}) })).data!;
    const secret = await finishConsent(ctx, connection, session, waitMs, 'connect');

    if (ctx.out.json) return void ctx.out.result({ data: secret });
    ctx.out.fields(secretFields(secret));
    ctx.out.info(`Connected. Reference it in an action header as Bearer {{secret:${secret.name}}}.`);
  },
};

const check: CommandSpec = {
  path: ['connections', 'check'],
  summary: 'Ask the provider whether a connected account still works, and print it with its status. The same for a key and a sign-in; an account that does not work is an answer, not an error.',
  args: [{ name: 'secret', description: 'The connected account, by its secret name, for example GITHUB. See `anlyon connections list`.' }],
  async run(ctx) {
    const [name] = requireArgs(ctx, check);
    const secretName = requireSecretName(name);
    const { client } = await connect(ctx.globals, ctx.rt);
    const secret = (await client.connections.check(secretName)).data!;
    if (ctx.out.json) return void ctx.out.result({ data: secret });
    ctx.out.fields(secretFields(secret));
    if (secret.health?.status === 'needs_reauth') {
      ctx.out.warn(`${secret.name} no longer works: ${reasonText(secret.health.reason)}. Actions that use it fail before anything is sent. Reconnect it with: anlyon connections reconnect ${secret.name}`);
    } else {
      ctx.out.info(`${secret.name} works. The provider accepted it just now.`);
    }
  },
};

const reconnect: CommandSpec = {
  path: ['connections', 'reconnect'],
  summary: "Make a connected account work again under the same name: a new key for an API-key integration (asked for without echoing), or the provider's consent page for a sign-in integration.",
  args: [{ name: 'secret', description: 'The connected account, by its secret name, for example GITHUB. See `anlyon connections list`.' }],
  options: {
    'api-key-stdin': { type: 'boolean', description: 'For an API-key integration: read the new key from stdin instead of a hidden prompt.' },
    'no-browser': { type: 'boolean', description: 'For a sign-in integration: print the consent URL instead of opening a browser.' },
    wait: { type: 'string', description: 'How long to wait for consent to finish (default 15m, the session lifetime).' },
    yes: { type: 'boolean', description: 'Confirm without prompting (required when not interactive).' },
  },
  timeoutFor: (options) => (typeof options.wait === 'string' ? parseDuration(options.wait) : DEFAULT_WAIT_MS) + 60_000,
  async run(ctx) {
    const [name] = requireArgs(ctx, reconnect);
    const secretName = requireSecretName(name);
    const waitMs = typeof ctx.options.wait === 'string' ? parseDuration(ctx.options.wait) : DEFAULT_WAIT_MS;

    const connection = await connect(ctx.globals, ctx.rt);
    const account = ((await connection.client.connections.list()).data ?? []).find((secret) => secret.name === secretName);
    if (!account) {
      throw new CliError('NOT_FOUND', `No connected account named ${secretName} in ${describeTarget(connection)}.`, EXIT.NOT_FOUND, {
        hint: 'See `anlyon connections list`. A stored value that is not a connected account is rotated with `PUT /api/v2/secrets/{name}`.',
      });
    }
    const integrationId = account.integrationId ?? account.connection?.integrationId ?? '';
    const integration = ((await connection.client.connections.integrations()).data ?? []).find((entry) => entry.id === integrationId);
    const usesKey = integration?.auth?.kind === 'api_key' || (integration === undefined && account.kind === 'static');

    if (usesKey) {
      if (integration?.auth?.kind === 'api_key') {
        ctx.out.info(integration.auth.instructions);
        ctx.out.info(`  ${integration.auth.instructionsUrl}`);
      }
      const apiKey = await readApiKey(ctx, integration ?? { id: integrationId, name: integrationId } as ConnectionIntegration);
      await confirm(ctx, `Replace the key behind ${secretName} in ${describeTarget(connection)}? Actions keep referencing it by this name.`);
      const result = (await connection.client.connections.reconnect(secretName, { apiKey })).data!;
      if (result.status !== 'completed') throw new CliError('UNEXPECTED', 'The server started a sign-in for an account connected with a key.', EXIT.ERROR);
      if (ctx.out.json) return void ctx.out.result({ data: result.secret });
      ctx.out.fields(secretFields(result.secret));
      ctx.out.info(`Reconnected. ${integration?.name ?? integrationId} accepted the new key; {{secret:${result.secret.name}}} keeps working under the same name.`);
      return;
    }
    if (ctx.options['api-key-stdin'] === true) {
      throw usageError(`${secretName} is connected by signing in, not with an API key. Run the command without --api-key-stdin.`);
    }

    await confirm(ctx, `Sign in again for ${secretName} in ${describeTarget(connection)}? Actions keep referencing it by this name.`);
    const result = (await connection.client.connections.reconnect(secretName)).data!;
    const secret = result.status === 'completed' ? result.secret : await finishConsent(ctx, connection, result.session, waitMs, 'reconnect');
    if (ctx.out.json) return void ctx.out.result({ data: secret });
    ctx.out.fields(secretFields(secret));
    ctx.out.info(`Reconnected. {{secret:${secret.name}}} keeps working under the same name.`);
  },
};

export const connectionCommands: CommandSpec[] = [integrations, list, add, check, reconnect];
