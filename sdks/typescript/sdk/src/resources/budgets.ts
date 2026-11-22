/**
 * Budgets resource  per-API-key spend control.
 *
 * Postgres reservations cap the three supported admission dimensions and their
 * estimated cost; external provider spend is outside it.
 * 429 BUDGET_EXCEEDED refuses work before admission. 503
 * BUDGET_RECONCILIATION_REQUIRED holds keys with unknown legacy usage. 409
 * BUDGET_EFFECT_ALREADY_RESERVED prevents re-execution if a budgeted request's
 * Idempotency-Key survives durably but its cached result is lost. Inspect the
 * original outcome; retrying with a new key can create duplicate work.
 * Failed or partially successful work keeps its reservation until reconciled.
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse } from '../types/api';
import type { Budget, PutBudgetRequest } from '../types/agent';

export class BudgetsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/budgets');
  }

  /** Every budgeted key with this month's usage and estimated spend. */
  async list(): Promise<ApiResponse<Budget[]>> {
    return this._get<Budget[]>('');
  }

  /** One key's budget. */
  async get(apiKeyId: string): Promise<ApiResponse<Budget>> {
    return this._get<Budget>(`/${apiKeyId}`);
  }

  /**
   * Create or update a key's budget.
   *
   * @example
   * ```typescript
   * await client.budgets.put(agentKeyId, {
   *   monthlyCostCentsCap: 500,           // $5.00 / month
   *   dimensionCaps: { actionInvokes: 1000 },
   *   alertThreshold: 0.8,
   * });
   * ```
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async put(apiKeyId: string, request: PutBudgetRequest): Promise<ApiResponse<Budget>> {
    return this._put<Budget>(`/${apiKeyId}`, request);
  }

  /**
   * Remove the cap  the key becomes unbudgeted.
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async delete(apiKeyId: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return this._delete<{ deleted: boolean }>(`/${apiKeyId}`);
  }
}
