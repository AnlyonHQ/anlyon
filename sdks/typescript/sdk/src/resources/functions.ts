/**
 * Functions: your code, hosted by Anlyon, calling your actions under the same governance.
 *
 * Publish a JavaScript or Python module and name the actions it may call. A run calls them through
 * `anlyon.invoke` and `anlyon.read`, with no network, environment variables or secrets of its own.
 *
 * - **Plan:** `run(name, { input })` runs the reads for real and records each write without
 *   sending it. A run with writes ends `awaiting_approval`, with one approval in `run.plan.approval`.
 * - **Approve:** the team decides it with `approvals`, or the end user with
 *   `endUsers.approvals.decide` when every write's policy is decided by the end user.
 * - **Apply:** `run(name, { mode: 'apply', planRunId })` carries out the approved plan, once. A
 *   write that differs from the plan ends the run `diverged` before it is sent.
 *
 * A client from `forUser()` runs functions for that end user: every call the run makes carries the
 * end user. Needs the `functions:read`, `functions:write` or `functions:run` scope (a run needs
 * `actions:invoke` as well).
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import { AnlyonError } from '../core/errors';
import { ERROR_CODES } from '../types/errors';
import type { ApiResponse } from '../types/api';

export type FunctionLanguage = 'javascript' | 'python';

/**
 * What a run does with writes (calls to an action that is not a GET). `plan` records them for
 * approval, `apply` carries out an approved plan, `straight_through` sends them under the version's
 * straight-through policy.
 */
export type FunctionRunMode = 'plan' | 'apply' | 'straight_through';

export type FunctionRunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'budget_exceeded'
  | 'planned'
  | 'awaiting_approval'
  | 'diverged';

/** A per-run budget. When one runs out the run ends `budget_exceeded`. */
export type FunctionBudgetName = 'maxActionCalls' | 'maxCpuMs' | 'maxSubrequests' | 'timeoutMs';

/** Per-run budgets. A budget left out takes the API's default. */
export interface FunctionBudgets {
  /** Action calls dispatched in one run. */
  maxActionCalls?: number;
  /** CPU time in one run. */
  maxCpuMs?: number;
  /** Calls through the `anlyon` binding in one run, refused ones included. */
  maxSubrequests?: number;
  /** Wall time of one run. */
  timeoutMs?: number;
}

/** Writes a straight-through run may make without a plan. Every write is still governed and receipted. */
export interface FunctionStraightThroughPolicy {
  /** Allowed actions a straight-through run may write to. Each must be in `allowedActions`. */
  actions: string[];
  /** Writes in one straight-through run. */
  maxWrites: number;
}

/** One published version of a function. A version never changes. */
export interface FunctionVersion {
  /** The version id (fnv_xxx). */
  id: string;
  version: number;
  language: FunctionLanguage;
  /** SHA-256 of the source. */
  digest: string;
  allowedActions: string[];
  inputSchema: Record<string, unknown>;
  budgets: Required<FunctionBudgets>;
  /** Null: a straight-through run reads and does not write. */
  straightThrough: FunctionStraightThroughPolicy | null;
  /** What the source calls and uses, and the AI review. Advice: nothing here allows a call. */
  review: FunctionVersionReview | null;
  createdAt: string;
}

/** What publishing read from a version's source. */
export interface FunctionSourceFindings {
  language: FunctionLanguage;
  parsed: boolean;
  parseError: string | null;
  calls: Array<{ kind: 'invoke' | 'read'; action: string; line: number }>;
  /** The allow-list the source's literal calls propose. */
  proposedAllowedActions: string[];
  computedActionNames: Array<{ kind: 'invoke' | 'read'; line: number }>;
  risky: Array<{ api: string; category: 'network' | 'file' | 'process' | 'environment' | 'eval'; line: number }>;
  writesInLoop: Array<{ action: string | null; line: number }>;
}

/** A version's source findings and, for a workspace with Anlyon Vigil on, its AI review. */
export interface FunctionVersionReview {
  ast: FunctionSourceFindings;
  ai: {
    status: 'reviewed' | 'skipped' | 'failed';
    reason: string | null;
    model: string | null;
    summary: string | null;
    purpose: 'refunds' | 'payments' | 'messages' | 'records' | 'accounts' | 'lookups' | 'other' | null;
    riskyPatterns: Array<{ pattern: string; description: string; probability: number }>;
    suggestedRiskTier: 'routine' | 'low' | 'moderate' | 'high' | 'critical' | null;
    confidence: number | null;
    truncated: boolean;
    reviewedAt: string;
  } | null;
}

