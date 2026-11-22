import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { packActionKind, packShortName, type Client, type Invocation, type PackInstallResult, type PackManifest, type Secret } from '@anlyonhq/sdk';
import { apiRequest, followSignOff, signOffFromError, type SignOff } from '../api';
import { parseDuration } from '../args';
import { DEFAULT_API_URL, normaliseApiUrl } from '../config';
import { connect, envApiUrl, makeClient, type Connection } from '../context';
import { CliError, toCliError, usageError } from '../errors';
import { EXIT } from '../exit-codes';
import { registerSecret } from '../redact';
import type { Runtime } from '../runtime';
import { detectMcpClients, MCP_CLIENTS, writeMcpConfig, type McpClient, type McpWrite } from '../setup/mcp';
import { detectProject, ensureEnvIgnored, envValue, gitHubRemote, installCommand, readEnvFile, setEnvValues, type Project } from '../setup/project';
import { confirm, describeTarget } from './actions-write';
import { loginProfileName, loginWithBrowser } from './auth';
import { packCliError, readManifest } from './packs';
import type { CommandContext, CommandSpec } from './types';

/** The consent groups `init` asks for beyond the default login, and why. */
export const INIT_GROUPS = ['anlyon:keys'];
/** Installing a pack also stores its account (secrets) and installs its policies and limits (guardrails). */
export const PACK_GROUPS = ['anlyon:secrets', 'anlyon:guardrails'];

export const SMOKE_ACTION = 'anlyon-smoke-test';
const SMOKE_URL = 'https://httpbin.org/get';
const KEY_VARIABLE = 'ANLYON_API_KEY';
const URL_VARIABLE = 'ANLYON_API_URL';
const POLL_MS = 2_000;
const SETTLED = new Set(['succeeded', 'failed', 'unknown', 'denied', 'expired']);

type Step<T extends Record<string, unknown> = Record<string, unknown>> = { outcome: string } & T;

interface InitReport {
  project: { dir: string; name: string; language: string | null; framework: string | null };
  login: Step<{ profile: string; workspaceId: string; environment: { id: string; slug: string } }>;
  key: Step<{ file: string; variable: string; gitignore: string; apiKeyId?: string }>;
  sdk: Step<{ package?: string; command?: string; detail?: string }>;
  mcp: McpWrite[];
  pack?: Step<{ pack: string; version?: string; steps?: PackInstallResult['steps']; signOffUrl?: string; connection?: Step<{ integration: string; secret: string; connectUrl?: string; instructions?: string }> }>;
  smoke: Step<{ action?: string; invocationId?: string; status?: string; grade?: string | null; receiptId?: string | null; detail?: string; signOffUrl?: string }>;
  next: string[];
}

function sleep(rt: Runtime, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    rt.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new CliError('CANCELLED', 'Cancelled.', EXIT.CANCELLED));
    }, { once: true });
  });
}

function listOption(value: unknown): string[] {
  return (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).flatMap((item) => String(item).split(',')).map((item) => item.trim()).filter(Boolean);
}

/**
 * Sign in, reusing the profile's login when it already holds the groups init needs. A project's
 * ANLYON_API_KEY is ignored here: init acts as the person, and it is the key init writes.
 */
async function signIn(ctx: CommandContext, groups: string[]): Promise<{ connection: Connection; reused: boolean; profile: string }> {
  const rt: Runtime = { ...ctx.rt, env: { ...ctx.rt.env, ANLYON_API_KEY: undefined } };
  const personal: CommandContext = { ...ctx, rt };
  const config = await rt.config.read();
  const name = loginProfileName(personal, config.defaultProfile);
  const previous = config.profiles[name];
  const flagUrl = typeof ctx.options['api-url'] === 'string' ? ctx.options['api-url'] : undefined;
  const apiUrl = normaliseApiUrl(flagUrl ?? previous?.apiUrl ?? envApiUrl(rt.env) ?? DEFAULT_API_URL);
  const globals = { ...ctx.globals, profile: name };

  const held = previous?.oauth?.scopes ?? [];
  if (previous?.authType === 'oauth' && previous.apiUrl === apiUrl && groups.every((group) => held.includes(group))) {
    try {
      return { connection: await connect(globals, rt), reused: true, profile: name };
    } catch (error) {
      const failure = toCliError(error, rt.abortState);
      if (failure.exitCode !== EXIT.AUTH_REQUIRED) throw failure;
    }
  }
  const wanted = [...new Set([...held.filter((scope) => scope.startsWith('anlyon:')), ...groups])];
  ctx.out.info(previous ? `Signing in again to allow: ${groups.join(', ')}.` : 'Signing in. No account yet? The sign-in page lets you create one.');
  await loginWithBrowser(personal, name, apiUrl, previous, { scope: wanted.join(','), quiet: true });
  const connection = await connect(globals, rt);
  const granted = (await rt.config.read()).profiles[name]?.oauth?.scopes ?? [];
  const refused = groups.filter((group) => !granted.includes(group));
  if (refused.length) {
    throw new CliError('CONSENT_INCOMPLETE', `The sign-in did not allow ${refused.join(', ')}, which init needs.`, EXIT.PERMISSION_DENIED, {
      hint: `Run init again and tick ${refused.map((group) => (group === 'anlyon:keys' ? '"Create API keys"' : group === 'anlyon:guardrails' ? '"Guardrails"' : group === 'anlyon:secrets' ? '"Secrets"' : group)).join(' and ')} on the consent screen.`,
    });
  }
  return { connection, reused: false, profile: name };
}

