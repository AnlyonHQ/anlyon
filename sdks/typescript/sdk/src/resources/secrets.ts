/**
 * Secrets resource  a write-only vault.
 *
 * There is deliberately no method that reads a secret value: values are only
 * ever decrypted inside action execution, on Anlyon's side. The agent that
 * invokes an action never sees the credential it uses.
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse } from '../types/api';
import type { ExternalSecretWarning, PutExternalSecretRequest, PutSecretRequest, Secret } from '../types/agent';

export class SecretsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/secrets');
  }

  /**
   * Create or rotate a secret. Names are uppercase (^[A-Z0-9_]+$) and are how
   * actions reference them: `{{secret:STRIPE_KEY}}`.
   *
   * @example
   * ```typescript
   * await client.secrets.put('STRIPE_KEY', {
   *   value: process.env.STRIPE_KEY!,
   *   allowedHosts: ['api.stripe.com'],
   *   allowedPlacements: ['header'],
   * });
   * ```
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async put(name: string, request: PutSecretRequest): Promise<ApiResponse<Secret>> {
    return this._put<Secret>(`/${name}`, request);
  }

  /**
   * Enterprise. Create or repoint a secret whose value is read at dispatch from one of the
   * environment's secret stores (see `secretStores`). Anlyon does not store the value. The value
   * is read once and dropped. If the store cannot produce it yet, the secret is still saved with
   * `health.status: 'unreachable'`, the response carries a `warning`, and calls that use it fail
   * before anything is sent until the store can. Needs `secrets:write`.
   *
   * @example
   * ```typescript
   * await client.secrets.putExternal('STRIPE_KEY', {
   *   external: { store: 'prod-vault', path: 'payments/stripe', key: 'apiKey' },
   *   allowedHosts: ['api.stripe.com'],
   *   allowedPlacements: ['header'],
   * });
   * ```
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async putExternal(
    name: string,
    request: PutExternalSecretRequest
  ): Promise<ApiResponse<Secret> & { warning?: ExternalSecretWarning }> {
    return this._put<Secret>(`/${name}`, request);
  }

  /**
   * Enterprise. Whether an external secret can be read from its store now, recorded as its
   * `health`. Never returns the value.
   */
  async check(name: string): Promise<ApiResponse<Secret>> {
    return this._post<Secret>(`/${name}/check`, {});
  }

  /** List secret names + metadata. Never returns values. */
  async list(): Promise<ApiResponse<Secret[]>> {
    return this._get<Secret[]>('');
  }

  /** Metadata for one secret. Never returns the value. */
  async get(name: string): Promise<ApiResponse<Secret>> {
    return this._get<Secret>(`/${name}`);
  }

  /** Delete a secret. Actions referencing it will fail until it is restored. */
  async delete(name: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return this._delete<{ deleted: boolean }>(`/${name}`);
  }
}
