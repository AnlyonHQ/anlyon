import { assertProfileName, DEFAULT_API_URL, normaliseApiUrl, type Profile } from '../config';
import { CAPABILITIES, DEFAULT_LOGIN_SCOPES } from '../capabilities';
import { connect, envApiUrl, makeClient, resolveTarget, type Environment } from '../context';
import { accountFor, deleteCredential, readCredential, writeCredential } from '../credentials/credential';
import { CliError, toCliError, usageError } from '../errors';
import { EXIT } from '../exit-codes';
import { withLock } from '../lock';
import { discover, type OAuthServer } from '../auth/discovery';
import { startLoopback } from '../auth/loopback';
import { authorizationUrl, exchangeCode, registerClient, revokeToken } from '../auth/oauth';
import { createPkce, createState } from '../auth/pkce';
import { registerSecret } from '../redact';
import type { Runtime } from '../runtime';
import type { CommandContext, CommandSpec } from './types';
import type { CredentialIdentity } from '@anlyonhq/sdk';

const LOGIN_TIMEOUT_MS = 10 * 60_000;

export function loginProfileName(ctx: CommandContext, defaultProfile: string | undefined): string {
  return assertProfileName(ctx.globals.profile ?? ctx.rt.env.ANLYON_PROFILE ?? defaultProfile ?? 'default');
}

