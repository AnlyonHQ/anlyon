/**
 * The end-user session token, fetched from the developer's own route and kept in memory only.
 * Never in storage, never in a URL.
 */

/** What `getToken` may return: the token, or the JSON `createSessionHandler` answers with. */
export type SessionTokenResult = string | { token: string; expiresAt?: string | number | Date | null };

/** Fetch a new token this long before the current one expires. */
export const REFRESH_MARGIN_MS = 60_000;

export interface TokenSource {
  /** A token that is good for at least the refresh margin. One fetch at a time. */
  get(): Promise<string>;
  /** Drop the current token, after the API refused it. */
  invalidate(token: string): void;
}

/** A token's own expiry, from its claims (`eus_v1.<claims>.<mac>`), or null when unreadable. */
export function tokenExpiry(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function expiryOf(result: Exclude<SessionTokenResult, string>): number | null {
  const { expiresAt } = result;
  if (expiresAt === undefined || expiresAt === null) return tokenExpiry(result.token);
  const time = expiresAt instanceof Date ? expiresAt.getTime() : typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  return Number.isFinite(time) ? time : tokenExpiry(result.token);
}

export function createTokenSource(getToken: () => Promise<SessionTokenResult>, now: () => number = Date.now): TokenSource {
  let current: { token: string; expiresAt: number | null } | null = null;
  let pending: Promise<string> | null = null;

  const fresh = () => current !== null && (current.expiresAt === null || current.expiresAt - REFRESH_MARGIN_MS > now());

  const fetchToken = async (): Promise<string> => {
    const result = await getToken();
    const token = typeof result === 'string' ? result : result?.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('getToken() returned no token. Return the token, or the JSON your session route answers with.');
    }
    current = { token, expiresAt: typeof result === 'string' ? tokenExpiry(token) : expiryOf(result) };
    return token;
  };

  return {
    get() {
      if (fresh()) return Promise.resolve(current!.token);
      pending ??= fetchToken().finally(() => {
        pending = null;
      });
      return pending;
    },
    invalidate(token) {
      if (current?.token === token) current = null;
    },
  };
}
