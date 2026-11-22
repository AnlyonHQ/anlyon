/**
 * Governed effects, execution-bound previews and shared impact limits.
 *
 * An action configured with an `adapter` (for example `stripe.refund` or `github.file_update`)
 * turns every invocation into one governed effect: previewed against the provider, bound to its
 * approval, reserved against shared impact limits before dispatch, and reconciled with the
 * provider until its outcome is established by evidence.
 *
 * A template action becomes governed the same way when it carries a declaration: `impact`,
 * `verify`, or `governed: true`. Every effect then returns a receipt `grade`.
 */

import type { ActingFor } from './agent';

export type EffectStage = 'awaiting_approval' | 'ready' | 'dispatching' | 'reconciling' | 'settled' | 'rejected';
/** What happened in the world. `unknown` means evidence cannot yet establish it: never retry blindly. */
export type EffectOutcome = 'not_dispatched' | 'pending' | 'succeeded' | 'failed' | 'unknown';
/** A failure is not proof of zero impact. */
export type PartialEffect = 'none' | 'possible' | 'confirmed';
/** Who established the outcome. `manual` is an operator's resolution, never provider verification. */
export type EffectVerification = 'provider' | 'manual' | 'unverified' | 'not_dispatched';
/**
 * The receipt grade of an effect. The API derives it and returns it on every effect.
 *
 * - `confirmed`: the outcome is `succeeded` and a read-back matched, or an adapter read the provider's own record.
 * - `acknowledged`: the provider answered 2xx and no read-back has matched. An operator's manual `succeeded` grades here too.
 * - `unknown`: no usable response. Anlyon does not send it again. It stays unknown until a read-back or an operator settles it.
 * - `failed`: the provider rejected the request, or the request provably never left Anlyon.
 * - `refused`: Anlyon refused it at dispatch. Causes include an exhausted or unbounded limit.
 * - `denied`: the approval was denied.
 * - `pending`: no receipt yet.
 */
export type EffectGrade = 'confirmed' | 'acknowledged' | 'unknown' | 'failed' | 'refused' | 'denied' | 'pending';

/** `money`, `resource_mutations`, or a workspace-declared unit such as `emails`. A declared unit matches `^[a-z][a-z0-9_]{0,31}$`. */
export type ImpactDimension = 'money' | 'resource_mutations' | (string & {});
export type ImpactBound = 'exact' | 'upper_bound';

/** How much one invocation changes, as declared on a template action. Declaring it makes the action governed. */
export interface ActionImpactDeclaration {
  dimension: ImpactDimension;
  /** The currency for `money`, for example `usd`. The dimension name for everything else. */
  unit: string;
  /**
   * An expression over the input, evaluated before dispatch: an integer, `input.<path>` or
   * `count(input.<path>)`, with one optional `* <integer>`. An amount that reads an input the
   * caller left out gives no quantity, and an applicable limit then refuses the effect.
   */
  amount: string;
  bound: ImpactBound;
}

/** An impact as you write it. `unit` is required for `money` and may be left out otherwise. */
export type ActionImpactDeclarationInput = Omit<ActionImpactDeclaration, 'unit'> & { unit?: string };

/** One JSON path equality check on the read-back body. */
export interface ActionVerifyMatch {
  /**
   * A dotted path such as `data.status`. A numeric segment indexes an array; a `*` segment stands
   * for any item of one (`labels.*.name`).
   */
  path: string;
  /** A literal, or exactly one `{{input.field}}` or `{{response.field}}`. */
  equals: string | number | boolean | null;
  /** True: the check holds only when no value at the path equals `equals` (a removal read back). */
  absent?: boolean;
}

/**
 * A read-back that confirms a write: a `GET` on the action's own host and what it must answer.
 * A match grades the effect `confirmed`. Without one a 2xx grades `acknowledged`.
 */
export interface ActionVerifyDeclaration {
  /** May reference `{{input.field}}`, `{{response.field}}` and `{{secret:NAME}}`. */
  url: string;
  /** The HTTP status the read-back must answer with. */
  status: number;
  /** At most 10 checks. Every one must hold. */
  match: ActionVerifyMatch[];
  /**
   * A GraphQL read-back: POST this fixed, read-only query to `url` instead of a GET. The query has
   * no placeholder and no mutation or subscription; each variable is a literal or exactly one
   * `{{input.field}}` or `{{response.field}}`.
   */
  graphql?: { query: string; variables?: Record<string, string | number | boolean | null> };
}

