/**
 * Actions resource  hosted tools an agent invokes by name.
 *
 * You define the HTTP call once (URL/headers may reference vaulted secrets);
 * the agent just sends `{input}`. Anlyon validates the input, fills in the
 * credentials, and makes the call. Actions marked `requiresApproval` park
 * behind a human decision instead of firing.
 */

import { BaseResource } from './base';
import type { IdempotentRequestOptions } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse, PaginatedResponse } from '../types/api';
import type {
  Action,
  ActionVersion,
  CreateActionRequest,
  CreateAdapterActionRequest,
  ImportActionsOptions,
  ImportActionsResult,
  Invocation,
  InvokeResult,
  ListInvocationsParams,
  UpdateActionRequest,
  ResolveInvocationInput,
} from '../types/agent';
import type {
  ActionDeclarationsInput,
  ActionPreview,
  CreatePreviewOptions,
  Effect,
  EffectDetail,
  EffectInvokeOptions,
  ListEffectsParams,
  ResolveEffectInput,
} from '../types/effects';

export class ActionsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/actions');
  }

  /**
   * Define a hosted tool.
   *
   * @example
   * ```typescript
   * await client.actions.create({
   *   name: 'refund-customer',
   *   method: 'POST',
   *   urlTemplate: 'https://api.stripe.com/v1/refunds',
   *   headers: { Authorization: 'Bearer {{secret:STRIPE_KEY}}', 'Content-Type': 'application/x-www-form-urlencoded' },
   *   inputSchema: {
   *     type: 'object',
   *     properties: { charge: { type: 'string' } },
   *     required: ['charge'],
   *   },
   *   requiresApproval: true,
   * });
   * ```
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async create(
    request: CreateActionRequest | CreateAdapterActionRequest,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<Action>> {
    return this._post<Action>('', request, this._idempotentAlways(options));
  }

  /**
   * Import a whole API at once from its OpenAPI 3.x spec.
   *
   * Operations Anlyon cannot express faithfully are **skipped with a reason**
   * rather than turned into an action that looks right and isn't  always read
   * `skipped`. Constraints that only document a value (`format`, `minimum`, …)
   * are dropped and listed in each action's `warnings`.
   *
   * Every operation that is not a `GET` is imported **governed**: it declares one
   * resource mutation, so its invocations are previewed, counted against impact
   * limits and given a receipt. Money is declared only when you choose it. Where the spec has a `GET`
   * that reads a write back, the action's `proposedVerify` holds a rule you can
   * add after checking it; nothing applies it for you. `governed: false` imports
   * plain template actions.
   *
   * Every operation also carries a `suggestion`: a risk class, whether to require
   * approval, and an impact (money from an amount and a currency, emails per
   * recipient), read from the spec. None is applied unless you name the operation
   * in `operations`, as the second call below does for the ones you accept.
   *
   * @example
   * ```typescript
   * const spec = await fetch('https://api.acme.com/openapi.json').then((r) => r.json());
   *
   * const auth = { headerName: 'Authorization', secretName: 'ACME_KEY', valueTemplate: 'Bearer {{secret}}' };
   * const { data } = await client.actions.importFromOpenApi(spec, {
   *   auth,
   *   dryRun: true, // look before you leap
   * });
   *
   * console.log(data!.created.map((a) => [a.name, a.suggestion.risk]));
   * console.log(data!.skipped); // [{ path, method, reason }]
   *
   * // Accept the suggestions you checked, then import for real.
   * const operations = Object.fromEntries(
   *   data!.created
   *     .filter((a) => a.suggestion.risk !== 'read' && a.suggestion.impact?.unit !== null)
   *     .map((a) => [`${a.method} ${a.path}`, { requiresApproval: a.suggestion.requiresApproval, impact: a.suggestion.impact }])
   * );
   * await client.actions.importFromOpenApi(spec, { auth, operations });
   * ```
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async importFromOpenApi(
    spec: Record<string, unknown>,
    options: ImportActionsOptions = {}
  ): Promise<ApiResponse<ImportActionsResult>> {
    const { idempotencyKey, ...body } = options;
    return this._post<ImportActionsResult>('/import', { spec, ...body }, this._idempotentAlways(options));
  }

  /** What tools does this agent have? */
  async list(): Promise<ApiResponse<Action[]>> {
    return this._get<Action[]>('');
  }

  /** Get one action by name or act_ id. */
  async get(ref: string): Promise<ApiResponse<Action>> {
    return this._get<Action>(`/${ref}`);
  }

  /**
   * One action's immutable versions, oldest first.
   *
   * Editing an action appends a version; nothing updates one. An agent version
   * pins a version id in its `config.actions`, which is what makes rolling an
   * agent back restore the tool definitions it was published with rather than
   * whatever those tools have since been edited to.
   *
   * @example
   * ```typescript
   * const { data } = await client.actions.versions('refund-customer');
   * const pinned = data.find((v) => v.current)!.id;
   * ```
   */
  async versions(ref: string): Promise<ApiResponse<ActionVersion[]>> {
    return this._get<ActionVersion[]>(`/${ref}/versions`);
  }

  /**
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async update(
    ref: string,
    request: UpdateActionRequest,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<Action>> {
    return this._patch<Action>(`/${ref}`, request, this._idempotentAlways(options));
  }

  /**
   * Set or remove what an action declares. This PATCHes the action with these fields alone.
   *
   * `impact` is how much one invocation changes. `verify` is a read-back that confirms the write.
   * Either one makes the action governed. `null` removes a declaration. A field you leave out keeps
   * what is there. `governed: false` removes every declaration. Changing what a governed action
   * already declares needs `actions:govern`.
   *
   * @example
   * ```typescript
   * await client.actions.declare('send-email', {
   *   impact: { dimension: 'emails', amount: 'count(input.to)', bound: 'exact' },
   *   verify: { url: 'https://api.example.com/v1/messages/{{response.id}}', status: 200 },
   * });
   *
   * await client.actions.declare('send-email', { verify: null }); // remove the read-back
   * ```
   *
   * @throws {SignOffRequiredError} When the change loosens a guardrail and this credential is not a person in the console. Nothing was applied; a human approves it at `error.signOffUrl`.
   */
  async declare(
    ref: string,
    declarations: ActionDeclarationsInput,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<Action>> {
    const body: ActionDeclarationsInput = {};
    if (declarations.impact !== undefined) body.impact = declarations.impact;
    if (declarations.verify !== undefined) body.verify = declarations.verify;
    if (declarations.governed !== undefined) body.governed = declarations.governed;
    return this._patch<Action>(`/${ref}`, body, this._idempotentAlways(options));
  }

  async delete(
    ref: string,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<{ deleted: boolean }>> {
    return this._delete<{ deleted: boolean }>(`/${ref}`, this._idempotentAlways(options));
  }

  /**
   * Call the tool. Ungated actions execute inline; gated ones come back with
   * `pendingApproval: true` and an `approvalId` to poll.
   *
   * Every invoke carries an `Idempotency-Key`. Pass `idempotencyKey` to choose it. Without one the
   * SDK generates a key once per call and sends the same key on each transport retry of that call,
   * so a resend is answered from the recorded invocation and is not executed again. Two calls to
   * `invoke` without a key are two invocations.
   *
   * @example
   * ```typescript
   * const { data } = await client.actions.invoke('refund-customer', { charge: 'ch_1' });
   * if (data!.pendingApproval) {
   *   console.log('Waiting on a human:', data!.approvalId);
   * }
   * ```
   */
  async invoke(
    ref: string,
    input: Record<string, unknown> = {},
    options?: IdempotentRequestOptions & EffectInvokeOptions & {
      runId?: string;
      parentSpanId?: string;
      /**
       * A failed invocation of the same action this call deliberately retries. Needs a new
       * `idempotencyKey`. Refused while the original is `unknown` (resolve it first).
       */
      retryOf?: string;
    }
  ): Promise<ApiResponse<InvokeResult>> {
    const { runId, parentSpanId, retryOf, operationKey, previewId, dependsOn, compensates, ...idempotency } = options ?? {};
    return this._post<InvokeResult>(`/${ref}/invoke`, {
      input,
      ...(runId ? { runId } : {}),
      ...(parentSpanId ? { parentSpanId } : {}),
      ...(retryOf ? { retryOf } : {}),
      ...(operationKey ? { operationKey } : {}),
      ...(previewId ? { previewId } : {}),
      ...(dependsOn ? { dependsOn } : {}),
      ...(compensates ? { compensates } : {}),
    }, this._idempotentAlways(idempotency));
  }

  /**
   * Prepare an execution-bound preview: the exact change, its impact against current limits,
   * the provider preconditions observed and when, the expiry, and the adapter's guarantees.
   * Reads the provider; writes nothing. Invoke with `{ previewId }` to execute exactly this.
   *
   * @example
   * ```typescript
   * const { data: preview } = await client.actions.preview('refund', { paymentIntent: 'pi_1', amount: 1250, currency: 'usd' });
   * await client.actions.invoke('refund', preview!.request, { previewId: preview!.id, operationKey: 'order-42-refund' });
   * ```
   */
  async preview(ref: string, input: Record<string, unknown> = {}, options: CreatePreviewOptions = {}): Promise<ApiResponse<ActionPreview>> {
    return this._post<ActionPreview>(`/${ref}/previews`, { input, ...options }, this._idempotentAlways());
  }

  async getPreview(previewId: string): Promise<ApiResponse<ActionPreview>> {
    return this._get<ActionPreview>(`/previews/${previewId}`);
  }

  /** Re-read the provider into a NEW preview. An approval of the old one never carries over. */
  async refreshPreview(previewId: string, options: { ttlSeconds?: number } = {}): Promise<ApiResponse<ActionPreview>> {
    return this._post<ActionPreview>(`/previews/${previewId}/refresh`, options, this._idempotentAlways());
  }

  /** Effects, filterable by action, outcome, stage, grade and unresolved exposure. */
  async effects(params?: ListEffectsParams): Promise<PaginatedResponse<Effect>> {
    const query: Record<string, unknown> = { ...(params ?? {}) };
    if (params?.unresolved !== undefined) query.unresolved = String(params.unresolved);
    return this._getPaginated<Effect>('/effects', query);
  }

  /** One effect with its attempts, append-only evidence, reservations and bound preview. */
  async effect(effectId: string): Promise<ApiResponse<EffectDetail>> {
    return this._get<EffectDetail>(`/effects/${effectId}`);
  }

  /** Ask the provider, read-only, what happened to a pending or unknown effect. Never writes. */
  async reconcileEffect(effectId: string): Promise<ApiResponse<EffectDetail>> {
    return this._post<EffectDetail>(`/effects/${effectId}/reconcile`, undefined, this._idempotentAlways());
  }

  /** Append an investigation note to the evidence. Needs `actions:resolve`. */
  async addEffectNote(effectId: string, note: string): Promise<ApiResponse<EffectDetail>> {
    return this._post<EffectDetail>(`/effects/${effectId}/notes`, { note }, this._idempotentAlways());
  }

  /**
   * Record a reasoned manual resolution. Shown as `verification: 'manual'`, never as provider
   * verification. Needs `actions:resolve`; the requesting key cannot resolve its own effect.
   */
  async resolveEffect(effectId: string, input: ResolveEffectInput): Promise<ApiResponse<EffectDetail>> {
    return this._post<EffectDetail>(`/effects/${effectId}/resolve`, input, this._idempotentAlways());
  }

  /**
   * Repeat a lost write under the same provider identity (a governed write, not a new effect).
   * Only for adapters that declare it, inside the provider's window. Needs `actions:resolve`.
   */
  async replayEffect(effectId: string): Promise<ApiResponse<EffectDetail>> {
    return this._post<EffectDetail>(`/effects/${effectId}/replay`, undefined, this._idempotentAlways());
  }

  /** The invocation log, optionally filtered to one action. */
  async invocations(params?: ListInvocationsParams): Promise<PaginatedResponse<Invocation>> {
    return this._getPaginated<Invocation>('/invocations', params as Record<string, unknown>);
  }

  /**
   * Record what the destination confirms happened to an `unknown` invocation. Sends nothing to
   * the destination. `failed` releases the reserved usage and refunds the budget; `succeeded` is
   * billed. Needs `actions:resolve`; the key that made the call can never resolve it.
   */
  async resolveInvocation(invocationId: string, input: ResolveInvocationInput): Promise<ApiResponse<Invocation>> {
    return this._post<Invocation>(`/invocations/${invocationId}/resolve`, input, this._idempotentAlways());
  }

  /** One invocation by inv_ id  poll this after a gated invoke is approved. */
  async invocation(invocationId: string): Promise<ApiResponse<Invocation>> {
    return this._get<Invocation>(`/invocations/${invocationId}`);
  }

  /** Invocation history for a single action name or act_ id. */
  async invocationsFor(
    ref: string,
    params?: Omit<ListInvocationsParams, 'action'>
  ): Promise<PaginatedResponse<Invocation>> {
    return this._getPaginated<Invocation>(`/${ref}/invocations`, params);
  }
}
