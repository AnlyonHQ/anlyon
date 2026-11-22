import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import { sanitizeRemoteText } from '../redact';

export type FetchFn = typeof fetch;

export interface OAuthErrorBody {
  error?: string;
  error_description?: string;
}

/** An OAuth endpoint said no. `oauthError` is the RFC 6749 error code. */
export class OAuthError extends CliError {
  readonly oauthError: string;
  constructor(oauthError: string, description: string | undefined, status: number | undefined) {
    const auth = oauthError === 'invalid_grant' || oauthError === 'invalid_client' || oauthError === 'unauthorized_client';
    super(
      'OAUTH_ERROR',
      `Authorization server: ${sanitizeRemoteText(oauthError)}${description ? ` (${sanitizeRemoteText(description)})` : ''}`,
      auth ? EXIT.AUTH_REQUIRED : status && status >= 500 ? EXIT.UNAVAILABLE : EXIT.ERROR,
      { status, hint: auth ? 'Run `anlyon auth login` again.' : undefined },
    );
    this.oauthError = oauthError;
  }
}

export async function fetchJson(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit & { signal?: AbortSignal },
): Promise<{ status: number; body: unknown; headers: Headers }> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, redirect: 'error', headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new CliError('NETWORK_ERROR', `Could not reach ${new URL(url).origin}: ${(error as Error).message}`, EXIT.UNAVAILABLE);
  }
  const text = await response.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

/** POST application/x-www-form-urlencoded, as RFC 6749 requires for the token endpoint. */
export async function postForm(
  fetchFn: FetchFn,
  url: string,
  form: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) if (value !== undefined) params.set(key, value);
  return fetchJson(fetchFn, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal,
  });
}

export function throwOAuthError(status: number, body: unknown): never {
  const b = (body ?? {}) as OAuthErrorBody;
  throw new OAuthError(typeof b.error === 'string' ? b.error : `http_${status}`, b.error_description, status);
}