/** The project's key: kept when it already works for this environment, created and written otherwise. Never printed. */
async function projectKey(ctx: CommandContext, connection: Connection, project: Project): Promise<{ key: string; step: InitReport['key'] }> {
  const path = join(project.dir, project.envFile);
  const existing = envValue(await readEnvFile(path), KEY_VARIABLE);
  const apiUrl = connection.target.apiUrl;
  const extra: Record<string, string> = apiUrl === DEFAULT_API_URL ? {} : { [URL_VARIABLE]: apiUrl };
  if (existing) {
    registerSecret(existing);
    let identity: Awaited<ReturnType<Client['auth']['identity']>>['data'] | undefined;
    try {
      identity = (await makeClient(apiUrl, existing, ctx.rt).auth.identity()).data;
    } catch (error) {
      const failure = toCliError(error, ctx.rt.abortState);
      if (failure.exitCode !== EXIT.AUTH_REQUIRED) throw failure;
    }
    if (identity) {
      if (identity.workspaceId !== connection.identity.workspaceId || identity.environmentId !== connection.identity.environmentId) {
        throw new CliError(
          'KEY_TARGET_MISMATCH',
          `${KEY_VARIABLE} in ${project.envFile} belongs to another workspace or environment than this login (${describeTarget(connection)}). It was left as it is.`,
          EXIT.TARGET_MISMATCH,
          { hint: `Remove the ${KEY_VARIABLE} line to make a new key here, or log in to that environment with \`anlyon auth login\`.` },
        );
      }
      await setEnvValues(path, extra);
      const gitignore = await ensureEnvIgnored(project.dir, project.envFile);
      return { key: existing, step: { outcome: 'kept', file: project.envFile, variable: KEY_VARIABLE, gitignore } };
    }
  }
  const { data } = await apiRequest<{ key: string; apiKey: { id: string } }>(ctx.rt, connection, 'POST', '/api/v2/api-keys', { name: `anlyon init: ${project.name}`.slice(0, 100) });
  registerSecret(data.key);
  const gitignore = await ensureEnvIgnored(project.dir, project.envFile);
  await setEnvValues(path, { [KEY_VARIABLE]: data.key, ...extra });
  return { key: data.key, step: { outcome: existing ? 'replaced' : 'created', file: project.envFile, variable: KEY_VARIABLE, gitignore, apiKeyId: data.apiKey?.id } };
}

async function installSdk(ctx: CommandContext, project: Project): Promise<InitReport['sdk']> {
  const install = installCommand(project);
  const pkg = project.language === 'python' ? 'anlyon' : project.language === 'typescript' ? '@anlyonhq/sdk' : undefined;
  if (!install || !pkg) return { outcome: 'no-project', detail: 'No package.json or pyproject.toml here, so no SDK was installed.' };
  const command = [install.command, ...install.args].join(' ');
  if (project.hasSdk) return { outcome: 'present', package: pkg };
  if (ctx.options['no-install'] === true) return { outcome: 'skipped', package: pkg, command };
  ctx.out.info(`Installing ${pkg}: ${command}`);
  const { code } = await ctx.rt.run(install.command, install.args, { cwd: project.dir });
  if (code !== 0) {
    ctx.out.warn(`${command} exited with ${code}. Run it yourself; everything else is set up.`);
    return { outcome: 'failed', package: pkg, command };
  }
  return { outcome: 'installed', package: pkg, command };
}