/** A named function in the key's environment. The source is never returned. */
export interface HostedFunction {
  /** The function id (fn_xxx). */
  id: string;
  name: string;
  description: string | null;
  environmentId: string;
  /** Null until a version is published. */
  currentVersion: FunctionVersion | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFunctionRequest {
  /** `A-Z a-z 0-9 _ -`, up to 100 characters. */
  name: string;
  description?: string;
}

export interface PublishFunctionVersionRequest {
  language: FunctionLanguage;
  /**
   * One module. JavaScript: an ES module whose default export is `async function run(input, anlyon)`.
   * Python: a module that defines `run(input, anlyon)`.
   */
  source: string;
  /**
   * Action names the function may call. Each must exist in this environment and be enabled. Left
   * out, the list is read from the source's literal `invoke` and `read` calls; a source that
   * computes an action name needs it listed.
   */
  allowedActions?: string[];
  /** A JSON Schema the run's input must match. */
  inputSchema?: Record<string, unknown>;
  budgets?: FunctionBudgets;
  /** When a run may skip the plan. Left out or null, a straight-through run reads and does not write. */
  straightThrough?: FunctionStraightThroughPolicy | null;
}

/** A version in a function's history. `current` marks the one runs use. */
export interface FunctionVersionListItem extends FunctionVersion {
  current: boolean;
}

/** A version with the source it runs. */
export interface FunctionVersionDetail extends FunctionVersionListItem {
  source: string;
}

/** A run in a function's history, without its calls. Read one with `functions.runs.get(id)`. */
export interface FunctionRunListItem {
  id: string;
  functionVersionId: string;
  version: number;
  mode: FunctionRunMode;
  status: FunctionRunStatus;
  endUserId: string | null;
  actionCalls: number;
  budget: FunctionBudgetName | null;
  error: { code: string; message: string } | null;
  /** A plan run's approval, or the approval an apply run carries out. */
  approvalId: string | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ListFunctionRunsOptions {
  /** 1 to 100. Defaults to 50. */
  limit?: number;
  /** Only this end user's runs. A key created with `endUserRequired` sees only its own. */
  endUserId?: string;
}

export interface FunctionVersionPublished {
  function: HostedFunction;
  version: FunctionVersion;
}

export interface RunFunctionRequest {
  /** Passed to `run(input, anlyon)`. Checked against the version's input schema. */
  input?: Record<string, unknown>;
  /** Defaults to `plan`. */
  mode?: FunctionRunMode;
  /** The approved plan run to carry out. Required with `apply`, refused with any other mode. */
  planRunId?: string;
}

export type FunctionCallKind = 'read' | 'write';

/** `intent` is a write a plan run recorded and did not send. */
export type FunctionCallState = 'intent' | 'dispatched' | 'refused' | 'failed';

/** One call a run made, in order. */
export interface FunctionRunCall {
  sequence: number;
  action: string;
  /** From the action's method. A GET reads. */
  kind: FunctionCallKind;
  state: FunctionCallState;
  /** The invocation the call became, with its own receipt. */
  invocationId: string | null;
  /** Why the call was refused, e.g. `ACTION_NOT_ALLOWED`, or `RUN_DIVERGED` for an apply run's write that did not match its plan. */
  refusal: string | null;
  /** An apply run's write: the plan run's call it matched. */
  plannedSequence: number | null;
  createdAt: string;
}

/** The writes a plan run recorded, and the approval they need. */
export interface FunctionRunPlan {
  /** Covers the version, the input, the end user and every write in order. The approval is bound to it. */
  digest: string;
  writes: Array<{ sequence: number; action: string; input: unknown }>;
  /** Null when the plan has no writes. It needs no approval. */
  approval: {
    /** An approval of kind `function_plan` (apr_xxx). */
    id: string;
    status: 'pending' | 'approved' | 'denied' | 'expired';
    /** `end_user` when every write's policy is decided by the end user. */
    decider: 'team' | 'end_user';
  } | null;
  /** The apply run that carried out the plan. A plan is applied once. */
  appliedByRunId: string | null;
}

/** The payload of an approval of kind `function_plan`. */
export interface FunctionPlanApprovalPayload {
  functionName: string;
  functionVersionId: string;
  planRunId: string;
  planDigest: string;
  inputDigest: string;
  writes: Array<{ sequence: number; action: string; input: unknown }>;
  endUserId?: string;
}

export interface FunctionRunReceipt {
  functionId: string;
  functionVersionId: string;
  digest: string;
  inputDigest: string;
  mode: FunctionRunMode;
  /** A plan run's plan, or the approved plan an apply run carried out. */
  planDigest: string | null;
  approvalId: string | null;
  /** For an apply run, the plan run it carried out. */
  planRunId: string | null;
  calls: Array<Omit<FunctionRunCall, 'createdAt'>>;
  outcome: Exclude<FunctionRunStatus, 'running'>;
  budget: FunctionBudgetName | null;
  finishedAt: string;
}

/** One run of a function: its input and output, every call it made and its receipt. */
export interface FunctionRun {
  /** The run id (frn_xxx). */
  id: string;
  functionId: string;
  functionName: string;
  functionVersionId: string;
  mode: FunctionRunMode;
  status: FunctionRunStatus;
  /** The end user the run acted for. Every call carried it. */
  endUserId: string | null;
  input: Record<string, unknown>;
  inputDigest: string;
  /** What `run` returned, when the run succeeded. */
  output: unknown;
  error: { code: string; message: string } | null;
  /** Lines from `anlyon.log`. */
  logs: string[];
  /** The budget that ended the run. */
  budget: FunctionBudgetName | null;
  actionCalls: number;
  calls: FunctionRunCall[];
  /** A plan run's plan, once it has ended with one. */
  plan: FunctionRunPlan | null;
  /** An apply run's plan run. */
  planRunId: string | null;
  /** An apply run's approved plan digest. */
  planDigest: string | null;
  /** An apply run's plan approval. */
  approvalId: string | null;
  receipt: FunctionRunReceipt | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
}

function required(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AnlyonError({ code: ERROR_CODES.VALIDATION_ERROR, message: `${what} is required.` });
  }
  return value;
}

/** Function runs, read by id. */
export class FunctionRunsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/function-runs');
  }

  /**
   * One run with every call it made, refused ones included, and its receipt. A plan run carries
   * its plan and the plan's approval.
   *
   * @example
   * ```typescript
   * const { data: run } = await anlyon.functions.runs.get('frn_123');
   * console.log(run!.status, run!.plan?.approval?.status);
   * ```
   */
  async get(runId: string): Promise<ApiResponse<FunctionRun>> {
    return this._get<FunctionRun>(`/${encodeURIComponent(required(runId, 'runId'))}`);
  }
}