/** A read-back as you write it. `match` may be left out. */
export type ActionVerifyDeclarationInput = Omit<ActionVerifyDeclaration, 'match'> & { match?: ActionVerifyMatch[] };

/**
 * What `client.actions.declare()` and `client.actions.update()` accept. `null` removes a
 * declaration. A field you leave out keeps what the action declares. `governed: false` removes
 * every declaration.
 */
export interface ActionDeclarationsInput {
  impact?: ActionImpactDeclarationInput | null;
  verify?: ActionVerifyDeclarationInput | null;
  governed?: boolean;
}

export interface ActionAdapter {
  type: 'stripe.refund' | 'github.file_update' | (string & {});
  /** Validated by the adapter, e.g. `{ account: 'acct_123', mode: 'test', currency: 'usd' }`. */
  config: Record<string, unknown>;
  /** Vault secret NAME holding the provider credential. */
  credentialSecret: string;
}

/**
 * Integer minor units for money. A count for every other dimension, in the dimension's own unit.
 * `DeclaredImpactQuantity` covers a workspace-declared unit such as `emails`.
 */
export type ImpactQuantity =
  | { dimension: 'money'; currency: string; amount: number; bound: ImpactBound }
  | { dimension: 'resource_mutations'; amount: number; bound: ImpactBound }
  | DeclaredImpactQuantity;

/** A quantity in a workspace-declared unit. The unit is the dimension name, and there is no currency. */
export interface DeclaredImpactQuantity {
  dimension: string & {};
  currency?: undefined;
  amount: number;
  bound: ImpactBound;
}

export type PreviewBlock =
  | { type: 'fields'; title: string; fields: Array<{ label: string; value: string }> }
  | { type: 'text_diff'; title: string; path: string; before: string; after: string; truncated: boolean }
  | { type: 'impact'; title: string; quantities: ImpactQuantity[] }
  | { type: 'limitations'; title: string; items: Array<{ kind: 'guarantee' | 'freshness' | 'unsupported' | 'irreversible'; text: string }> };

export interface ActionPreview {
  /** Public preview id (prv_xxx). Pass it as `previewId` when invoking. */
  id: string;
  action: { id: string; name: string; versionId: string };
  adapter: { type: string; version: string };
  environment: { id: string; name: string; kind: string };
  target: Record<string, unknown>;
  /** The exact normalized request that will be dispatched. */
  request: Record<string, unknown>;
  impact: ImpactQuantity[];
  blocks: PreviewBlock[];
  preconditions: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  allowances: Array<Record<string, unknown>>;
  evidenceObservedAt: string;
  expiresAt: string;
  expired: boolean;
  requestDigest: string;
  /** What an approval of this preview agrees to. */
  bindingDigest: string;
  supersedes: string | null;
  effectId: string | null;
  createdAt: string;
}

export interface Effect {
  /** Public effect id (eff_xxx). */
  id: string;
  invocationId: string;
  operationKey: string;
  environmentId: string;
  action: { name: string; versionId: string };
  adapter: { type: string; version: string };
  stage: EffectStage;
  outcome: EffectOutcome;
  partialEffect: PartialEffect;
  /** The receipt grade. Present on every effect, including one that has not run. */
  grade: EffectGrade;
  verification: EffectVerification;
  providerReference: string | null;
  target: Record<string, unknown>;
  impact: ImpactQuantity[];
  previewId: string | null;
  approvalId: string | null;
  bindingDigest: string | null;
  dependsOn: Array<{ effectId: string; outcome: string }>;
  compensates: string | null;
  rejectionReason: string | null;
  /** True while the effect still holds impact-limit capacity: pending, unknown or possibly partial. */
  unresolvedExposure: boolean;
  reconciliation: { attempts: number; nextAt: string | null; exhausted: boolean };
  createdAt: string;
  firstDispatchedAt: string | null;
  outcomeAt: string | null;
  updatedAt: string;
}

export interface EffectEvidence {
  id: string;
  source: 'preview' | 'provider_response' | 'provider_lookup' | 'system' | 'operator_note' | 'manual_resolution';
  observedAt: string;
  impliedOutcome: string | null;
  providerIds: Record<string, string>;
  summary: string;
  details: Record<string, unknown>;
  actor: { type: string; id: string | null };
  recordedAt: string;
}

