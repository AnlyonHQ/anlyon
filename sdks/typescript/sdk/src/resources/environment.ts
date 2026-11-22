/**
 * The calling key's own environment  including the kill switch.
 *
 * These address *the environment this key is bound to* rather than taking an
 * id. A key belongs to exactly one environment, so a staging key halts staging
 * and cannot reach production: the isolation falls out of the credential, with
 * no extra argument to get wrong.
 *
 * `halt` and `resume` need the `environments:halt` scope, which is not granted
 * by default  stopping the system is an operator act, not agent work. Put an
 * operator key holding it behind your on-call runbook.
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse } from '../types/api';
import type { Environment } from '../types/agent';

export class EnvironmentResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/environment');
  }

  /**
   * Which environment is this key bound to, and is it halted?
   *
   * Needs no special scope  a runbook checks before and after, and a caller
   * can infer it from 409s anyway.
   */
  async get(): Promise<ApiResponse<Environment>> {
    return this._get<Environment>('');
  }

  /**
   * The kill switch. The agent stops acting and nothing leaves the environment:
   * action invocations block and deliveries defer. What you publish
   * still queues and approvals can still be decided, so nothing in flight is
   * lost  `resume` releases it all.
   *
   * @example
   * ```typescript
   * await operatorClient.environment.halt({ reason: 'runaway refund loop' });
   * ```
   */
  async halt(options?: { reason?: string }): Promise<ApiResponse<Environment>> {
    return this._post<Environment>('/halt', options ?? {});
  }

  /**
   * Release the deferred work and let the agent act again.
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async resume(): Promise<ApiResponse<Environment>> {
    return this._post<Environment>('/resume', {});
  }
}
