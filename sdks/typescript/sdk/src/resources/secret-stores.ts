/**
 * Secret stores resource (Enterprise): your own AWS Secrets Manager or HashiCorp Vault.
 *
 * A secret created with `secrets.putExternal` points into one of these and is read at dispatch;
 * Anlyon does not store its value. A store's credential is write-only: no method returns it.
 *
 * Scopes: `secret-stores:read` to list and get, `secret-stores:write` for everything else. Both are
 * privileged: no key receives them by default.
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse } from '../types/api';
import type { CreateSecretStoreRequest, SecretStore, UpdateSecretStoreRequest } from '../types/agent';

export class SecretStoresResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/secret-stores');
  }

  /** The environment's stores, with their settings and health. Never a credential. */
  async list(): Promise<ApiResponse<SecretStore[]>> {
    return this._get<SecretStore[]>('');
  }

  async get(name: string): Promise<ApiResponse<SecretStore>> {
    return this._get<SecretStore>(`/${name}`);
  }

  /**
   * Add a store. Anlyon authenticates to it first, without reading a secret; if that fails nothing
   * is saved and the call rejects with `SECRET_STORE_CHECK_FAILED`.
   *
   * @example
   * ```typescript
   * await client.secretStores.create({
   *   name: 'prod-vault',
   *   type: 'hashicorp_vault',
   *   config: { address: 'https://vault.example.com:8200', auth: 'approle' },
   *   credential: { roleId: process.env.VAULT_ROLE_ID!, secretId: process.env.VAULT_SECRET_ID! },
   *   allowedPaths: ['payments'],
   * });
   * ```
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async create(request: CreateSecretStoreRequest): Promise<ApiResponse<SecretStore>> {
    return this._post<SecretStore>('', request);
  }

  /**
   * Change a store. New settings or a new credential are checked before they apply.
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async update(
    name: string,
    request: UpdateSecretStoreRequest,
    options: { confirmProtected?: boolean } = {}
  ): Promise<ApiResponse<SecretStore>> {
    return this._patch<SecretStore>(`/${name}${options.confirmProtected ? '?confirmProtected=true' : ''}`, request);
  }

  /** Authenticate to the store without reading a secret, and record the answer on its `health`. */
  async check(name: string): Promise<ApiResponse<SecretStore>> {
    return this._post<SecretStore>(`/${name}/check`, {});
  }

  /**
   * Delete a store. Refused (`SECRET_STORE_IN_USE`) while any secret points at it.
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async delete(name: string, options: { confirmProtected?: boolean } = {}): Promise<ApiResponse<{ deleted: boolean }>> {
    return this._delete<{ deleted: boolean }>(`/${name}${options.confirmProtected ? '?confirmProtected=true' : ''}`);
  }
}
