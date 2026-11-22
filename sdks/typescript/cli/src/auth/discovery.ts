import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import { fetchJson, type FetchFn } from './http';

export interface OAuthServer {
  issuer: string;
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
  scopesSupported: string[];
  /**
   * RFC 9207: the server says every authorization response carries `iss`. When it does, a
   * response without one is refused rather than accepted on the strength of `state` alone.
   */
  issRequired: boolean;
}

const discoveryError = (message: string) =>
  new CliError('OAUTH_DISCOVERY_FAILED', message, EXIT.UNAVAILABLE, {
    hint: 'Check the API URL, or use ANLYON_API_KEY if this server does not offer browser login.',
  });

/**
 * RFC 9728 → RFC 8414 discovery, starting from the API origin.
 *
 * The protected resource is the hosted MCP server today: the authorization
 * server only mints JWTs for that audience (server/src/utils/auth.ts),
 * and /api/v2 accepts the same token.
 *
 * Every endpoint, the issuer and the resource must be on the API's own origin.
 * The CLI sends a refresh token to the token endpoint and an access token to the
 * API; neither may be redirected elsewhere by a metadata document.
 */
export async function discover(apiUrl: string, fetchFn: FetchFn, signal?: AbortSignal): Promise<OAuthServer> {
  const origin = new URL(apiUrl).origin;
  const sameOrigin = (value: unknown, field: string): string => {
    if (typeof value !== 'string') throw discoveryError(`Authorization server metadata has no ${field}.`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw discoveryError(`Authorization server metadata has an invalid ${field}.`);
    }
    if (url.origin !== origin) throw discoveryError(`${field} (${url.origin}) is not on the API origin ${origin}; refusing.`);
    return value;
  };

  const prm = await fetchJson(fetchFn, `${origin}/.well-known/oauth-protected-resource/mcp`, { method: 'GET', signal });
  if (prm.status !== 200) throw discoveryError(`${origin} does not publish OAuth protected-resource metadata (HTTP ${prm.status}).`);
  const resourceDoc = prm.body as { resource?: unknown; authorization_servers?: unknown };
  const resource = sameOrigin(resourceDoc?.resource, 'resource');
  const servers = Array.isArray(resourceDoc?.authorization_servers) ? resourceDoc.authorization_servers : [];
  const issuer = sameOrigin(servers[0], 'authorization server');

  const issuerPath = new URL(issuer).pathname.replace(/\/$/, '');
  const as = await fetchJson(fetchFn, `${origin}/.well-known/oauth-authorization-server${issuerPath}`, { method: 'GET', signal });
  if (as.status !== 200) throw discoveryError(`Authorization server metadata unavailable (HTTP ${as.status}).`);
  const meta = as.body as Record<string, unknown>;
  if (meta?.issuer !== issuer) throw discoveryError('Authorization server metadata names a different issuer. Refusing.');
  const methods = meta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes('S256')) throw discoveryError('Authorization server does not support PKCE S256.');
  if (!meta.registration_endpoint) {
    throw discoveryError('Authorization server does not allow client registration, and the CLI embeds no client.');
  }

  return {
    issuer,
    resource,
    authorizationEndpoint: sameOrigin(meta.authorization_endpoint, 'authorization_endpoint'),
    tokenEndpoint: sameOrigin(meta.token_endpoint, 'token_endpoint'),
    registrationEndpoint: sameOrigin(meta.registration_endpoint, 'registration_endpoint'),
    revocationEndpoint: meta.revocation_endpoint ? sameOrigin(meta.revocation_endpoint, 'revocation_endpoint') : undefined,
    userinfoEndpoint: meta.userinfo_endpoint ? sameOrigin(meta.userinfo_endpoint, 'userinfo_endpoint') : undefined,
    scopesSupported: Array.isArray(meta.scopes_supported) ? meta.scopes_supported.map(String) : [],
    issRequired: meta.authorization_response_iss_parameter_supported === true,
  };
}
