/**
 * Authentication: inspect the credential this client is using.
 *
 * Read-only, and only about the caller's own credential. It never returns a secret, a hash, another
 * key or an account detail, and it is not key administration: creating keys stays an operator action
 * in the console.
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse } from '../types/api';
import type { CredentialIdentity } from '../types/agent';
import { AnlyonError, ScopeCheckError } from '../core/errors';

export class AuthResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/auth');
  }

  /**
   * What this credential is, where it is bound, and what it is allowed to do.
   *
   * Check it at startup: fail fast if the key lacks a scope you need, and refuse to run with one you
   * should not hold.
   *
   * @example
   * ```typescript
   * const { data } = await client.auth.identity();
   * const missing = ['actions:invoke'].filter((s) => !data.scopes?.includes(s));
   * const tooBroad = ['policies:write', 'approvals:decide'].filter((s) => data.scopes?.includes(s));
   * if (missing.length || tooBroad.length) throw new Error(`bad key: missing ${missing}, broad ${tooBroad}`);
   * ```
   *
   * Holding a scope is not proof a call will run: policies, budgets, environment halt and quotas still
   * apply when the request is made.
   */
  async identity(): Promise<ApiResponse<CredentialIdentity>> {
    return this._get<CredentialIdentity>('/identity');
  }

  /**
   * Startup check: fail fast unless the credential holds every scope the application needs, and none it must not.
   *
   * This only inspects; it never asks for or grants anything, and it does not change what a key may do. Pass what
   * the application actually uses (least privilege), not whatever would make the check pass. A session credential has
   * no scope list (its authority is the user's workspace role), so it cannot satisfy a scope requirement.
   *
   * @example
   * ```typescript
   * await client.auth.requireScopes(['actions:invoke', 'runs:write'], { forbidden: ['policies:write'] });
   * ```
   *
   * Holding a scope is not proof a call will run: policies, budgets, halt and quotas still apply per request.
   */
  async requireScopes(
    required: readonly string[],
    options: { forbidden?: readonly string[] } = {}
  ): Promise<CredentialIdentity> {
    const { data } = await this.identity();
    if (!data || !Object.prototype.hasOwnProperty.call(data, 'scopes') ||
      (data.scopes !== null && (!Array.isArray(data.scopes) || data.scopes.some((scope) => typeof scope !== 'string')))) {
      throw new AnlyonError({ code: 'UNKNOWN_ERROR', message: 'Credential identity response has no valid scope information.' });
    }
    const held = new Set(data?.scopes ?? []);
    const missing = required.filter((scope) => !held.has(scope));
    const forbidden = (options.forbidden ?? []).filter((scope) => held.has(scope));
    if (missing.length || forbidden.length) throw new ScopeCheckError(missing, forbidden);
    return data;
  }
}
