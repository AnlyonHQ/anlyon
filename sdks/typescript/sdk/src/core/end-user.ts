/**
 * The end user a call acts for.
 *
 * The developer's server states the end user, and the model never does. A client built with
 * `anlyon.forUser(endUserId)` sends `Anlyon-End-User` on every request, and nothing else in the SDK
 * can set or change that header.
 */

import { AnlyonError } from './errors';
import { ERROR_CODES } from '../types/errors';

/** The header that names the end user a call acts for. */
export const END_USER_HEADER = 'Anlyon-End-User';

/**
 * What an end-user id may be: 1 to 128 characters from `A-Z a-z 0-9 . _ : @ -`. Your own user id
 * usually fits as it is. Anlyon stores it as given.
 */
export const END_USER_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

/** True when `value` is a well-formed end-user id. */
export function isValidEndUserId(value: unknown): value is string {
  return typeof value === 'string' && END_USER_ID_PATTERN.test(value);
}

/** Throw a `VALIDATION_ERROR` unless `value` is a well-formed end-user id. Sends nothing. */
export function assertEndUserId(value: unknown): asserts value is string {
  if (isValidEndUserId(value)) return;
  throw new AnlyonError({
    code: ERROR_CODES.VALIDATION_ERROR,
    message:
      'An end-user id is 1 to 128 characters from A-Z, a-z, 0-9 and . _ : @ -' +
      (typeof value === 'string' ? ` (got ${value.length} characters).` : ` (got ${typeof value}).`),
  });
}

/** True when a header bag already names an end user, under any capitalisation. */
export function namesEndUser(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  const wanted = END_USER_HEADER.toLowerCase();
  return Object.keys(headers).some((name) => name.toLowerCase() === wanted);
}

/** How a connect flow ended, as the redirect back to your app reports it. */
export type ConnectRedirectStatus = 'pending_confirmation' | 'connected' | 'declined' | 'error';

/** What {@link parseConnectRedirect} reads from the redirect back to your app. */
export interface ConnectRedirect {
  /**
   * `pending_confirmation`: the end user consented. Call `endUsers.confirmConnection()` with
   * `flowId` to finish. `declined` and `error`: nothing was connected.
   */
  status: ConnectRedirectStatus;
  /** The flow to confirm. Present with `pending_confirmation`. */
  flowId: string | null;
  /** The integration the flow was for. */
  integration: string | null;
}

const REDIRECT_STATUSES: readonly string[] = ['pending_confirmation', 'connected', 'declined', 'error'];

/**
 * Read the result of a connect flow from the URL Anlyon redirected the end user to: your
 * `redirectUrl` with `anlyon_status`, `anlyon_flow` and `integration` added. Returns null when the
 * URL carries no recognisable result.
 *
 * It deliberately does not return the end user named in the URL. Anyone can edit a URL: confirm
 * with the end user from your own session.
 *
 * @example
 * ```typescript
 * // app/connections/callback/route.ts
 * export async function GET(request: Request) {
 *   const user = await requireSession();
 *   const result = parseConnectRedirect(request.url);
 *   if (result?.status === 'pending_confirmation' && result.flowId) {
 *     await anlyon.endUsers.confirmConnection(user.id, result.flowId);
 *   }
 *   return Response.redirect(new URL('/settings/connections', request.url));
 * }
 * ```
 */
export function parseConnectRedirect(url: string | URL | URLSearchParams): ConnectRedirect | null {
  let params: URLSearchParams;
  if (url instanceof URLSearchParams) {
    params = url;
  } else {
    try {
      params = new URL(String(url), 'http://localhost').searchParams;
    } catch {
      return null;
    }
  }
  const status = params.get('anlyon_status');
  if (!status || !REDIRECT_STATUSES.includes(status)) return null;
  return {
    status: status as ConnectRedirectStatus,
    flowId: params.get('anlyon_flow') || null,
    integration: params.get('integration') || null,
  };
}
