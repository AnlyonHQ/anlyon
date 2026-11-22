import { Client, type CredentialIdentity } from '@anlyonhq/sdk';
import { assertProfileName, DEFAULT_API_URL, normaliseApiUrl, type Profile } from './config';
import { CliError, LOGIN_HINT, usageError } from './errors';
import { EXIT } from './exit-codes';
import type { GlobalFlags } from './args';
import type { Runtime } from './runtime';
import { readCredential } from './credentials/credential';
import { registerSecret } from './redact';
import { TokenManager, notLoggedIn } from './auth/tokens';
import { CLI_VERSION } from './version';

/**
 * Where a command will send its request, resolved before any request is made.
 * Resolution is pure (no network, no secret) so `auth status` and `doctor` can
 * show it even when the credential is missing.
 */
export interface Target {
  /** Undefined only for ANLYON_API_KEY automation, which is not a profile. */
  profileName?: string;
  profile?: Profile;
  /** How the profile was chosen. */
  profileSource: 'flag' | 'env' | 'default' | 'implicit' | 'none';
  credentialSource: 'profile' | 'env:ANLYON_API_KEY';
  apiUrl: string;
  authType: 'oauth' | 'api_key';
}

export function envApiUrl(env: Runtime['env']): string | undefined {
  return env.ANLYON_API_URL || env.ANLYON_BASE_URL || undefined;
}

/**
 * Profile: --profile, then ANLYON_PROFILE, then the configured default, then
 * "default". Each command snapshots this once; nothing later re-reads it, so a
 * `profile use` in another terminal cannot move a command already running.
 *
 * ANLYON_API_KEY is automation mode and bypasses profiles entirely. Combining it
 * with an explicit profile is refused: the two name different credentials and
 * guessing which one was meant is how a command runs against the wrong target.
 */
export async function resolveTarget(globals: GlobalFlags, rt: Runtime, options: { requireProfile?: boolean } = {}): Promise<Target> {
  const envKey = rt.env.ANLYON_API_KEY;
  const explicitProfile = globals.profile ?? rt.env.ANLYON_PROFILE;
  if (envKey && explicitProfile && !options.requireProfile) {
    throw usageError(
      `ANLYON_API_KEY is set, and so is ${globals.profile ? '--profile' : 'ANLYON_PROFILE'}. Use one credential source.`,
      'Unset ANLYON_API_KEY to use the profile, or drop the profile to use the key.',
    );
  }
  if (envKey && !options.requireProfile) {
    registerSecret(envKey);
    return {
      profileSource: 'none',
      credentialSource: 'env:ANLYON_API_KEY',
      apiUrl: normaliseApiUrl(envApiUrl(rt.env) ?? DEFAULT_API_URL),
      authType: 'api_key',
    };
  }

  const config = await rt.config.read();
  const [name, source]: [string, Target['profileSource']] = globals.profile
    ? [globals.profile, 'flag']
    : rt.env.ANLYON_PROFILE
      ? [rt.env.ANLYON_PROFILE, 'env']
      : config.defaultProfile
        ? [config.defaultProfile, 'default']
        : ['default', 'implicit'];
  assertProfileName(name);
  const profile = config.profiles[name];
  if (!profile) {
    return {
      profileName: name,
      profileSource: source,
      credentialSource: 'profile',
      apiUrl: normaliseApiUrl(envApiUrl(rt.env) ?? DEFAULT_API_URL),
      authType: 'oauth',
    };
  }

  const override = envApiUrl(rt.env);
  if (override && normaliseApiUrl(override) !== profile.apiUrl) {
    throw new CliError(
      'API_URL_MISMATCH',
      `ANLYON_API_URL (${normaliseApiUrl(override)}) differs from profile "${name}" (${profile.apiUrl}). The profile's credential is not sent elsewhere.`,
      EXIT.TARGET_MISMATCH,
      { hint: 'Unset ANLYON_API_URL, or log in to a separate profile for that API.' },
    );
  }
  return { profileName: name, profile, profileSource: source, credentialSource: 'profile', apiUrl: profile.apiUrl, authType: profile.authType };
}

/** The bearer credential for a target. Refreshes an OAuth access token when needed. */
export async function resolveBearer(target: Target, rt: Runtime, options: { force?: boolean } = {}): Promise<string> {
  if (target.credentialSource === 'env:ANLYON_API_KEY') return rt.env.ANLYON_API_KEY!;
  const name = target.profileName!;
  if (!target.profile) throw notLoggedIn(name);
  const store = rt.credentialStore();
  if (target.profile.authType === 'api_key') {
    const credential = await readCredential(store, name, target.profile.apiUrl);
    if (!credential?.apiKey) throw notLoggedIn(name);
    return credential.apiKey;
  }
  return new TokenManager({ store, config: rt.config, fetch: rt.fetch, signal: rt.signal }).accessToken(name, target.profile, options);
}

