import type { ConfigStore, Profile } from '../config';
import { CliError, LOGIN_HINT } from '../errors';
import { EXIT } from '../exit-codes';
import { withLock } from '../lock';
import type { CredentialStore } from '../credentials/store';
import { deleteCredential, readCredential, writeCredential } from '../credentials/credential';
import { OAuthError, type FetchFn } from './http';
import { refreshTokens } from './oauth';

/** Refresh this long before expiry, so a token cannot expire mid-request. */
export const REFRESH_SKEW_MS = 60_000;

export const notLoggedIn = (profile: string) =>
  new CliError('NOT_LOGGED_IN', `Profile "${profile}" has no stored credential.`, EXIT.AUTH_REQUIRED, { hint: LOGIN_HINT });

/**
 * Hands out a usable access token for an OAuth profile.
 *
 * The fast path reads the cached access token without locking. Refreshing takes
 * the profile's lock, then re-reads the store: if another process refreshed while
 * we waited, its token is used and no second refresh happens. The rotated refresh
 * token is written back before the lock is released. That ordering is what keeps
 * concurrent terminals from presenting an already-rotated refresh token, which
 * the server answers by revoking the whole grant.
 */
export class TokenManager {
  constructor(
    private readonly deps: {
      store: CredentialStore;
      config: ConfigStore;
      fetch: FetchFn;
      signal?: AbortSignal;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private fresh(expiresAt: number | undefined): boolean {
    return typeof expiresAt === 'number' && expiresAt - this.now() > REFRESH_SKEW_MS;
  }

  async accessToken(name: string, profile: Profile, options: { force?: boolean } = {}): Promise<string> {
    const oauth = profile.oauth;
    if (!oauth) throw new CliError('PROFILE_INVALID', `Profile "${name}" is not an OAuth profile.`, EXIT.ERROR);

    const cached = await readCredential(this.deps.store, name, profile.apiUrl);
    if (!cached || cached.kind !== 'oauth') throw notLoggedIn(name);
    if (!options.force && cached.accessToken && this.fresh(cached.accessTokenExpiresAt)) return cached.accessToken;

    return withLock(
      this.deps.config.lockPath(`profile-${name}`),
      async () => {
        const current = await readCredential(this.deps.store, name, profile.apiUrl);
        if (!current || current.kind !== 'oauth') throw notLoggedIn(name);
        const rotatedMeanwhile = current.refreshToken !== cached.refreshToken;
        if (current.accessToken && this.fresh(current.accessTokenExpiresAt) && (!options.force || rotatedMeanwhile)) {
          return current.accessToken;
        }
        if (!current.refreshToken) {
          throw new CliError('SESSION_EXPIRED', `The session for profile "${name}" has expired.`, EXIT.AUTH_REQUIRED, {
            hint: 'Run `anlyon auth login` again.',
          });
        }

        let tokens;
        try {
          tokens = await refreshTokens(
            oauth.tokenEndpoint,
            { clientId: oauth.clientId, refreshToken: current.refreshToken, resource: oauth.resource },
            this.deps.fetch,
            this.deps.signal,
          );
        } catch (error) {
          if (error instanceof OAuthError && (error.oauthError === 'invalid_grant' || error.oauthError === 'invalid_client')) {
            await deleteCredential(this.deps.store, name).catch(() => {});
            throw new CliError('SESSION_EXPIRED', `The session for profile "${name}" is no longer valid.`, EXIT.AUTH_REQUIRED, {
              hint: 'Run `anlyon auth login` again.',
              cause: error,
            });
          }
          throw error;
        }

        await writeCredential(this.deps.store, name, {
          ...current,
          refreshToken: tokens.refreshToken ?? current.refreshToken,
          accessToken: tokens.accessToken,
          accessTokenExpiresAt: tokens.expiresAt,
        });
        return tokens.accessToken;
      },
      { signal: this.deps.signal },
    );
  }
}