export class FunctionsResource extends BaseResource {
  private _runs?: FunctionRunsResource;

  constructor(http: HttpClient) {
    super(http, '/api/v2/functions');
  }

  /** Function runs, read by id. */
  get runs(): FunctionRunsResource {
    return (this._runs ??= new FunctionRunsResource(this.http));
  }

  /**
   * Create a function. It runs nothing until a version is published.
   *
   * @example
   * ```typescript
   * await anlyon.functions.create({ name: 'refund-with-checks', description: 'Refund a paid order.' });
   * ```
   */
  async create(request: CreateFunctionRequest): Promise<ApiResponse<HostedFunction>> {
    const name = required(request?.name, 'name');
    const body = request.description === undefined ? { name } : { name, description: request.description };
    return this._post<HostedFunction>('', body);
  }

  /** Every function in the key's environment, with its current version. Never the source. */
  async list(): Promise<ApiResponse<HostedFunction[]>> {
    return this._get<HostedFunction[]>('');
  }

  /**
   * Delete a function. It leaves the list and refuses new runs; its versions and runs stay as the
   * record of what it did, and its name is free to use again.
   */
  async delete(name: string): Promise<ApiResponse<{ deleted: boolean; id: string; name: string }>> {
    return this._delete<{ deleted: boolean; id: string; name: string }>(`/${encodeURIComponent(required(name, 'name'))}`);
  }