async function configureMcp(ctx: CommandContext, project: Project, apiUrl: string): Promise<McpWrite[]> {
  const requested = listOption(ctx.options.mcp);
  if (requested.includes('none')) return [];
  const unknown = requested.filter((client) => !(MCP_CLIENTS as readonly string[]).includes(client));
  if (unknown.length) throw usageError(`--mcp takes ${MCP_CLIENTS.join(', ')} or none. Got: ${unknown.join(', ')}.`);
  const clients = requested.length ? (requested as McpClient[]) : await detectMcpClients(project.dir, ctx.rt.env);
  const writes: McpWrite[] = [];
  for (const client of clients) writes.push(await writeMcpConfig(project.dir, client, `${apiUrl}/mcp`));
  return writes;
}

function connectionIntegration(manifest: PackManifest): string | undefined {
  return manifest.secrets?.find((secret) => secret.kind === 'connection')?.integrationId;
}

function accountFor(accounts: Secret[], integration: string): Secret | undefined {
  return accounts.find((secret) => (secret.integrationId ?? secret.connection?.integrationId) === integration && (secret.health?.status ?? secret.connection?.status ?? 'active') === 'active');
}

/** Connect the pack's account: the provider's consent page for a sign-in integration, a person's own terminal for a key. */
async function connectAccount(ctx: CommandContext, connection: Connection, integration: string, waitMs: number | undefined): Promise<NonNullable<NonNullable<InitReport['pack']>['connection']>> {
  const { client } = connection;
  const existing = accountFor((await client.connections.list()).data ?? [], integration);
  if (existing) return { outcome: 'connected', integration, secret: existing.name };
  const secretName = integration.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const entry = ((await client.connections.integrations()).data ?? []).find((candidate) => candidate.id === integration);
  if (!entry) return { outcome: 'unavailable', integration, secret: secretName, instructions: `${integration} cannot be connected on this server.` };

  if (entry.auth?.kind === 'api_key') {
    const instructions = `${entry.auth.instructions} ${entry.auth.instructionsUrl} Then, in your own terminal: anlyon connections add ${integration}`;
    ctx.out.info(`Connect ${entry.name}: ${instructions}`);
    if (waitMs === undefined) return { outcome: 'pending', integration, secret: secretName, instructions };
    ctx.out.info(`Waiting for ${entry.name} to be connected (Ctrl-C to stop waiting)…`);
    const deadline = Date.now() + waitMs;
    while (Date.now() + POLL_MS < deadline) {
      await sleep(ctx.rt, POLL_MS);
      const account = accountFor((await client.connections.list()).data ?? [], integration);
      if (account) return { outcome: 'connected', integration, secret: account.name };
    }
    return { outcome: 'pending', integration, secret: secretName, instructions };
  }

  const session = (await client.connections.createSession({ integrationId: integration, secretName })).data!;
  const noBrowser = ctx.options['no-browser'] === true || ctx.rt.env.ANLYON_NO_BROWSER === '1';
  ctx.out.info(`Connect ${entry.name} in the browser (the provider's consent page):`);
  ctx.out.info(`  ${session.connectUrl}`);
  if (!noBrowser && waitMs !== undefined) ctx.rt.openBrowser(session.connectUrl);
  if (waitMs === undefined) return { outcome: 'pending', integration, secret: secretName, connectUrl: session.connectUrl };
  ctx.out.info('Waiting for consent to finish (Ctrl-C to stop waiting)…');
  const deadline = Math.min(Date.now() + waitMs, Date.parse(session.expiresAt));
  for (;;) {
    const result = (await client.connections.complete(session.sessionId)).data!;
    if (result.status !== 'pending') return { outcome: 'connected', integration, secret: result.secret.name };
    if (Date.now() + POLL_MS > deadline) return { outcome: 'pending', integration, secret: secretName, connectUrl: session.connectUrl };
    await sleep(ctx.rt, POLL_MS);
  }
}

/**
 * Install the pack. Adding its actions loosens the environment's guardrails, so a server that
 * enforces sign-off answers with a link; with --wait init follows it and installs the rest (an
 * install skips what already exists).
 */
