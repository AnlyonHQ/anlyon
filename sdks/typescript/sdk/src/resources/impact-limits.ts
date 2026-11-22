/**
 * Impact limits resource  shared business-impact caps for governed effects.
 *
 * A limit caps `money` (one currency, integer minor units), `resource_mutations`, or a unit your
 * workspace declares on an action (for example `emails`) for the whole
 * environment, optionally narrowed to one action or a resource prefix. Every agent, session and
 * key shares it; none of them can reset it. Effects reserve every applicable limit atomically
 * immediately before dispatch, so exhaustion after review blocks dispatch. Separate from
 * `client.budgets`, which caps Anlyon usage.
 *
 * Changing limits needs `impact-limits:write`, which no key receives by default.
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse } from '../types/api';
import type { CreateImpactLimitRequest, ImpactLimit, UpdateImpactLimitRequest } from '../types/effects';

export class ImpactLimitsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/impact-limits');
  }

  /** Limit, consumed, reserved, unknown exposure and available, per limit. */
  async list(params: { includeArchived?: boolean } = {}): Promise<ApiResponse<ImpactLimit[]>> {
    return this._get<ImpactLimit[]>('', params.includeArchived ? { includeArchived: 'true' } : undefined);
  }

  async get(limitId: string): Promise<ApiResponse<ImpactLimit>> {
    return this._get<ImpactLimit>(`/${limitId}`);
  }

  /**
   * @example
   * ```typescript
   * await client.impactLimits.create({ name: 'Daily refunds', dimension: 'money', currency: 'usd', period: 'day', amount: 50_000 });
   * await client.impactLimits.create({ name: 'Daily emails', dimension: 'emails', period: 'day', amount: 500 });
   * ```
   */
  async create(request: CreateImpactLimitRequest): Promise<ApiResponse<ImpactLimit>> {
    return this._post<ImpactLimit>('', request);
  }

  /**
   * Rename or change the amount. Lowering never releases existing exposure.
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async update(limitId: string, request: UpdateImpactLimitRequest): Promise<ApiResponse<ImpactLimit>> {
    return this._patch<ImpactLimit>(`/${limitId}`, request);
  }

  /**
   * Stop applying to new effects. Existing reservations still settle.
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async archive(limitId: string): Promise<ApiResponse<ImpactLimit>> {
    return this._delete<ImpactLimit>(`/${limitId}`);
  }
}