async function readStdinSecret(rt: Runtime): Promise<string> {
  if ((rt.stdin as { isTTY?: boolean }).isTTY) {
    throw usageError(
      '--api-key-stdin reads the key from a pipe, so it is never echoed or kept in shell history.',
      'printf %s "$ANLYON_API_KEY" | anlyon auth login --api-key-stdin',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of rt.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  const key = Buffer.concat(chunks).toString('utf8').trim();
  if (!key) throw usageError('No API key on stdin.');
  registerSecret(key);
  return key;
}

/** Best-effort revocation of whatever this profile held before. */
async function revokePrevious(rt: Runtime, name: string, previous: Profile | undefined): Promise<void> {
  if (!previous?.oauth?.revocationEndpoint) return;
  try {
    const old = await readCredential(rt.credentialStore(), name, previous.apiUrl);
    if (old?.refreshToken) {
      await revokeToken(previous.oauth.revocationEndpoint, { clientId: previous.oauth.clientId, token: old.refreshToken, hint: 'refresh_token' }, rt.fetch, rt.signal);
    }
  } catch {
  }
}

function assertEnvironment(ctx: CommandContext, environment: Environment): void {
  const wanted = ctx.globals.environment;
  if (wanted && environment.id !== wanted && environment.slug?.toLowerCase() !== wanted.toLowerCase()) {
    throw new CliError(
      'ENVIRONMENT_MISMATCH',
      `This login is bound to environment ${environment.slug} (${environment.id}), not ${wanted}. Nothing was saved.`,
      EXIT.TARGET_MISMATCH,
      { hint: 'Log in again and pick the other workspace/environment on the consent screen, or use an API key for it.' },
    );
  }
}

async function saveProfile(
  ctx: CommandContext,
  name: string,
  profile: Omit<Profile, 'createdAt' | 'updatedAt'>,
): Promise<{ madeDefault: boolean }> {
  let madeDefault = false;
  await ctx.rt.config.update((config) => {
    const now = new Date().toISOString();
    config.profiles[name] = { ...profile, createdAt: config.profiles[name]?.createdAt ?? now, updatedAt: now };
    if (!config.defaultProfile || !config.profiles[config.defaultProfile]) {
      config.defaultProfile = name;
      madeDefault = true;
    }
  });
  return { madeDefault };
}

function reportLogin(
  ctx: CommandContext,
  details: { name: string; apiUrl: string; identity: CredentialIdentity; environment: Environment; groups?: string[]; madeDefault: boolean },
) {
  const store = ctx.rt.credentialStore();
  const result = {
    profile: details.name,
    apiUrl: details.apiUrl,
    credentialType: details.identity.credentialType,
    workspaceId: details.identity.workspaceId,
    environment: { id: details.environment.id, slug: details.environment.slug, name: details.environment.name },
    grantedGroups: details.groups ?? null,
    scopes: details.identity.scopes,
    credentialStore: store.name,
    default: details.madeDefault,
  };
  if (ctx.out.json) return ctx.out.result(result);
  ctx.out.line(`Logged in. Profile "${details.name}" → ${details.apiUrl}`);
  ctx.out.line(`  workspace    ${details.identity.workspaceId}`);
  ctx.out.line(`  environment  ${details.environment.slug} (${details.environment.id})`);
  if (details.groups) ctx.out.line(`  consent      ${details.groups.filter((g) => g.startsWith('anlyon:')).join(', ')}`);
  ctx.out.line(`  stored in    ${store.name}${store.secure ? '' : ' (NOT encrypted)'}`);
  if (details.madeDefault) ctx.out.line(`  This is now the default profile.`);
}

async function loginWithApiKey(ctx: CommandContext, name: string, apiUrl: string, previous: Profile | undefined) {
  const key = await readStdinSecret(ctx.rt);
  const client = makeClient(apiUrl, key, ctx.rt);
  const identity = (await client.auth.identity()).data!;
  const environment = (await client.environment.get()).data!;
  assertEnvironment(ctx, environment);

  await withLock(ctx.rt.config.lockPath(`profile-${name}`), async () => {
    await revokePrevious(ctx.rt, name, previous);
    await writeCredential(ctx.rt.credentialStore(), name, { v: 1, kind: 'api_key', origin: apiUrl, apiKey: key });
  });
  const { madeDefault } = await saveProfile(ctx, name, {
    apiUrl,
    authType: 'api_key',
    binding: { workspaceId: identity.workspaceId, environmentId: identity.environmentId, environmentSlug: environment.slug, environmentName: environment.name },
  });
  reportLogin(ctx, { name, apiUrl, identity, environment, madeDefault });
}

function resolveScopes(extra: string | undefined, server: OAuthServer): string[] {
  const requested = [...DEFAULT_LOGIN_SCOPES];
  for (const scope of (extra ?? '').split(/[\s,]+/).filter(Boolean)) if (!requested.includes(scope)) requested.push(scope);
  if (server.scopesSupported.length) {
    const unsupported = requested.filter((scope) => !server.scopesSupported.includes(scope));
    if (unsupported.length) {
      throw usageError(
        `The server does not offer: ${unsupported.join(', ')}.`,
        `Available consent groups: ${server.scopesSupported.filter((s) => s.startsWith('anlyon:')).join(', ')}`,
      );
    }
  }
  return requested;
}

export interface BrowserLoginResult {
  name: string;
  apiUrl: string;
  identity: CredentialIdentity;
  environment: Environment;
  /** The consent groups the person granted. */
  granted: string[];
}

/**
 * The browser login, for `auth login` and for `init`. `scope` adds consent groups to the default
 * ones; `quiet` leaves the report to the caller.
 */
export async function loginWithBrowser(
  ctx: CommandContext,
  name: string,
  apiUrl: string,
  previous: Profile | undefined,
  options: { scope?: string; quiet?: boolean } = {},
): Promise<BrowserLoginResult> {
  const { rt, out } = ctx;
  if (ctx.globals.noInput) {
    throw usageError('Browser login needs interaction, and --no-input was given.', 'For automation set ANLYON_API_KEY, or use --api-key-stdin.');
  }
  const server = await discover(apiUrl, rt.fetch, rt.signal);
  const scopes = resolveScopes(options.scope, server);
  const clientId = await registerClient(server, scopes, rt.fetch, rt.signal);

  const pkce = createPkce();
  const state = createState();
  registerSecret(pkce.verifier);
  const listener = await startLoopback({ state, issuer: server.issuer, issRequired: server.issRequired, signal: rt.signal });
  let tokens;
  try {
    const url = authorizationUrl(server, { clientId, redirectUri: listener.redirectUri, scopes, state, challenge: pkce.challenge });
    const noBrowser = ctx.options['no-browser'] === true || rt.env.ANLYON_NO_BROWSER === '1';
    out.info(noBrowser ? 'Open this URL in a browser to log in:' : 'Opening your browser to log in. If it does not open, visit:');
    out.info(`  ${url}`);
    if (!noBrowser) rt.openBrowser(url);
    out.info('Waiting for the browser (Ctrl-C to cancel)…');
    const { code } = await listener.result;
    tokens = await exchangeCode(
      server.tokenEndpoint,
      { clientId, code, redirectUri: listener.redirectUri, verifier: pkce.verifier, resource: server.resource },
      rt.fetch,
      rt.signal,
    );
  } finally {
    listener.close();
  }

  const granted = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : scopes;
  if (!tokens.refreshToken) out.warn('The server issued no refresh token. You will need to log in again when this session expires.');

  const client = makeClient(apiUrl, tokens.accessToken, rt);
  let identity: CredentialIdentity;
  let environment: Environment;
  try {
    identity = (await client.auth.identity()).data!;
    environment = (await client.environment.get()).data!;
    assertEnvironment(ctx, environment);
  } catch (error) {
    if (server.revocationEndpoint && tokens.refreshToken) {
      await revokeToken(server.revocationEndpoint, { clientId, token: tokens.refreshToken, hint: 'refresh_token' }, rt.fetch).catch(() => false);
    }
    throw error;
  }

  await withLock(rt.config.lockPath(`profile-${name}`), async () => {
    await revokePrevious(rt, name, previous);
    await writeCredential(rt.credentialStore(), name, {
      v: 1,
      kind: 'oauth',
      origin: apiUrl,
      clientId,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt,
    });
  });
  const { madeDefault } = await saveProfile(ctx, name, {
    apiUrl,
    authType: 'oauth',
    oauth: {
      issuer: server.issuer,
      resource: server.resource,
      clientId,
      tokenEndpoint: server.tokenEndpoint,
      revocationEndpoint: server.revocationEndpoint,
      userinfoEndpoint: server.userinfoEndpoint,
      scopes: granted,
    },
    binding: { workspaceId: identity.workspaceId, environmentId: identity.environmentId, environmentSlug: environment.slug, environmentName: environment.name },
  });
  if (!options.quiet) reportLogin(ctx, { name, apiUrl, identity, environment, groups: granted, madeDefault });
  return { name, apiUrl, identity, environment, granted };
}

const login: CommandSpec = {
  path: ['auth', 'login'],
  summary: 'Log in with your Anlyon account in the browser (OAuth + PKCE), or store an API key.',
  defaultTimeoutMs: LOGIN_TIMEOUT_MS,
  options: {
    'api-url': { type: 'string', description: `API origin to log in to (default ${DEFAULT_API_URL}).` },
    scope: { type: 'string', description: 'Extra consent groups to request, comma-separated (e.g. anlyon:approvals.decide).' },
    'no-browser': { type: 'boolean', description: 'Print the login URL instead of opening a browser.' },
    'api-key-stdin': { type: 'boolean', description: 'Store an API key read from stdin instead of logging in with the browser.' },
  },
  async run(ctx) {
    if (ctx.args.length) throw usageError('auth login takes no arguments.');
    const config = await ctx.rt.config.read();
    const name = loginProfileName(ctx, config.defaultProfile);
    const previous = config.profiles[name];
    const flagUrl = typeof ctx.options['api-url'] === 'string' ? ctx.options['api-url'] : undefined;
    const apiUrl = normaliseApiUrl(flagUrl ?? previous?.apiUrl ?? envApiUrl(ctx.rt.env) ?? DEFAULT_API_URL);
    if (ctx.rt.env.ANLYON_API_KEY) ctx.out.warn('ANLYON_API_KEY is set. Other commands will use it instead of this profile until it is unset.');
    await ctx.rt.credentialStore().get(accountFor(name));
    if (ctx.options['api-key-stdin'] === true) {
      if (ctx.options.scope) throw usageError('--scope applies to browser login. An API key carries the scopes it was created with.');
      return loginWithApiKey(ctx, name, apiUrl, previous);
    }
    await loginWithBrowser(ctx, name, apiUrl, previous, { scope: typeof ctx.options.scope === 'string' ? ctx.options.scope : undefined });
  },
};

const status: CommandSpec = {
  path: ['auth', 'status'],
  summary: 'Show which profile, API and credential commands will use, and whether it works.',
  options: { offline: { type: 'boolean', description: 'Do not contact the server.' } },
  async run(ctx) {
    const target = await resolveTarget(ctx.globals, ctx.rt);
    const report: Record<string, unknown> = {
      profile: target.profileName ?? null,
      profileSource: target.profileSource,
      apiUrl: target.apiUrl,
      authType: target.authType,
      credentialSource: target.credentialSource,
    };
    let loggedIn = target.credentialSource === 'env:ANLYON_API_KEY';
    if (target.credentialSource === 'profile') {
      const store = ctx.rt.credentialStore();
      report.credentialStore = { backend: store.name, encrypted: store.secure };
      const stored = target.profile ? await readCredential(store, target.profileName!, target.apiUrl) : null;
      loggedIn = Boolean(stored && (stored.apiKey || stored.refreshToken || stored.accessToken));
      report.stored = loggedIn;
      if (stored?.kind === 'oauth') {
        report.hasRefreshToken = Boolean(stored.refreshToken);
        report.accessTokenExpiresAt = stored.accessTokenExpiresAt ? new Date(stored.accessTokenExpiresAt).toISOString() : null;
      }
      report.binding = target.profile?.binding ?? null;
    }

    let exitCode: number = loggedIn ? EXIT.OK : EXIT.AUTH_REQUIRED;
    if (loggedIn && ctx.options.offline !== true) {
      try {
        const connection = await connect(ctx.globals, ctx.rt);
        report.live = {
          ok: true,
          credentialType: connection.identity.credentialType,
          workspaceId: connection.identity.workspaceId,
          environment: { id: connection.environment.id, slug: connection.environment.slug },
          expiresAt: connection.identity.expiresAt,
        };
      } catch (error) {
        const failure = toCliError(error, ctx.rt.abortState);
        report.live = { ok: false, error: failure.toJSON() };
        exitCode = failure.exitCode;
      }
    }

    if (ctx.out.json) {
      ctx.out.result(report);
    } else {
      const live = report.live as { ok: boolean; error?: { message: string } } | undefined;
      ctx.out.fields([
        ['profile', target.profileName ? `${target.profileName} (from ${target.profileSource})` : '(none: ANLYON_API_KEY)'],
        ['api', target.apiUrl],
        ['auth', target.authType],
        ['credential', target.credentialSource === 'profile' ? (loggedIn ? 'stored' : 'not logged in') : 'ANLYON_API_KEY'],
        ...(report.credentialStore
          ? [['store', `${(report.credentialStore as { backend: string }).backend}${(report.credentialStore as { encrypted: boolean }).encrypted ? '' : ' (NOT encrypted)'}`] as [string, unknown]]
          : []),
        ...(target.profile?.binding
          ? [['bound to', `workspace ${target.profile.binding.workspaceId}, environment ${target.profile.binding.environmentSlug ?? target.profile.binding.environmentId}`] as [string, unknown]]
          : []),
        ['server check', live ? (live.ok ? 'ok' : `failed: ${live.error?.message}`) : 'skipped'],
      ]);
      if (!loggedIn) ctx.out.info('Not logged in. Run `anlyon auth login`.');
    }
    return exitCode;
  },
};

const logout: CommandSpec = {
  path: ['auth', 'logout'],
  summary: "Revoke this profile's refresh token and delete its stored credential.",
  options: { forget: { type: 'boolean', description: 'Also remove the profile from the config file.' } },
  async run(ctx) {
    if (ctx.args.length) throw usageError('auth logout takes no arguments.');
    const target = await resolveTarget(ctx.globals, ctx.rt, { requireProfile: true });
    const name = target.profileName!;
    const profile = target.profile;
    let revoked: boolean | null = null;
    let deleted = false;
    await withLock(ctx.rt.config.lockPath(`profile-${name}`), async () => {
      const store = ctx.rt.credentialStore();
      const stored = profile ? await readCredential(store, name, profile.apiUrl) : null;
      if (stored?.refreshToken && profile?.oauth?.revocationEndpoint) {
        revoked = await revokeToken(
          profile.oauth.revocationEndpoint,
          { clientId: profile.oauth.clientId, token: stored.refreshToken, hint: 'refresh_token' },
          ctx.rt.fetch,
          ctx.rt.signal,
        ).catch(() => false);
      }
      deleted = await deleteCredential(store, name);
    });
    if (ctx.options.forget === true) {
      await ctx.rt.config.update((config) => {
        delete config.profiles[name];
        if (config.defaultProfile === name) delete config.defaultProfile;
      });
    }
    if (ctx.out.json) {
      ctx.out.result({ profile: name, revoked, deleted, forgotten: ctx.options.forget === true, account: accountFor(name) });
    } else {
      ctx.out.line(deleted ? `Logged out of profile "${name}".` : `Profile "${name}" had no stored credential.`);
      if (revoked === false) ctx.out.info('The server did not confirm revocation. The local credential was deleted anyway.');
      if (revoked === true) ctx.out.info('Refresh token revoked. An access token already issued stays valid until it expires (at most 15 minutes).');
    }
    if (ctx.rt.env.ANLYON_API_KEY) ctx.out.warn('ANLYON_API_KEY is still set in this environment.');
  },
};

const scopes: CommandSpec = {
  path: ['auth', 'scopes'],
  summary: 'Show what the current credential is granted, and which commands it can run.',
  async run(ctx) {
    const { target, identity } = await connect(ctx.globals, ctx.rt);
    const granted = new Set(identity.scopes ?? []);
    const commands = CAPABILITIES.map((capability) => ({
      command: capability.command,
      scope: capability.scope,
      oauthGroup: capability.oauthGroup,
      available: capability.pending ? false : capability.scope === null || identity.scopes === null || granted.has(capability.scope),
      ...(capability.pending ? { pending: capability.pending } : {}),
    }));
    const result = {
      credentialType: identity.credentialType,
      grantedGroups: target.profile?.oauth?.scopes.filter((scope) => scope.startsWith('anlyon:')) ?? null,
      scopes: identity.scopes,
      commands,
    };
    if (ctx.out.json) return ctx.out.result(result);
    if (result.grantedGroups) ctx.out.line(`Consent groups: ${result.grantedGroups.join(', ') || '(none)'}`);
    ctx.out.line(`Scopes: ${identity.scopes === null ? '(session: role-based)' : identity.scopes.join(', ') || '(none)'}`);
    ctx.out.line('');
    ctx.out.table(commands as unknown as Record<string, unknown>[], [
      { header: 'Command', value: (row) => `anlyon ${row.command}` },
      { header: 'Needs', value: (row) => row.scope ?? '-' },
      { header: 'OK', value: (row) => (row.pending ? 'pending' : row.available ? 'yes' : 'no') },
      {
        header: 'How to get it',
        value: (row) => (row.pending ? `server: ${row.pending}` : row.available ? '' : row.oauthGroup ? `login --scope ${row.oauthGroup}` : 'API key only'),
      },
    ]);
  },
};

export const authCommands: CommandSpec[] = [login, status, logout, scopes];