async function installPack(ctx: CommandContext, connection: Connection, manifest: PackManifest, waitMs: number | undefined): Promise<PackInstallResult | { signOff: SignOff }> {
  for (let attempt = 0; attempt <= manifest.actions.length; attempt++) {
    try {
      return await connection.client.packs.install(manifest, { withLimits: true });
    } catch (error) {
      const signOff = signOffFromError(error);
      if (!signOff) throw packCliError(error);
      const decided = await awaitSignOff(ctx, connection, signOff, `Installing ${manifest.pack}`, waitMs);
      if (decided.status !== 'applied') return { signOff: decided };
    }
  }
  throw new CliError('PACK_INSTALL_INCOMPLETE', `${manifest.pack} was not fully installed. Run anlyon init --pack again.`, EXIT.ACTION_NOT_SUCCEEDED);
}

/** A read the project can make with what it already knows (a GitHub remote's owner and repo), or none. */
async function packSmokeCall(project: Project, manifest: PackManifest): Promise<{ action: string; input: Record<string, unknown> } | null> {
  const remote = await gitHubRemote(project.dir);
  const known: Record<string, unknown> = remote ? { owner: remote.owner, repo: remote.repo } : {};
  for (const action of manifest.actions) {
    if (packActionKind(action) !== 'read') continue;
    const schema = ('inputSchema' in action ? action.inputSchema : undefined) as { required?: string[] } | undefined;
    const required = schema?.required ?? [];
    if (required.every((field) => field in known)) {
      return { action: `${packShortName(manifest.pack)}-${action.name}`, input: Object.fromEntries(required.map((field) => [field, known[field]])) };
    }
  }
  return null;
}

/**
 * A change init asked for that loosens a guardrail (adding an action is one) and so waits for a
 * person's sign-off: no CLI login may loosen its own guardrails. The person running init is
 * usually that person: with --wait, init opens the sign-off page and carries on once it is
 * approved. Without it, init prints the link and stops at that step.
 */
async function awaitSignOff(ctx: CommandContext, connection: Connection, signOff: SignOff, what: string, waitMs: number | undefined): Promise<SignOff> {
  ctx.out.info(`${what} needs a person's sign-off, because it lets an agent do something new. Approve it here:`);
  ctx.out.info(`  ${signOff.signOffUrl}`);
  if (waitMs === undefined) return signOff;
  const noBrowser = ctx.options['no-browser'] === true || ctx.globals.noInput || ctx.rt.env.ANLYON_NO_BROWSER === '1';
  if (!noBrowser) ctx.rt.openBrowser(signOff.signOffUrl);
  ctx.out.info('Waiting for the sign-off (Ctrl-C to stop waiting)…');
  return followSignOff(ctx.rt, connection, signOff, waitMs);
}

/** The read-only action init calls when no pack gives it one: a GET that changes nothing, governed so it leaves a receipt. */
async function ensureSmokeAction(ctx: CommandContext, connection: Connection, waitMs: number | undefined): Promise<SignOff | null> {
  try {
    await connection.client.actions.get(SMOKE_ACTION);
    return null;
  } catch (error) {
    if ((error as { status?: number }).status !== 404 && (error as { code?: string }).code !== 'NOT_FOUND') throw error;
  }
  const created = await apiRequest(ctx.rt, connection, 'POST', '/api/v2/actions', {
    name: SMOKE_ACTION,
    description: `Reads ${SMOKE_URL}, which echoes the request. Changes nothing. Made by anlyon init to check the setup.`,
    method: 'GET',
    urlTemplate: SMOKE_URL,
    inputSchema: { type: 'object', properties: {} },
    governed: true,
  });
  if (!created.signoff) return null;
  const decided = await awaitSignOff(ctx, connection, created.signoff, `Adding the ${SMOKE_ACTION} action`, waitMs);
  return decided.status === 'applied' ? null : decided;
}

/** One governed read with the project's own key, followed to its outcome, with its receipt. */
async function smokeTest(ctx: CommandContext, connection: Connection, key: string, call: { action: string; input: Record<string, unknown> }): Promise<InitReport['smoke']> {
  const client = makeClient(connection.target.apiUrl, key, ctx.rt);
  let invocation: Invocation = (await client.actions.invoke(call.action, call.input, { idempotencyKey: `init_${randomBytes(9).toString('hex')}` })).data!;
  for (let polls = 0; !SETTLED.has(invocation.status) && invocation.status !== 'pending_approval' && polls < 15; polls++) {
    await sleep(ctx.rt, POLL_MS);
    invocation = (await client.actions.invocation(invocation.id)).data!;
  }
  const outcome = invocation.status === 'succeeded' ? 'succeeded' : invocation.status;
  return {
    outcome,
    action: call.action,
    invocationId: invocation.id,
    status: invocation.status,
    grade: invocation.grade ?? null,
    receiptId: invocation.effectId ?? null,
    ...(invocation.status === 'pending_approval' ? { detail: `An approval policy matched (${invocation.approvalId}).` } : {}),
    ...(invocation.error ? { detail: String(invocation.error) } : {}),
  };
}

