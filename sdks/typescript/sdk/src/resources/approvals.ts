/**
 * Approvals resource  human-in-the-loop gates.
 *
 * An agent can ask its human directly (`request`), and gated actions create
 * approvals automatically. Deciding needs the separate `approvals:decide`
 * scope, and a key may never decide an approval it requested itself.
 */

import { BaseResource } from './base';
import type { IdempotentRequestOptions } from './base';
import type { HttpClient } from '../core/http-client';
import { ApprovalDeniedError, ApprovalPendingError } from '../core/errors';
import type { ApiResponse, PaginatedResponse } from '../types/api';
import type {
  Approval,
  CreateApprovalRequest,
  DecideApprovalRequest,
  DecisionResult,
  GateOptions,
  GetApprovalParams,
  ListApprovalsParams,
  WaitForDecisionOptions,
} from '../types/agent';

/** The server clamps a longer wait to this, so there is no point asking for more. */
const MAX_WAIT_SECONDS = 55;

/** Floor on how fast the loop may go round again  a spin guard, not a poll interval. */
const MIN_HOP_MS = 1000;

export class ApprovalsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/approvals');
  }

  /**
   * Ask a human to decide something.
   *
   * @example
   * ```typescript
   * const { data } = await client.approvals.request({
   *   title: 'Send the contract to Acme?',
   *   description: 'Draft is ready; sending is irreversible.',
   *   payload: { draftId: 'doc_9' },
   * });
   * ```
   */
  async request(
    request: CreateApprovalRequest,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<Approval>> {
    return this._post<Approval>('', request, this._idempotentAlways(options));
  }

  /** The inbox. Pass `status: 'pending'` for what still needs a decision. */
  async list(params?: ListApprovalsParams): Promise<PaginatedResponse<Approval>> {
    return this._getPaginated<Approval>('', params as Record<string, unknown>);
  }

  /**
   * Read one approval by apr_ id.
   *
   * With `waitSeconds` the server holds the request open until the approval is
   * decided (or the wait runs out, in which case it comes back `pending`).
   * Prefer {@link waitForDecision} unless you are driving the loop yourself.
   */
  async get(
    approvalId: string,
    params?: GetApprovalParams
  ): Promise<ApiResponse<Approval>> {
    const waitSeconds = params?.waitSeconds;
    return this._get<Approval>(
      `/${approvalId}`,
      waitSeconds ? { waitSeconds } : undefined,
      waitSeconds ? { timeout: (waitSeconds + 15) * 1000 } : undefined
    );
  }

  /**
   * Wait for a human to decide  one await instead of a polling loop.
   *
   * Long-polls until the approval leaves `pending` or `timeoutMs` elapses.
   * A timeout is not an error: you get the approval back still `pending`, so
   * always branch on `status`.
   *
   * @example
   * ```typescript
   * const { data } = await client.approvals.request({ title: 'Ship the release?' });
   * const decided = await client.approvals.waitForDecision(data!.id);
   *
   * if (decided.status === 'approved') await ship();
   * else if (decided.status === 'pending') console.log('Still waiting  ask again later.');
   * ```
   */
  async waitForDecision(
    approvalId: string,
    options: WaitForDecisionOptions = {}
  ): Promise<Approval> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const { data } = await this.get(approvalId);
        return data!;
      }

      const waitSeconds = Math.max(1, Math.min(MAX_WAIT_SECONDS, Math.ceil(remainingMs / 1000)));
      const startedAt = Date.now();
      const { data } = await this.get(approvalId, { waitSeconds });

      if (data && data.status !== 'pending') return data;
      if (Date.now() >= deadline) return data!;

      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_HOP_MS) {
        await new Promise((r) => setTimeout(r, Math.min(MIN_HOP_MS - elapsed, deadline - Date.now())));
      }
    }
  }

  /**
   * Gate any function on human approval  request, wait, then run.
   *
   * Wraps `fn` so each call first creates an approval (payload defaults to the
   * call's arguments), long-polls for the decision, and only then runs `fn`.
   * Denied or expired throws {@link ApprovalDeniedError}; a wait that elapses
   * while still pending throws {@link ApprovalPendingError} and `fn` does not
   * run (the approval stays decidable  check the inbox).
   *
   * @example
   * ```typescript
   * const refund = client.approvals.gate(
   *   { title: 'Refund a customer?', timeoutMs: 10 * 60_000 },
   *   async (orderId: string, amount: number) => stripe.refunds.create({ ... }),
   * );
   *
   * await refund('ord_42', 129.99); // runs only after a human approves
   * ```
   */
  gate<TArgs extends unknown[], TResult>(
    options: GateOptions | ((...args: TArgs) => GateOptions),
    fn: (...args: TArgs) => TResult | Promise<TResult>,
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs): Promise<TResult> => {
      const opts = typeof options === 'function' ? options(...args) : options;
      const { data } = await this.request({
        title: opts.title,
        description: opts.description,
        payload: opts.payload ?? { args: JSON.parse(JSON.stringify(args)) },
        expiresInSeconds: opts.expiresInSeconds,
        runId: opts.runId,
        parentSpanId: opts.parentSpanId,
      });
      const decided = await this.waitForDecision(data!.id, { timeoutMs: opts.timeoutMs });
      if (decided.status === 'approved') return fn(...args);
      if (decided.status === 'pending') throw new ApprovalPendingError(decided);
      throw new ApprovalDeniedError(decided);
    };
  }

  /**
   * Approve. For a gated action this also runs the parked invocation and
   * returns it alongside the approval.
   */
  async approve(
    approvalId: string,
    request: DecideApprovalRequest = {},
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<DecisionResult>> {
    return this._post<DecisionResult>(`/${approvalId}/approve`, request, this._idempotentAlways(options));
  }

  /** Deny. A gated action's invocation is marked denied and never runs. */
  async deny(
    approvalId: string,
    request: DecideApprovalRequest = {},
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<DecisionResult>> {
    return this._post<DecisionResult>(`/${approvalId}/deny`, request, this._idempotentAlways(options));
  }
}
