/**
 * Approval policies: deterministic, environment-scoped rules that decide whether a request needs
 * approval, is auto-approved, or is auto-denied.
 *
 * This is deployment/setup code, run with an OPERATOR credential (`policies:read`,
 * `policies:write`). Those scopes are privileged and never in the default set, so the agent's own
 * runtime key cannot create, alter, disable or delete the policy that governs it. Keep policy
 * configuration in your deploy step and hand the running agent only its restricted key.
 *
 * The environment is the credential's own. There is no environment argument, and a request that
 * tries to name one is rejected.
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse } from '../types/api';
import type {
  ApprovalPolicy,
  CreateApprovalPolicyRequest,
  UpdateApprovalPolicyRequest,
  EvaluateApprovalPoliciesRequest,
  PolicyEvaluation,
  ApprovalPolicyVersion,
  ApprovalPolicyVersionPage,
  ListPolicyVersionsParams,
  PolicyFilePlan,
  PolicyFileTestCase,
  PolicyFileTestResult,
} from '../types/agent';

export class ApprovalPoliciesResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/approval-policies');
  }

  /**
   * Policies in this credential's environment, in evaluation order.
   *
   * Pass `actionName` for the policies that could govern one action: the ones naming it plus the
   * broad ones that also catch it.
   */
  async list(params?: { actionName?: string }): Promise<ApiResponse<ApprovalPolicy[]>> {
    return this._get<ApprovalPolicy[]>('', params as Record<string, unknown> | undefined);
  }

  async get(policyId: string): Promise<ApiResponse<ApprovalPolicy>> {
    return this._get<ApprovalPolicy>(`/${policyId}`);
  }

  /**
   * Immutable retained versions, newest first, including a tombstone after deletion. Page with
   * `before: page.pagination.nextBefore`; the cursor is stable while new versions are added.
   */
  async versions(policyId: string, params: ListPolicyVersionsParams = {}): Promise<ApprovalPolicyVersionPage> {
    return this._get<ApprovalPolicyVersion[]>(`/${policyId}/versions`, params as Record<string, unknown>) as Promise<ApprovalPolicyVersionPage>;
  }

  /**
   * Plan a policy file (YAML or JSON text): what applying it would create, update and delete, any
   * errors, and the digest to apply with. Read-only.
   */
  async planFile(source: string): Promise<ApiResponse<PolicyFilePlan>> {
    return this._post<PolicyFilePlan>('/files/plan', { source });
  }

  /**
   * Apply exactly the plan you reviewed. Refuses with 409 STALE_PLAN if anything changed since.
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async applyFile(
    source: string,
    options: { digest: string; changeNote?: string }
  ): Promise<ApiResponse<PolicyFilePlan & { applied: true }>> {
    return this._post<PolicyFilePlan & { applied: true }>('/files/apply', { source, ...options });
  }

  /**
   * Decide fixture requests against the environment as it would be after applying the file.
   * Writes nothing and dispatches nothing. `cases` is YAML/JSON text or a list.
   */
  async testFile(source: string, cases: string | PolicyFileTestCase[]): Promise<ApiResponse<PolicyFileTestResult>> {
    return this._post<PolicyFileTestResult>('/files/test', { source, cases });
  }

  /** One retained version, for example the one a decision recorded. Readable after deletion. */
  async version(policyId: string, version: number): Promise<ApiResponse<ApprovalPolicyVersion>> {
    return this._get<ApprovalPolicyVersion>(`/${policyId}/versions/${version}`);
  }

  /** Read-only policy matching. Does not authorize, dispatch, or apply the action's approval floor. */
  async evaluate(request: EvaluateApprovalPoliciesRequest): Promise<ApiResponse<PolicyEvaluation>> {
    return this._post<PolicyEvaluation>('/evaluate', request);
  }

  /**
   * Create a policy. Targeting is required: nothing is inferred from the name.
   *
   * @example
   * ```typescript
   * // Deny only refund_order. get_order follows its own rules.
   * await operator.approvalPolicies.create({
   *   name: 'refund_order_denied',
   *   matchKind: 'action',
   *   matchActionName: 'refund_order',
   *   effect: 'auto_deny',
   * });
   * ```
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async create(request: CreateApprovalPolicyRequest): Promise<ApiResponse<ApprovalPolicy>> {
    return this._post<ApprovalPolicy>('', request);
  }

  /**
   * Update a policy. A field you leave out is unchanged; an explicit `null` clears a nullable
   * matcher (`matchActionName`, `matchAgentId`, `matchUserId`, `matchTags`, `minAmount`,
   * `conditions`). Pass `undefined` and it is left out of the request, exactly like omitting it.
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async update(
    policyId: string,
    request: UpdateApprovalPolicyRequest
  ): Promise<ApiResponse<ApprovalPolicy>> {
    return this._patch<ApprovalPolicy>(`/${policyId}`, request);
  }

  /**
   * Turn a policy on. Same as `update(id, { enabled: true })`.
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async enable(policyId: string): Promise<ApiResponse<ApprovalPolicy>> {
    return this.update(policyId, { enabled: true });
  }

  /**
   * Turn a policy off without deleting it. Same as `update(id, { enabled: false })`.
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async disable(policyId: string): Promise<ApiResponse<ApprovalPolicy>> {
    return this.update(policyId, { enabled: false });
  }

  /**
   * Delete a policy. Decisions already recorded on invocations keep their explanation.
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async delete(policyId: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return this._delete<{ deleted: boolean }>(`/${policyId}`);
  }
}