function render(ctx: CommandContext, report: InitReport): void {
  const out = ctx.out;
  const { login, key, sdk, mcp, pack, smoke } = report;
  out.line(`Anlyon is set up in ${report.project.name}.`);
  out.line(`  login        ${login.outcome}: profile ${login.profile}, workspace ${login.workspaceId}, environment ${login.environment.slug}`);
  out.line(`  api key      ${key.outcome}: ${key.variable} in ${key.file} (not printed)${key.gitignore === 'added' ? ', .env* added to .gitignore' : ''}`);
  out.line(`  sdk          ${sdk.outcome}${sdk.package ? `: ${sdk.package}` : ''}${sdk.outcome === 'skipped' || sdk.outcome === 'failed' ? ` (run: ${sdk.command})` : ''}`);
  out.line(`  mcp          ${mcp.length ? mcp.map((write) => `${write.file} ${write.outcome}`).join(', ') : 'no coding agent found (use --mcp claude,cursor,codex)'}`);
  if (pack) {
    out.line(`  pack         ${pack.pack}${pack.version ? `@${pack.version}` : ''} ${pack.outcome}${pack.signOffUrl ? `: ${pack.signOffUrl}` : ''}`);
    if (pack.connection) out.line(`  account      ${pack.connection.integration} ${pack.connection.outcome}${pack.connection.connectUrl ? `: ${pack.connection.connectUrl}` : ''}`);
  }
  out.line(`  smoke test   ${smoke.outcome}${smoke.action ? `: ${smoke.action}` : ''}${smoke.receiptId ? `, receipt ${smoke.receiptId}` : ''}${smoke.grade ? ` (${smoke.grade})` : ''}`);
  if (smoke.detail) out.info(smoke.detail);
  for (const write of mcp) if (write.detail) out.info(write.detail);
  out.line('');
  out.line('Next:');
  for (const step of report.next) out.line(`  - ${step}`);
}

