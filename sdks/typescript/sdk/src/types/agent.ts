/**
 * Agent platform types: Trust (secrets, actions, approvals) and Control (budgets).
 */

import type { ApiResponse, IdempotentRequestOptions } from './api';
import type {
  ActionAdapter,
  ActionDeclarationsInput,
  ActionImpactDeclaration,
  ActionImpactDeclarationInput,
  ActionVerifyDeclaration,
  ActionVerifyDeclarationInput,
  EffectGrade,
} from './effects';

export interface Secret {
  /** Public secret id (sec_xxx). */
  id: string;
  /** Referenced from action templates as {{secret:NAME}}. */
  name: string;
  description: string | null;
  /** Hosts this secret may be sent to. Null only on a secret stored before hosts were required. */
  allowedHosts: string[] | null;
  /** Where in the request this secret may appear. Null means anywhere. */
  allowedPlacements: SecretPlacement[] | null;
  /**
   * `static` holds a value you stored. `connection` is a connected account whose access token is
   * fetched at dispatch. `external` (Enterprise) is read at dispatch from one of the environment's
   * secret stores and is not stored by Anlyon. `put` cannot change a secret's kind.
   */
  kind: 'static' | 'connection' | 'external';
  /** For a connected account: which integration, and whether it still produces a token. */
  connection: SecretConnection | null;
  /**
   * The integration this secret was connected for, by signing in or with an API key. Null for a
   * secret you stored directly. A secret connected with an API key is `static` with this set.
   */
  integrationId: string | null;
  /**
   * Whether the connected account still works, whichever way it was connected. Null for a secret
   * you stored directly, which Anlyon cannot check. See `connections.check` and `connections.reconnect`.
   */
  health: SecretHealth | null;
  /** For an external secret: which store, and where in it. Never a value. Null otherwise. */
  external: SecretExternal | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SecretStoreType = 'aws_secrets_manager' | 'hashicorp_vault';

export interface SecretExternal {
  store: string;
  storeType: SecretStoreType;
  path: string;
  key: string | null;
  version: string | null;
}

export type SecretPlacement = 'url' | 'header' | 'body';

export interface SecretConnection {
  integrationId: string;
  /** The same value as `health.status`. Reconnect the account to use it again. */
  status: 'active' | 'needs_reauth';
}

/**
 * Whether a connected account still works. `needs_reauth` means the provider refused the credential
 * (`key_rejected`), no longer honours the signed-in account's grant (`access_revoked`), or the
 * connector service could not refresh its token (`refresh_failed`); a dispatch that uses it fails
 * before anything is sent. `checkedAt` is when Anlyon last asked the provider.
 */
export interface SecretHealth {
  /** `unreachable`: an external secret its store could not produce at the last check or dispatch. */
  status: 'active' | 'needs_reauth' | 'unreachable';
  checkedAt: string | null;
  reason:
    | 'key_rejected'
    | 'access_revoked'
    | 'refresh_failed'
    | 'store_unreachable'
    | 'store_denied'
    | 'reference_not_found'
    | null;
}

export interface PutSecretRequest {
  value: string;
  description?: string;
  /**
   * Hosts this secret may be sent to. A leading dot matches subdomains
   * (`.stripe.com` admits `api.stripe.com`). Required when a stored value is
   * created: a write that would leave the secret with no hosts is refused.
   * Omitting it on a rotation leaves the existing list alone, so rotating a
   * secret never widens where it may go.
   */
  allowedHosts?: string[] | null;
  /** Where in the request this secret may appear. `null` means anywhere. */
  allowedPlacements?: SecretPlacement[] | null;
}

/**
 * Enterprise. Where an external secret's value lives: a path in one of the environment's secret
 * stores, optionally one key and one version.
 */
export interface ExternalSecretReference {
  /** The store's name. */
  store: string;
  /** AWS: the secret's name or ARN. Vault: its path under the store's KV v2 mount. */
  path: string;
  /** AWS: a key of the secret string read as JSON (omit for the whole string). Vault: required. */
  key?: string | null;
  /** AWS: a version id or a staging label. Vault: a version number. Omit for the current one. */
  version?: string | null;
}

/**
 * The secret was saved, and its store could not produce the value just now. Calls that use it fail
 * before anything is sent until the store can; the secret's `health` carries the same reason.
 */
export interface ExternalSecretWarning {
  code: 'EXTERNAL_SECRET_UNREADABLE';
  reason: 'store_unreachable' | 'store_denied' | 'reference_not_found';
  message: string;
}

/** Enterprise. Create or repoint a secret read from a secret store at dispatch. */
export interface PutExternalSecretRequest {
  external: ExternalSecretReference;
  description?: string;
  allowedHosts?: string[] | null;
  allowedPlacements?: SecretPlacement[] | null;
}

export interface AwsSecretStoreConfig {
  region: string;
  /** `access_key` signs with the stored keys. `assume_role` uses them to assume `roleArn` first. */
  auth: 'access_key' | 'assume_role';
  roleArn?: string | null;
  externalId?: string | null;
}

export interface VaultSecretStoreConfig {
  /** The Vault origin alone, https: `https://vault.example.com:8200`. */
  address: string;
  /** Vault Enterprise namespace. */
  namespace?: string | null;
  /** The KV version 2 mount. Default `secret`. */
  mount?: string;
  auth: 'token' | 'approle';
  /** The AppRole auth mount. Default `approle`. */
  authMount?: string | null;
}

export interface AwsSecretStoreCredential {
  accessKeyId: string;
  secretAccessKey: string;
}

export type VaultSecretStoreCredential = { token: string } | { roleId: string; secretId: string };

/** A secret store's settings and health. Its credential is never returned. */
export interface SecretStore {
  /** Public store id (sst_xxx). */
  id: string;
  name: string;
  type: SecretStoreType;
  description: string | null;
  config: AwsSecretStoreConfig | VaultSecretStoreConfig;
  credentialKind: 'access_key' | 'token' | 'approle';
  /** Path prefixes a secret may point at. Null means any path the credential can read. */
  allowedPaths: string[] | null;
  /** How long a value read from the store is kept in the API process's memory. 0 for none. */
  cacheTtlSeconds: number;
  health: {
    status: 'active' | 'unreachable';
    checkedAt: string;
    reason: 'store_unreachable' | 'store_denied' | 'reference_not_found' | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

interface CreateSecretStoreCommon {
  name: string;
  description?: string;
  allowedPaths?: string[] | null;
  cacheTtlSeconds?: number;
}

export type CreateSecretStoreRequest =
  | (CreateSecretStoreCommon & { type: 'aws_secrets_manager'; config: AwsSecretStoreConfig; credential: AwsSecretStoreCredential })
  | (CreateSecretStoreCommon & { type: 'hashicorp_vault'; config: VaultSecretStoreConfig; credential: VaultSecretStoreCredential });

export interface UpdateSecretStoreRequest {
  description?: string | null;
  /** Fields that replace the stored settings they name. */
  config?: Partial<AwsSecretStoreConfig> | Partial<VaultSecretStoreConfig>;
  /** A whole new credential for the store's type. */
  credential?: AwsSecretStoreCredential | VaultSecretStoreCredential;
  allowedPaths?: string[] | null;
  cacheTtlSeconds?: number;
}

export type ActionMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type InvocationStatus =
  | 'pending_approval'
  | 'running'
  | 'succeeded'
  /** The call did not happen: refused, or it failed before anything was sent. */
  | 'failed'
  /**
   * The request may have reached the destination and Anlyon cannot confirm the
   * outcome: a timeout, or a socket that died after the request was written.
   *
   * Distinct from `failed` because the safe response is different: **do not
   * retry automatically**. Reconcile with the destination first; retrying an
   * ambiguous refund is how one refund becomes two.
   */
  | 'unknown'
  | 'denied'
  | 'expired';

export interface Action {
  /** Public action id (act_xxx). */
  id: string;
  /** The environment this action lives in. */
  environmentId?: string;
  name: string;
  description: string | null;
  method: ActionMethod;
  urlTemplate: string;
  headers: Record<string, unknown>;
  bodyTemplate: Record<string, unknown> | null;
  /** JSON Schema subset: type/properties/required/enum/pattern/items. */
  inputSchema: Record<string, unknown>;
  requiresApproval: boolean;
  enabled: boolean;
  /** Names of the secrets this action references  never their values. */
  secrets: string[];
  /**
   * The immutable version this definition currently is (acv_xxx).
   *
   * An agent version pins a version id, so this is what to pin to hold the
   * action at its present definition. Null only for actions that predate
   * versioning and have not been edited since.
   */
  currentVersionId: string | null;
  /** The governed-effect adapter, or null for a template action. */
  adapter?: ActionAdapter | null;
  /** True when every invocation creates a governed effect: the action has an adapter or carries a declaration. */
  governed?: boolean;
  /** The declared impact, or null when the action declares none. */
  impact?: ActionImpactDeclaration | null;
  /** The declared read-back, or null when the action declares none. */
  verify?: ActionVerifyDeclaration | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * An immutable snapshot of an action's request-shaping definition.
 *
 * Editing an action appends one; nothing ever updates one. Identity and
 * `enabled` are not part of a version  the first belongs to the action, and
 * the second is an operational switch that stops every version at once.
 */
export interface ActionVersion {
  /** Pin this from an agent version's `config.actions`. */
  id: string;
  /** Monotonic per action, starting at 1. */
  version: number;
  method: ActionMethod;
  urlTemplate: string;
  headers: Record<string, unknown>;
  bodyTemplate: Record<string, unknown> | null;
  inputSchema: Record<string, unknown>;
  /**
   * Part of the definition, so rolling back to this version restores its
   * approval requirement too.
   */
  requiresApproval: boolean;
  /** What this version declares. A pin or a rollback restores it with the request. */
  governed?: boolean;
  impact?: ActionImpactDeclaration | null;
  verify?: ActionVerifyDeclaration | null;
  /** Secret names this version references  never their values. */
  secrets: string[];
  /** Whether this is the action's present definition. */
  current: boolean;
  createdAt: string;
}

/** An environment, as seen by a key bound to it. */
export interface Environment {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  isProtected: boolean;
  /** While true, the agent cannot act and nothing leaves this environment. */
  halted: boolean;
  haltedAt: string | null;
  haltedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateActionRequest {
  name: string;
  description?: string;
  method?: ActionMethod;
  /** Supports {{input.field}} and {{secret:NAME}}. */
  urlTemplate: string;
  headers?: Record<string, string>;
  bodyTemplate?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  /** When true, invoking parks the call behind a human approval. */
  requiresApproval?: boolean;
  enabled?: boolean;
  /** How much one invocation changes. Declaring it makes the action governed, and its host must be fixed and https. */
  impact?: ActionImpactDeclarationInput;
  /** A read-back that confirms the write. Declaring it makes the action governed. */
  verify?: ActionVerifyDeclarationInput;
  /** Set true to govern an action that declares neither `impact` nor `verify`. Its 2xx then grades `acknowledged`. */
  governed?: boolean;
}

/** An adapter-backed action: the adapter builds the request, so no URL template is given. */
export interface CreateAdapterActionRequest {
  name: string;
  description?: string;
  adapter: ActionAdapter;
  requiresApproval?: boolean;
  enabled?: boolean;
}

/**
 * On update, `impact: null` or `verify: null` removes that declaration. A field you leave out keeps
 * what the action declares. `governed: false` removes every declaration.
 */
export type UpdateActionRequest = Partial<Omit<CreateActionRequest, 'impact' | 'verify' | 'governed'>> &
  ActionDeclarationsInput & { adapter?: ActionAdapter };

export interface ImportActionsOptions extends IdempotentRequestOptions {
  /** Overrides `servers[0].url` from the spec. */
  baseUrl?: string;
  /** Send a vaulted secret as a header on every imported action. */
  auth?: {
    /** e.g. "Authorization". */
    headerName: string;
    /** Name of an existing secret  the value is never sent here. */
    secretName: string;
    /** e.g. "Bearer {{secret}}"  `{{secret}}` becomes the secret reference. */
    valueTemplate?: string;
  };
  /** Gate every imported action behind a human approval. */
  requiresApproval?: boolean;
  /** Report what would be imported without creating anything. */
  dryRun?: boolean;
  /** Only import these operations (operationId, or "GET /pets"). */
  only?: string[];
  /**
   * Import every operation that is not a GET as a governed action declaring one resource
   * mutation. Defaults to true. `false` imports plain template actions.
   */
  governed?: boolean;
  /**
   * Settings chosen per operation, keyed by operationId or "METHOD /path", usually accepted from a
   * dry run's `suggestion`. An operation not named here gets the defaults. A key that names no
   * operation, or an impact an action would not accept, fails the whole import before anything is
   * created.
   */
  operations?: Record<string, ImportOperationChoice>;
}

/** One operation's settings, chosen by you. A field left out keeps the default. */
export interface ImportOperationChoice {
  /** Overrides the import-wide `requiresApproval` for this operation. */
  requiresApproval?: boolean;
  /** The impact to declare instead of one resource mutation. `null` imports it ungoverned. */
  impact?: ActionImpactDeclarationInput | null;
}

/** How much an imported operation can do, as the import reads it from the spec. */
export type ImportRisk = 'read' | 'write' | 'irreversible' | 'destructive';

/**
 * Suggested from the spec alone (method, path, operation words, request fields, vendor
 * extensions), with no model call. Never applied by itself: pass it back in `operations`.
 */
export interface ImportSuggestion {
  risk: ImportRisk;
  /** The signals in the spec that produced `risk` and `impact`. */
  reasons: string[];
  /** True for an irreversible or destructive operation. */
  requiresApproval: boolean;
  /**
   * An impact in the shape an action declares, or null when the operation changes nothing. `unit`
   * is null for money when the spec does not fix one currency: choose it before accepting.
   */
  impact: { dimension: string; unit: string | null; amount: string; bound: 'exact' | 'upper_bound' } | null;
  /** What to check before accepting `impact`. */
  impactNote: string | null;
}

/** A read-back the spec makes possible for an imported write. Reported, never applied. */
export interface ProposedVerify {
  url: string;
  status: number;
  match: Array<{ path: string; equals: string }>;
}

export interface ImportedAction {
  name: string;
  method: ActionMethod;
  path: string;
  urlTemplate: string;
  /** Constraints dropped to fit Anlyon's JSON-Schema subset (e.g. `format`, `minimum`). */
  warnings: string[];
  /** True when the action was imported governed. A GET never is. */
  governed: boolean;
  /**
   * What a governed imported action declares: one exact resource mutation unless `operations`
   * chose another impact for it. Null for an ungoverned action.
   */
  impact: ActionImpactDeclarationInput | null;
  /** Whether each call waits for a person's approval. */
  requiresApproval: boolean;
  /** True when `operations` named this operation. */
  customized: boolean;
  /** Suggested risk, approval and impact. Never applied by itself. */
  suggestion: ImportSuggestion;
  /**
   * A verify rule the spec supports for this write, or null. It is NOT on the action: check that
   * it reads back what the write changed, then `actions.update(name, { verify: proposedVerify })`.
   */
  proposedVerify: ProposedVerify | null;
  /** Why no read-back is proposed, or what to check before accepting the one that is. */
  verifyNote: string | null;
  /** The created action  absent on a dry run. */
  action?: Action;
}

export interface SkippedOperation {
  path: string;
  method: string;
  /** Why this operation could not be imported faithfully. */
  reason: string;
}

export interface ImportActionsResult {
  created: ImportedAction[];
  skipped: SkippedOperation[];
  dryRun: boolean;
  /**
   * Hosts the import's credential could be limited to, from the base URL and the spec's servers.
   * Not applied: set them as the secret's `allowedHosts`.
   */
  suggestedAllowedHosts: string[];
}

export interface Invocation {
  /** Public invocation id (inv_xxx). */
  id: string;
  actionName: string;
  /**
   * The immutable action version this invocation ran (acv_xxx), so an audit can say which
   * definition executed the call. Null only for invocations recorded before versioning existed.
   */
  actionVersionId?: string | null;
  status: InvocationStatus;
  responseStatus: number | null;
  body: string | null;
  error: string | null;
  durationMs: number | null;
  /** Set when the invocation is gated (apr_xxx). */
  approvalId: string | null;
  /**
   * Why the request was allowed or refused, when a policy, a person or expiry decided it.
   * Persisted on the invocation, so it reads the same after the policy is edited or deleted.
   * `responseStatus` and `body` stay null for a request that was never sent.
   */
  decision: InvocationDecision | null;
  /** The failed invocation this one deliberately retried. */
  retryOf: string | null;
  /** On single reads: the invocation that retried this one. */
  retriedBy?: string | null;
  /** On single reads: the operator's confirmed outcome for an invocation that was `unknown`. */
  resolution?: InvocationResolution | null;
  /** The governed effect this invocation created (eff_xxx), for adapter actions. */
  effectId?: string | null;
  /**
   * On invoke responses and single reads: the receipt grade of the effect this invocation created.
   * Absent when the invocation has no effect, and on list reads.
   */
  grade?: EffectGrade | null;
  /** The end user the call was made for (`forUser()`), or null for a workspace call. */
  endUserId?: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** An operator's confirmed outcome for an invocation whose outcome was unknown. Permanent. */
export interface InvocationResolution {
  outcome: 'succeeded' | 'failed';
  evidence: string;
  externalReference: string | null;
  resolvedBy: { type: 'api_key' | 'user'; id: string };
  resolvedAt: string;
}

export interface ResolveInvocationInput {
  /** What the destination confirms happened. */
  outcome: 'succeeded' | 'failed';
  /** What you checked at the destination (10 to 2000 characters). */
  evidence: string;
  /** The destination's own reference, such as a charge or ticket id. */
  externalReference?: string | null;
}

export type DecisionSource = 'policy' | 'human' | 'system' | 'assistant';
export type DecisionCode =
  | 'POLICY_DENIED'
  | 'POLICY_APPROVED'
  | 'HUMAN_APPROVED'
  | 'HUMAN_DENIED'
  | 'APPROVAL_EXPIRED'
  | 'ASSISTANT_APPROVED'
  /** The end user the call was made for was erased while its approval was pending. Not sent. */
  | 'END_USER_ERASED';

/** A frozen, secret-free record of one decision. */
export interface InvocationDecision {
  source: DecisionSource;
  code: DecisionCode;
  /** What actually happened to the request. */
  effect: 'approved' | 'denied' | 'expired';
  /** Safe to show, e.g. `Denied by policy "refund_order_denied", version 2. The request was not sent.` */
  explanation: string;
  /** The policy that decided, as it stood at decision time. Null when no policy decided. */
  policy: { id: string; name: string; version: number } | null;
  decidedAt: string;
}

/**
 * Whose accounts a record acted in: `workspace` (the workspace's own, no end user) or `end_users`
 * (one of your end users'). Lists take it to show one side.
 */
export type ActingFor = 'workspace' | 'end_users';

/** Who decides an approval: your `team`, or the `end_user` the call was made for, in your app. */
export type ApprovalDecider = 'team' | 'end_user';

export interface InvokeResult extends Invocation {
  /** True when a human still has to decide before this runs. */
  pendingApproval: boolean;
}

export interface ListInvocationsParams {
  /** Action name or act_ id. */
  action?: string;
  /** `unknown` lists calls waiting for an operator to confirm their outcome. */
  status?: InvocationStatus;
  /** Only calls made for this end user. */
  endUserId?: string;
  /**
   * Only calls made with the workspace's own accounts (`workspace`), or only calls made for an end
   * user (`end_users`). A key that requires an end user is still narrowed to its own end user.
   */
  actingFor?: ActingFor;
  limit?: number;
  offset?: number;
}

/**
 * `function_plan`: the writes a hosted function's plan run recorded, bound to the plan's digest
 * (`payload.planDigest`). Its payload is a `FunctionPlanApprovalPayload`.
 */
export type ApprovalKind = 'action' | 'custom' | 'function_plan';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface Approval {
  /** Public approval id (apr_xxx). */
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  title: string;
  description: string | null;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  /** Finalizing reviewer, not every voter. Historical display names can be unavailable. */
  decidedBy?: { type: 'api_key' | 'user'; id: string; displayName: string | null } | null;
  /** Recorded vote history, returned on detail reads (including long-poll). */
  votes?: Array<{
    decision: 'approve' | 'deny';
    decidedBy: { type: 'api_key' | 'user'; id: string; displayName: string | null } | null;
    note: string | null;
    /**
     * An app acting for the decider, or an API key they created, requested this approval. Allowed
     * only while they are the only member who can decide approvals in its environment.
     */
    selfApproved: boolean;
    decidedAt: string;
  }>;
  /** Distinct approvers needed (N-of-M), as resolved from the governing policy when the approval was created. */
  requiredApprovals: number;
  /** Approvals recorded so far. */
  approvedCount: number;
  /** The policy that governed this approval. Null when none matched, and on approvals that predate policies. */
  matchedPolicyId: string | null;
  /** That policy's version at the time. Null exactly when `matchedPolicyId` is null. */
  matchedPolicyVersion: number | null;
  /** How the policy was applied, in words. Null on approvals recorded before it was kept. */
  policyExplanation: string | null;
  /** Who decided. Null while pending. */
  decisionOrigin: 'human' | 'policy' | 'system' | 'unknown' | 'assistant' | null;
  /** The end user the call was made for, or null for a call with the workspace's own accounts. */
  endUserId?: string | null;
  /**
   * Who decides it: `team`, or `end_user` when the end user the call was made for decides it in
   * your app (a policy with `decidedBy: 'end_user'`). Not `decidedBy`, which is the reviewer.
   * Absent from older servers.
   */
  decider?: ApprovalDecider;
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
}

export interface CreateApprovalRequest {
  title: string;
  description?: string;
  payload?: Record<string, unknown>;
  /** Defaults to the workspace TTL (24h). */
  expiresInSeconds?: number;
  /** Existing Anlyon run that receives approval lifecycle spans. */
  runId?: string;
  /** Optional parent span within runId. */
  parentSpanId?: string;
}

export interface DecideApprovalRequest {
  note?: string;
}

export interface DecisionResult {
  approval: Approval;
  /** This decision was a self-approval (see `Approval.votes[].selfApproved`). */
  selfApproved: boolean;
  /** Present when approving a kind="action" approval: the executed invocation. */
  invocation?: Invocation;
}

export interface ListApprovalsParams {
  status?: ApprovalStatus;
  /** `automated` is policy, system or assistant. For the inbox, use `status: 'pending'`. */
  decisionOrigin?: 'human' | 'policy' | 'system' | 'unknown' | 'assistant' | 'automated';
  /** Only approvals that belong to this end user. */
  endUserId?: string;
  /** Only approvals of calls made with the workspace's own accounts, or only of calls made for an end user. */
  actingFor?: ActingFor;
  /**
   * Who decides: `team` (the inbox) or `end_user` (decided by the end user in your app, through
   * `endUsers.approvals`; read-only here).
   */
  decider?: ApprovalDecider;
  limit?: number;
  offset?: number;
}

export interface GetApprovalParams {
  /**
   * Hold the request open for up to this many seconds waiting for a decision
   * (0 to 55, higher values are clamped server-side). When the wait runs out the
   * approval comes back still `pending`  that is not an error.
   */
  waitSeconds?: number;
}

export interface WaitForDecisionOptions {
  /** Give up after this long and return the still-pending approval. Default 5 minutes. */
  timeoutMs?: number;
}

/** Options for `approvals.gate()`  request fields plus the wait budget. */
export interface GateOptions {
  title: string;
  description?: string;
  /** Shown to the approver. Defaults to the gated call's arguments. */
  payload?: Record<string, unknown>;
  /** Defaults to the workspace TTL (24h). */
  expiresInSeconds?: number;
  /** How long to wait for the human before ApprovalPendingError. Default 5 minutes. */
  timeoutMs?: number;
  /** Existing Anlyon run that receives approval lifecycle spans. */
  runId?: string;
  /** Optional parent span within runId. */
  parentSpanId?: string;
}

export type BudgetDimension =
  | 'messages'
  | 'eventPublishes'
  | 'actionInvokes';

export interface Budget {
  workspaceId: string;
  apiKeyId: string;
  /** Estimated monthly spend cap in cents. null = no cost cap. */
  monthlyCostCentsCap: number | null;
  dimensionCaps: Partial<Record<BudgetDimension, number>>;
  /** Fraction of the cost cap at which the one-per-month alert fires. */
  alertThreshold: number;
  enabled: boolean;
  usage: Record<BudgetDimension, number>;
  estimatedCostCents: number;
  /** Legacy usage is unknown; budgeted admissions pause until an operator reconciles it. */
  reconciliationRequired: boolean;
  alertedAt: string | null;
}

export interface PutBudgetRequest {
  monthlyCostCentsCap?: number | null;
  dimensionCaps?: Partial<Record<BudgetDimension, number>>;
  alertThreshold?: number;
  enabled?: boolean;
}

export type PolicyMatchKind = 'any' | 'action' | 'custom';
export type PolicyEffect = 'require_approval' | 'auto_approve' | 'auto_deny';
export type PolicyScope = 'specific_action' | 'all_actions' | 'custom_requests' | 'all_requests';

export interface EvaluateApprovalPoliciesRequest {
  kind: 'action' | 'custom';
  /** Required for action; forbidden for custom. */
  actionName?: string;
  agentId?: string | null;
  userId?: string | null;
  /** Numeric amount and custom-request tags are read from this payload. */
  payload?: Record<string, unknown>;
}

export interface PolicyEvaluation {
  evaluation: 'policy_only';
  environmentId: string;
  limitations: string;
  decision: {
    matched: boolean;
    effect: 'require_approval' | 'auto_approve' | 'auto_deny';
    requiredApprovals: number;
    matchedPolicyId: string | null;
    matchedPolicyVersion: number | null;
    matchedPolicyName: string | null;
    matchedActionName: string | null;
    explanation: string;
  };
}

export interface PolicyFileChange {
  op: 'create' | 'update' | 'delete' | 'unchanged';
  key: string;
  name: string;
  policyId?: string;
  version?: number;
  /** For updates: the fields that change. */
  fields?: string[];
  /** For creates and updates: the policy as the file declares it. */
  after?: Record<string, unknown>;
}

export interface PolicyFilePlan {
  file: string;
  environmentId: string;
  /** Pass to `applyFile`; it refuses if anything changed since this plan. */
  digest: string;
  changes: PolicyFileChange[];
  summary: { create: number; update: number; delete: number; unchanged: number };
  /** Problems that prevent applying. Empty when the file can be applied. */
  errors: string[];
}

export interface PolicyFileTestCase {
  name: string;
  request: { kind: 'action' | 'custom'; action?: string; input?: Record<string, unknown>; agent?: string; user?: string; tags?: string[] };
  /** `policy` is a key in this file, another policy id, or null for "no policy matched". */
  expect: { effect?: 'require_approval' | 'auto_approve' | 'auto_deny'; policy?: string | null };
}

export interface PolicyFileTestResult {
  file: string;
  passed: number;
  failed: number;
  results: Array<{
    name: string;
    pass: boolean;
    policy: string | null;
    effect: 'require_approval' | 'auto_approve' | 'auto_deny';
    explanation: string;
  }>;
}

export interface ListPolicyVersionsParams {
  /** Versions per page, newest first (1-100, default 50). */
  limit?: number;
  /** Return versions older than this one: the previous page's `pagination.nextBefore`. */
  before?: number;
}

export interface ApprovalPolicyVersionPage extends ApiResponse<ApprovalPolicyVersion[]> {
  pagination?: {
    limit: number;
    /** Pass as `before` for the next (older) page. Null on the last page. */
    nextBefore: number | null;
    /** The oldest retained version: a decision citing an older one predates retained history. */
    earliestVersion: number;
    latestVersion: number;
  };
}

export interface ApprovalPolicyVersion {
  policyId: string;
  version: number;
  operation: 'created' | 'updated' | 'deleted' | 'baseline';
  snapshot: Record<string, unknown>;
  contentHash: string;
  actor: { type: 'api_key' | 'user' | 'unknown' } & { id: string } | null;
  changeNote: string | null;
  createdAt: string;
}

export interface ApprovalPolicy {
  /** Public policy id (apol_xxx). */
  id: string;
  /** The environment the policy governs. Policies never span environments. */
  environmentId: string;
  name: string;
  /** Lower runs first. Ties are broken by creation time, then id. */
  priority: number;
  enabled: boolean;
  /** What it applies to, derived from `match`. Never inferred from the name. */
  scope: PolicyScope;
  /** True on a broad policy nobody has confirmed the scope of (every policy that predates explicit targeting). */
  needsScopeReview: boolean;
  match: {
    kind: PolicyMatchKind;
    actionName: string | null;
    agentId: string | null;
    userId: string | null;
    tags: string[] | null;
    minAmount: number | null;
    conditions: Record<string, unknown> | null;
    /** CEL condition that must also hold (https://cel.dev). */
    condition: string | null;
  };
  effect: PolicyEffect;
  requiredApprovals: number;
  /**
   * Who decides an approval this policy requires. `team`: the console, Slack or a key with
   * `approvals:decide`. `end_user`: the end user a call was made for, in your app (one decision,
   * whatever `requiredApprovals` says). A call with no end user is always decided by the team.
   * Absent from older servers.
   */
  decidedBy?: ApprovalDecider;
  version: number;
  scopeReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateApprovalPolicyRequest {
  changeNote?: string;
  name: string;
  /**
   * Required. `'action'` with `matchActionName` targets one action; `'action'` alone targets every
   * action; `'custom'` targets custom approval requests; `'any'` targets every request.
   */
  matchKind: PolicyMatchKind;
  /** Needs `matchKind: 'action'`, and the action must exist in this environment. */
  matchActionName?: string;
  matchAgentId?: string;
  matchUserId?: string;
  matchTags?: string[];
  minAmount?: number;
  conditions?: Record<string, unknown>;
  /**
   * A CEL expression that must also hold, e.g. `input.amount >= 500 && input.currency == "USD"`.
   * Checked against the target action's input schema when saved. A condition that errors at run
   * time (for example a missing field; guard with `has()`) requires approval rather than skipping.
   */
  condition?: string;
  effect?: PolicyEffect;
  requiredApprovals?: number;
  /** Who decides: the `team` (default), or the `end_user` a call was made for. */
  decidedBy?: ApprovalDecider;
  priority?: number;
  enabled?: boolean;
  /** Required to create an `auto_deny` that applies to every action or every request. */
  acknowledgeBroadScope?: boolean;
}

/**
 * Omitted (or `undefined`) means unchanged. An explicit `null` clears a nullable matcher.
 */
export interface UpdateApprovalPolicyRequest {
  changeNote?: string;
  name?: string;
  matchKind?: PolicyMatchKind;
  matchActionName?: string | null;
  matchAgentId?: string | null;
  matchUserId?: string | null;
  matchTags?: string[] | null;
  minAmount?: number | null;
  conditions?: Record<string, unknown> | null;
  /** Omit to leave unchanged; `null` removes the condition. */
  condition?: string | null;
  effect?: PolicyEffect;
  requiredApprovals?: number;
  /** Who decides: the `team`, or the `end_user` a call was made for. Omit to leave unchanged. */
  decidedBy?: ApprovalDecider;
  priority?: number;
  enabled?: boolean;
  acknowledgeBroadScope?: boolean;
}

/**
 * A workspace role. admin holds everything, billing and deleting the workspace included; member works
 * day to day; approver reads and decides approvals; viewer only reads. `owner` was merged into admin on
 * 2026-10-24 and is no longer returned; it stays in the type so code that switches on it compiles.
 */
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'approver' | 'viewer';

/** The caller's own credential. Never contains a secret, a hash, another key or an account detail. */
export interface CredentialIdentity {
  credentialType: 'api_key' | 'oauth' | 'session';
  /** Only an API key has one. Null for OAuth and sessions. */
  apiKeyId: string | null;
  workspaceId: string;
  environmentId: string;
  /** Effective granted scopes, sorted. Null for a session (its authority is the user's workspace role). */
  scopes: string[] | null;
  expiresAt: string | null;
  /**
   * For a session or OAuth token, the person's role in this environment: the credential can do no more
   * than it allows. Null for an API key, whose scopes are its authority. Absent from older servers.
   */
  role?: WorkspaceRole | null;
}