  /**
   * Publish source code as the function's new current version. Publishing again appends a version.
   * A call to an action not in `allowedActions` is refused.
   *
   * @example
   * ```typescript
   * await anlyon.functions.publish('refund-with-checks', {
   *   language: 'javascript',
   *   source: `export default async function run(input, anlyon) {
   *     const order = await anlyon.read('lookup-order', { order: input.order });
   *     if (order.paid) await anlyon.invoke('refund', { order: input.order });
   *   }`,
   *   allowedActions: ['lookup-order', 'refund'],
   * });
   * ```
   */
  async publish(name: string, request: PublishFunctionVersionRequest): Promise<ApiResponse<FunctionVersionPublished>> {
    const path = `/${encodeURIComponent(required(name, 'name'))}/versions`;
    const { language, source, allowedActions, inputSchema, budgets, straightThrough } = request;
    return this._post<FunctionVersionPublished>(path, {
      language,
      source,
      ...(allowedActions !== undefined ? { allowedActions } : {}),
      ...(inputSchema !== undefined ? { inputSchema } : {}),
      ...(budgets !== undefined ? { budgets } : {}),
      ...(straightThrough !== undefined ? { straightThrough } : {}),
    });
  }

  /** Every published version, newest first, without sources. `current` marks the one runs use. */
  async listVersions(name: string): Promise<ApiResponse<FunctionVersionListItem[]>> {
    return this._get<FunctionVersionListItem[]>(`/${encodeURIComponent(required(name, 'name'))}/versions`);
  }

  /**
   * One version with its source: a version number, or `'current'`.
   *
   * @example
   * ```typescript
   * const { data: current } = await anlyon.functions.getVersion('refund-with-checks', 'current');
   * console.log(current!.version, current!.source);
   * ```
   */
  async getVersion(name: string, version: number | 'current'): Promise<ApiResponse<FunctionVersionDetail>> {
    if (version !== 'current' && !(Number.isInteger(version) && version >= 1)) {
      throw new AnlyonError({ code: ERROR_CODES.VALIDATION_ERROR, message: 'version is a number from 1, or "current".' });
    }
    return this._get<FunctionVersionDetail>(
      `/${encodeURIComponent(required(name, 'name'))}/versions/${encodeURIComponent(String(version))}`,
    );
  }

  /** The function's runs, newest first, without their calls. */
  async listRuns(name: string, options: ListFunctionRunsOptions = {}): Promise<ApiResponse<FunctionRunListItem[]>> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.endUserId !== undefined) params.set('endUserId', options.endUserId);
    const query = params.toString();
    return this._get<FunctionRunListItem[]>(`/${encodeURIComponent(required(name, 'name'))}/runs${query ? `?${query}` : ''}`);
  }

  /**
   * Run the function once and answer when it ends. A plan run with writes ends
   * `awaiting_approval`; once its approval is approved, apply it with `planRunId`.
   *
   * Throws a `VALIDATION_ERROR` before sending when `mode` is `apply` without a `planRunId`, or a
   * `planRunId` comes with another mode.
   *
   * @example
   * ```typescript
   * const { data: plan } = await anlyon.functions.run('refund-with-checks', { input: { order: 'ord_123' } });
   * if (plan!.status === 'awaiting_approval') {
   *   // The team approves plan.plan.approval.id, or the end user with endUsers.approvals.decide.
   *   const { data: applied } = await anlyon.functions.run('refund-with-checks', {
   *     input: { order: 'ord_123' },
   *     mode: 'apply',
   *     planRunId: plan!.id,
   *   });
   * }
   * ```
   */
  async run(name: string, request: RunFunctionRequest = {}): Promise<ApiResponse<FunctionRun>> {
    const path = `/${encodeURIComponent(required(name, 'name'))}/runs`;
    const { input, mode, planRunId } = request;
    if ((mode === 'apply') !== (planRunId !== undefined)) {
      throw new AnlyonError({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: mode === 'apply' ? 'planRunId is required with mode "apply".' : 'planRunId goes with mode "apply" and no other mode.',
      });
    }
    return this._post<FunctionRun>(path, {
      ...(input !== undefined ? { input } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(planRunId !== undefined ? { planRunId: required(planRunId, 'planRunId') } : {}),
    });
  }
}