/**
 * An SDK client for exactly one target. The CLI's abort signal is threaded into
 * every request through `fetch`, since the SDK's resource methods take none, and
 * retries stop as soon as the command is cancelled or out of time.
 */
export function makeClient(apiUrl: string, bearer: string, rt: Runtime): Client {
  const fetchWithSignal: typeof fetch = (input, init) =>
    rt.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, rt.signal]) : rt.signal });
  return new Client({
    apiKey: bearer,
    baseUrl: apiUrl,
    timeout: rt.timeoutMs,
    fetch: fetchWithSignal,
    defaultHeaders: { 'User-Agent': `anlyon-cli/${CLI_VERSION}` },
    retry: { maxAttempts: 3, isRetryable: () => !rt.signal.aborted },
  });
}

/** The SDK does not export its Environment type from the package root; derive it. */
export type Environment = NonNullable<Awaited<ReturnType<Client['environment']['get']>>['data']>;

export interface Connection {
  target: Target;
  client: Client;
  identity: CredentialIdentity;
  environment: Environment;
  /** The bearer this connection sends, for the few calls made without the SDK (see api.ts). Never printed. */
  bearer: string;
}

function matchesEnvironment(environment: Environment, wanted: string): boolean {
  return environment.id === wanted || environment.slug?.toLowerCase() === wanted.toLowerCase();
}

/**
 * Resolve profile, origin, credential, workspace and environment, in that order,
 * before the command's own request. Workspace and environment come from the
 * server (the credential's binding), never from a flag:
 *
 *   --environment is an assertion. If the credential is bound elsewhere the
 *   command stops with exit 10; the CLI never sends X-Environment-Id or any
 *   other override.
 *
 *   A profile records the binding it saw at login. If the same credential now
 *   resolves to a different workspace or environment (rebound from the dashboard
 *   or another client), the command stops rather than act on a target the user
 *   did not pick in this profile.
 */
export async function connect(globals: GlobalFlags, rt: Runtime): Promise<Connection> {
  const target = await resolveTarget(globals, rt);
  let bearer = await resolveBearer(target, rt);
  let client = makeClient(target.apiUrl, bearer, rt);

  let identity: CredentialIdentity;
  try {
    identity = (await client.auth.identity()).data!;
  } catch (error) {
    const status = (error as { status?: number; code?: string }).code === 'AUTHENTICATION_FAILED' ? 401 : (error as { status?: number }).status;
    if (status !== 401 || target.authType !== 'oauth' || target.credentialSource !== 'profile') throw error;
    bearer = await resolveBearer(target, rt, { force: true });
    client = makeClient(target.apiUrl, bearer, rt);
    identity = (await client.auth.identity()).data!;
  }
  if (!identity?.workspaceId || !identity.environmentId) {
    throw new CliError('IDENTITY_INVALID', 'The server did not say which workspace and environment this credential acts on.', EXIT.ERROR);
  }
  const environment = (await client.environment.get()).data!;

  const recorded = target.profile?.binding;
  if (recorded && (recorded.workspaceId !== identity.workspaceId || recorded.environmentId !== identity.environmentId)) {
    throw new CliError(
      'BINDING_CHANGED',
      `Profile "${target.profileName}" was set up for workspace ${recorded.workspaceId} / environment ${recorded.environmentSlug ?? recorded.environmentId}, ` +
        `but its credential now resolves to workspace ${identity.workspaceId} / environment ${environment.slug ?? identity.environmentId}.`,
      EXIT.TARGET_MISMATCH,
      { hint: 'Run `anlyon auth login` for this profile to confirm the new target.' },
    );
  }
  if (globals.environment && !matchesEnvironment(environment, globals.environment)) {
    throw new CliError(
      'ENVIRONMENT_MISMATCH',
      `--environment ${globals.environment} does not match this credential, which is bound to ${environment.slug} (${environment.id}). ` +
        'The binding is set server-side and is not overridden.',
      EXIT.TARGET_MISMATCH,
      { hint: 'Use a profile or API key bound to that environment.' },
    );
  }
  return { target, client, identity, environment, bearer };
}

export { LOGIN_HINT };