export interface EffectDetail extends Effect {
  request: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  attempts: Array<{ number: number; kind: 'dispatch' | 'replay' | 'reconcile'; status: 'started' | 'completed' | 'abandoned'; observedOutcome: string | null; error: string | null; startedAt: string; finishedAt: string | null }>;
  /** Append-only. Later observations never erase earlier ones. */
  evidence: EffectEvidence[];
  reservations: Array<{ limitId: string; name: string; dimension: ImpactDimension; currency: string | null; period: string; amount: number; state: 'reserved' | 'settled' | 'released'; exposure: string | null; settled: number; released: number; createdAt: string; finishedAt: string | null }>;
  preview: ActionPreview | null;
}

export interface ListEffectsParams {
  action?: string;
  outcome?: EffectOutcome;
  stage?: EffectStage;
  /** Only effects with this receipt grade. */
  grade?: EffectGrade;
  /** Only effects still holding capacity: pending, unknown, or possibly partial. */
  unresolved?: boolean;
  /** Only effects sent for this end user. */
  endUserId?: string;
  /**
   * Only effects sent with the workspace's own accounts (`workspace`), or only those sent for an
   * end user (`end_users`).
   */
  actingFor?: ActingFor;
  limit?: number;
  offset?: number;
}

export interface ResolveEffectInput {
  outcome: 'succeeded' | 'failed';
  partialEffect?: PartialEffect;
  /** Required for a confirmed partial: the quantities that did happen. */
  actualImpact?: ImpactQuantity[];
  /** What you checked and why (10 to 2000 characters). */
  reason: string;
  externalReference?: string | null;
}

export interface CreatePreviewOptions {
  /** 60 to 604800 seconds; default 3600. */
  ttlSeconds?: number;
  /** Resolve the action version this run's agent pins. */
  runId?: string;
}

export interface EffectInvokeOptions {
  /** Stable operation identity. Same key + same request = the existing effect; different request = 409. */
  operationKey?: string;
  /** A reviewed preview this invocation must match exactly. */
  previewId?: string;
  /** Effects that must already hold the stated outcome. Pending and unknown never satisfy one. */
  dependsOn?: Array<{ effect: string; outcome: 'succeeded' | 'failed' }>;
  /** The effect this one compensates. A compensation is its own governed effect. */
  compensates?: string;
}

export interface ImpactLimit {
  /** Public limit id (lim_xxx). */
  id: string;
  name: string;
  dimension: ImpactDimension;
  currency: string | null;
  /** What the amounts count: the currency for money, the dimension name otherwise. */
  unit: string;
  /** `kind: 'end_user'`: each end user has the whole amount to themselves. */
  scope: { environmentId: string; actionName: string | null; resourcePrefix: string | null; kind: ImpactLimitScope };
  period: 'day' | 'month' | 'total';
  limit: number;
  currentPeriod: string;
  consumed: number;
  /** Everything held and unresolved, across periods. Includes unknown exposure. */
  reserved: number;
  /** The part of `reserved` whose outcome is unknown or possibly partial. Not additional. */
  unknownExposure: number;
  available: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Who shares a limit. `environment`: every call in the environment draws from one amount.
 * `end_user`: each end user (the `Anlyon-End-User` a call carries, as from `forUser()`) has the whole
 * amount to themselves.
 */
export type ImpactLimitScope = 'environment' | 'end_user';

export interface CreateImpactLimitRequest {
  name: string;
  /** `money`, `resource_mutations`, or a declared unit such as `emails`. A declared unit caps the actions that declare an impact in it. */
  dimension: ImpactDimension;
  /** Required for money: lowercase ISO code, e.g. 'usd'. Amounts are integer minor units. */
  currency?: string;
  /** Optional. The currency for money, the dimension name otherwise. Refused when it disagrees with `dimension` and `currency`. */
  unit?: string;
  actionName?: string | null;
  /** Prefix-matched against an effect's resource key, e.g. 'github:acme/fixtures@'. */
  resourcePrefix?: string | null;
  period: 'day' | 'month' | 'total';
  amount: number;
  /** Defaults to `environment`. `end_user` gives each end user their own allowance. */
  scope?: ImpactLimitScope;
}

export interface UpdateImpactLimitRequest {
  name?: string;
  amount?: number;
}