export const init: CommandSpec = {
  path: ['init'],
  summary: 'Set up Anlyon in this project from the terminal: sign in, write a key to .env, install the SDK, add the MCP server, optionally install and connect a pack, and run one governed read.',
  defaultTimeoutMs: 20 * 60_000,
  timeoutFor: (options) => (typeof options.wait === 'string' ? parseDuration(options.wait) : 0) + 20 * 60_000,
  options: {
    yes: { type: 'boolean', description: 'Confirm without prompting (required when not interactive).' },
    pack: { type: 'string', description: 'Also install a catalogue pack (e.g. github) and connect its account.' },
    wait: { type: 'string', description: "Wait this long (e.g. 15m) for what needs you in the browser: a sign-off for new actions, or the pack's account. Without it, init prints the links and goes on." },
    mcp: { type: 'string', description: 'Coding agents to configure: claude, cursor, codex (comma-separated), or none. Default: the ones found in the project.' },
    'no-install': { type: 'boolean', description: 'Do not install the SDK; print the command instead.' },
    'no-smoke': { type: 'boolean', description: 'Skip the governed read at the end.' },
    'api-url': { type: 'string', description: `API origin to sign in to (default ${DEFAULT_API_URL}).` },
    'no-browser': { type: 'boolean', description: 'Print links instead of opening a browser.' },
  },
  async run(ctx) {
    if (ctx.args.length) throw usageError('init takes no arguments. Run it in the project directory.');
    const waitMs = typeof ctx.options.wait === 'string' ? parseDuration(ctx.options.wait) : undefined;
    if (ctx.rt.env.ANLYON_API_KEY) ctx.out.warn('ANLYON_API_KEY is set in this shell. init signs in as you and ignores it.');
    const project = await detectProject(ctx.rt.cwd);
    const manifest = typeof ctx.options.pack === 'string' ? await readManifest(ctx.options.pack) : undefined;
    await confirm(ctx, `Set up Anlyon in ${project.dir}? This writes ${project.envFile}, .gitignore and MCP config${manifest ? `, and installs ${manifest.pack}` : ''}.`);

    const groups = [...INIT_GROUPS, ...(manifest ? PACK_GROUPS : [])];
    const { connection, reused, profile } = await signIn(ctx, groups);
    const report: InitReport = {
      project: { dir: project.dir, name: project.name, language: project.language, framework: project.framework },
      login: { outcome: reused ? 'reused' : 'signed-in', profile, workspaceId: connection.identity.workspaceId, environment: { id: connection.environment.id, slug: connection.environment.slug } },
      key: { outcome: '', file: project.envFile, variable: KEY_VARIABLE, gitignore: '' },
      sdk: { outcome: '' },
      mcp: [],
      smoke: { outcome: 'skipped' },
      next: [],
    };
    const { key, step } = await projectKey(ctx, connection, project);
    report.key = step;
    report.sdk = await installSdk(ctx, project);
    report.mcp = await configureMcp(ctx, project, connection.target.apiUrl);

    let smokeCall: { action: string; input: Record<string, unknown> } | null = null;
    if (manifest) {
      const installed = await installPack(ctx, connection, manifest, waitMs);
      if ('signOff' in installed) {
        report.pack = { outcome: 'needs-sign-off', pack: manifest.pack, signOffUrl: installed.signOff.signOffUrl };
      } else {
        const integration = connectionIntegration(manifest);
        const account = integration ? await connectAccount(ctx, connection, integration, waitMs) : { outcome: 'none', integration: '-', secret: '-' };
        report.pack = { outcome: 'installed', pack: installed.pack, version: installed.version, steps: installed.steps, connection: account };
        if (account.outcome === 'connected') smokeCall = await packSmokeCall(project, manifest);
      }
    }

    if (ctx.options['no-smoke'] !== true) {
      const waiting = smokeCall ? null : await ensureSmokeAction(ctx, connection, waitMs);
      if (waiting) {
        report.smoke = { outcome: 'needs-sign-off', action: SMOKE_ACTION, signOffUrl: waiting.signOffUrl };
      } else {
        report.smoke = await smokeTest(ctx, connection, key, smokeCall ?? { action: SMOKE_ACTION, input: {} });
      }
    }

    const sdkLine = project.language === 'python'
      ? "In code: from anlyon import Client; Client(api_key=os.environ['ANLYON_API_KEY']).actions.invoke(...)"
      : "In code: new Client({ apiKey: process.env.ANLYON_API_KEY! }).actions.invoke(...)";
    report.next = [
      ...(report.pack?.signOffUrl ? [`Approve installing ${report.pack.pack}: ${report.pack.signOffUrl}, then run anlyon init --pack ${ctx.options.pack} again (or pass --wait 15m).`] : []),
      ...(report.smoke.signOffUrl ? [`Approve the smoke-test action: ${report.smoke.signOffUrl}, then run anlyon init again (or pass --wait 15m).`] : []),
      ...(report.pack?.connection?.outcome === 'pending'
        ? [report.pack.connection.connectUrl ? `Finish connecting ${report.pack.connection.integration}: ${report.pack.connection.connectUrl}, then run anlyon init --pack ${ctx.options.pack} again.` : `Connect ${report.pack.connection.integration}: ${report.pack.connection.instructions}`]
        : []),
      ...(report.mcp.some((write) => write.outcome === 'added') ? ['Restart your coding agent so it loads the anlyon MCP server; it signs in through the browser when it connects.'] : []),
      sdkLine,
      'Keep guardrails in the repo: anlyon pull writes this environment to anlyon.yaml; anlyon plan and anlyon apply change it.',
      'Upgrade or check your plan: anlyon billing status, anlyon billing upgrade --plan starter.',
    ];

    if (ctx.out.json) ctx.out.result({ data: report });
    else render(ctx, report);
    if (report.smoke.outcome === 'needs-sign-off' || report.pack?.outcome === 'needs-sign-off') return EXIT.SIGN_OFF_REQUIRED;
    return report.smoke.outcome === 'skipped' || report.smoke.outcome === 'succeeded' ? EXIT.OK : report.smoke.outcome === 'pending_approval' ? EXIT.ACTION_PENDING : EXIT.ACTION_NOT_SUCCEEDED;
  },
};

export const initCommands: CommandSpec[] = [init];
