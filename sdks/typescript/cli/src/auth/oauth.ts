import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import { registerSecret } from '../redact';
import { CLI_VERSION } from '../version';
import type { OAuthServer } from './discovery';
import { fetchJson, postForm, throwOAuthError, type FetchFn } from './http';
import { REGISTERED_REDIRECT_URI } from './loopback';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope?: string;
}

/**
 * RFC 7591 dynamic registration as a public native client: no secret exists, so
 * none is embedded or stored (RFC 8252 §8.4). One registration per login per
 * profile, so each profile has its own client and therefore its own server-side
 * workspace binding: logging in on one profile can never retarget another.
 */
export async function registerClient(server: OAuthServer, scopes: string[], fetchFn: FetchFn, signal?: AbortSignal): Promise<string> {
  const response = await fetchJson(fetchFn, server.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Anlyon CLI',
      redirect_uris: [REGISTERED_REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: scopes.join(' '),
      software_id: 'anlyon-cli',
      software_version: CLI_VERSION,
    }),
    signal,
  });
  if (response.status !== 200 && response.status !== 201) throwOAuthError(response.status, response.body);
  const body = response.body as { client_id?: unknown; client_secret?: unknown };
  if (typeof body?.client_id !== 'string') throw new CliError('OAUTH_ERROR', 'Registration returned no client_id.', EXIT.ERROR);
  if (typeof body.client_secret === 'string') registerSecret(body.client_secret);
  return body.client_id;
}

export function authorizationUrl(
  server: OAuthServer,
  params: { clientId: string; redirectUri: string; scopes: string[]; state: string; challenge: string },
): string {
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', server.resource);
  return url.toString();
}

function parseTokenResponse(status: number, body: unknown): TokenSet {
  if (status !== 200) throwOAuthError(status, body);
  const b = body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown; scope?: unknown };
  if (typeof b?.access_token !== 'string') throw new CliError('OAUTH_ERROR', 'Token response carried no access_token.', EXIT.ERROR);
  if (typeof b.token_type === 'string' && b.token_type.toLowerCase() !== 'bearer') {
    throw new CliError('OAUTH_ERROR', `Unsupported token type ${b.token_type}.`, EXIT.ERROR);
  }
  registerSecret(b.access_token);
  if (typeof b.refresh_token === 'string') registerSecret(b.refresh_token);
  const expiresIn = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : 300;
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === 'string' ? b.refresh_token : undefined,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: typeof b.scope === 'string' ? b.scope : undefined,
  };
}

export async function exchangeCode(
  tokenEndpoint: string,
  params: { clientId: string; code: string; redirectUri: string; verifier: string; resource: string },
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<TokenSet> {
  registerSecret(params.code);
  registerSecret(params.verifier);
  const response = await postForm(
    fetchFn,
    tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.verifier,
      resource: params.resource,
    },
    signal,
  );
  return parseTokenResponse(response.status, response.body);
}

export async function refreshTokens(
  tokenEndpoint: string,
  params: { clientId: string; refreshToken: string; resource: string },
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<TokenSet> {
  const response = await postForm(
    fetchFn,
    tokenEndpoint,
    { grant_type: 'refresh_token', refresh_token: params.refreshToken, client_id: params.clientId, resource: params.resource },
    signal,
  );
  return parseTokenResponse(response.status, response.body);
}

/** RFC 7009. Returns whether the server confirmed; the caller deletes the local copy regardless. */
export async function revokeToken(
  revocationEndpoint: string,
  params: { clientId: string; token: string; hint: 'refresh_token' | 'access_token' },
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<boolean> {
  const response = await postForm(
    fetchFn,
    revocationEndpoint,
    { token: params.token, token_type_hint: params.hint, client_id: params.clientId },
    signal,
  );
  return response.status === 200;
}
