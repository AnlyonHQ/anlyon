/**
 * Sign-off requests: governance changes a human must approve before they apply.
 *
 * An agent may never loosen its own guardrails. When an API key, a CLI login or an MCP session
 * asks to loosen one (raise or remove a limit, disable a policy, add a write action, widen a
 * secret's hosts, resume a halted environment), the API does not apply it. It answers 202 with a
 * pending sign-off request and a link a workspace admin opens to approve or reject it. The SDK
 * throws `SignOffRequiredError` for that answer. Tightening applies at once, as before.
 */

/**
 * Where a sign-off request stands.
 *
 * - `pending`: waiting for a human.
 * - `applied`: an admin approved it and the change was applied (`result` holds the applied object).
 * - `rejected`: an admin rejected it. Nothing changed.
 * - `expired`: nobody decided in time. Nothing changed.
 * - `cancelled`: the credential that asked withdrew it.
 * - `failed`: an admin approved it, but the change could not be applied (`error` says why). Nothing
 *   changed. Ask again.
 *
 * Every status but `pending` is final.
 */
export type SignOffStatus = 'pending' | 'applied' | 'rejected' | 'expired' | 'cancelled' | 'failed';

/** Every status a sign-off request can have, in display order. */
export const SIGN_OFF_STATUSES: readonly SignOffStatus[] = ['pending', 'applied', 'rejected', 'expired', 'cancelled', 'failed'];

/** The governance change a sign-off request holds, for example `impact_limit.update`. */
export type SignOffOperation =
  | 'policy.create'
  | 'policy.update'
  | 'policy.delete'
  | 'policy_file.apply'
  | 'impact_limit.create'
  | 'impact_limit.update'
  | 'impact_limit.archive'
  | 'budget.put'
  | 'budget.delete'
  | 'environment.halt'
  | 'environment.resume'
  | 'action.create'
  | 'action.update'
  | 'action.delete'
  | 'action.import'
  | 'secret.put'
  | 'secret.delete'
  | 'secret_store.create'
  | 'secret_store.update'
  | 'secret_store.delete'
  | 'secret_store_settings.update'
  | 'oauth_app.put'
  | 'oauth_app.delete'
  | (string & {});

/** One field the change touches, and whether it loosens or tightens the guardrail. */
export interface SignOffChange {
  field: string;
  from: unknown;
  to: unknown;
  direction: 'loosening' | 'tightening' | 'neutral';
  /** Why this field counts as loosening or tightening, in one sentence. */
  reason?: string | null;
}

/** A governance change waiting for, or decided by, a human. */
export interface SignOffRequest<TResult = unknown> {
  object: 'sign_off_request';
  /** Public id, `sor_...`. */
  id: string;
  status: SignOffStatus;
  operation: SignOffOperation;
  environmentId: string;
  /** What the change targets, when it targets an existing resource. */
  resource: { type: string; id: string; name?: string | null } | null;
  /** One line, for example `Raise impact limit "Daily refunds" from 50000 to 200000`. */
  summary: string;
  changes: SignOffChange[];
  /** The change as plain text, `-` and `+` lines. */
  diff: string;
  /** The page a workspace admin opens to approve or reject the change. Give this to a human. */
  signOffUrl: string;
  /** The API path to poll, `/api/v2/sign-offs/{id}`. */
  pollUrl: string;
  /** How long to wait between polls. */
  pollAfterSeconds: number;
  requestedBy: { type: 'api_key' | 'oauth_client' | (string & {}); id: string; onBehalfOf: string | null };
  createdAt: string;
  /** When a pending request becomes `expired`. */
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: { type: 'user'; id: string; via: 'console' | 'email_link' | (string & {}) } | null;
  decisionNote: string | null;
  /** On `applied`: what the original call would have returned in `data`. */
  result: TResult | null;
  /** On `failed`: why the approved change could not be applied. */
  error: { code: string; message: string } | null;
}

/** The body of a 202 for a change that waits for a human's sign-off. */
export interface SignOffRequiredResponse {
  success: true;
  signOffRequired: true;
  data: SignOffRequest;
}

/** Filters for `client.signOffs.list()`. */
export interface ListSignOffsParams {
  status?: SignOffStatus;
  limit?: number;
}

/** Options for `client.signOffs.wait()`. */
export interface WaitForSignOffOptions {
  /** Give up after this long and return the request still `pending`. Default 5 minutes. */
  timeoutMs?: number;
  /** Time between polls. Default: the request's `pollAfterSeconds` (5 seconds). */
  pollIntervalMs?: number;
  /** Stop waiting early. */
  signal?: AbortSignal;
}
