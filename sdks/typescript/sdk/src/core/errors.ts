/**
 * Error classes for Anlyon Scheduler SDK
 */

import type { ErrorCode, AnlyonErrorOptions, ErrorFix } from '../types/errors';
import { ERROR_CODES } from '../types/errors';
import type { SignOffRequest } from '../types/sign-offs';

/**
 * Base error class for all Anlyon SDK errors
 */
export class AnlyonError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly retryAfter?: number;
  /**
   * What to do about this error, when the API says: a one-sentence `summary`, and optionally the
   * exact CLI `command`, a console `url` and a `docs` link.
   */
  readonly fix?: ErrorFix;

  constructor(options: AnlyonErrorOptions) {
    super(options.message);
    this.name = 'AnlyonError';
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
    this.requestId = options.requestId;
    this.retryAfter = options.retryAfter;
    if (options.fix) this.fix = options.fix;

    if (options.cause) {
      this.cause = options.cause;
    }

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /** Check if this is a retryable error */
  get isRetryable(): boolean {
    const retryableCodes: ErrorCode[] = [
      ERROR_CODES.RATE_LIMIT_EXCEEDED,
      ERROR_CODES.NETWORK_ERROR,
      ERROR_CODES.TIMEOUT_ERROR,
    ];
    return retryableCodes.includes(this.code);
  }

  /** Check if this is an authentication error */
  get isAuthError(): boolean {
    return this.code === ERROR_CODES.AUTHENTICATION_FAILED;
  }

  /** Check if this is a validation error */
  get isValidationError(): boolean {
    return this.code === ERROR_CODES.VALIDATION_ERROR;
  }

  /** Check if this is a not found error */
  get isNotFound(): boolean {
    return this.code === ERROR_CODES.NOT_FOUND;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      details: this.details,
      requestId: this.requestId,
      retryAfter: this.retryAfter,
      ...(this.fix ? { fix: this.fix } : {}),
    };
  }
}

/**
 * Read the API's optional `error.fix`. Anything that is not the documented shape is dropped, so a
 * malformed field never breaks error handling.
 */
export function parseErrorFix(value: unknown): ErrorFix | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.summary !== 'string' || !raw.summary) return undefined;
  const fix: ErrorFix = { summary: raw.summary };
  for (const key of ['command', 'url', 'docs'] as const) {
    if (typeof raw[key] === 'string' && raw[key]) fix[key] = raw[key] as string;
  }
  return fix;
}

/**
 * Error thrown when authentication fails
 */
export class AuthenticationError extends AnlyonError {
  constructor(message: string, details?: unknown, requestId?: string) {
    super({
      code: ERROR_CODES.AUTHENTICATION_FAILED,
      message,
      status: 401,
      details,
      requestId,
    });
    this.name = 'AuthenticationError';
  }
}

/**
 * Error thrown when rate limit is exceeded
 */
export class RateLimitError extends AnlyonError {
  constructor(message: string, retryAfter?: number, requestId?: string) {
    super({
      code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
      message,
      status: 429,
      retryAfter,
      requestId,
    });
    this.name = 'RateLimitError';
  }
}

/**
 * Error thrown when usage quota is exceeded
 */
export class QuotaExceededError extends AnlyonError {
  constructor(message: string, details?: unknown, requestId?: string) {
    super({
      code: ERROR_CODES.QUOTA_EXCEEDED,
      message,
      status: 402,
      details,
      requestId,
    });
    this.name = 'QuotaExceededError';
  }
}

/**
 * Error thrown for validation errors
 */
export class ValidationError extends AnlyonError {
  constructor(message: string, details?: unknown, requestId?: string) {
    super({
      code: ERROR_CODES.VALIDATION_ERROR,
      message,
      status: 400,
      details,
      requestId,
    });
    this.name = 'ValidationError';
  }
}

/**
 * Error thrown when a resource is not found
 */
export class NotFoundError extends AnlyonError {
  constructor(message: string, details?: unknown, requestId?: string) {
    super({
      code: ERROR_CODES.NOT_FOUND,
      message,
      status: 404,
      details,
      requestId,
    });
    this.name = 'NotFoundError';
  }
}

/**
 * Error thrown when a feature is not available on the current plan
 */
export class FeatureNotAvailableError extends AnlyonError {
  constructor(message: string, details?: unknown, requestId?: string) {
    super({
      code: ERROR_CODES.FEATURE_NOT_AVAILABLE,
      message,
      status: 402,
      details,
      requestId,
    });
    this.name = 'FeatureNotAvailableError';
  }
}

/**
 * Error thrown for network-related issues
 */
export class NetworkError extends AnlyonError {
  constructor(message: string, cause?: Error) {
    super({
      code: ERROR_CODES.NETWORK_ERROR,
      message,
      cause,
    });
    this.name = 'NetworkError';
  }
}

/**
 * Error thrown when a request times out
 */
export class TimeoutError extends AnlyonError {
  constructor(message: string, timeout: number) {
    super({
      code: ERROR_CODES.TIMEOUT_ERROR,
      message,
      details: { timeout },
    });
    this.name = 'TimeoutError';
  }
}

/**
 * A human denied (or let expire) an approval created by `approvals.gate()`.
 * Carries the decided approval so callers can read the note and audit trail.
 */
export class ApprovalDeniedError extends AnlyonError {
  /** The decided approval (status `denied` or `expired`). */
  readonly approval: { id: string; status: string; decisionNote: string | null };

  constructor(approval: { id: string; status: string; decisionNote: string | null; title: string }) {
    super({
      code: ERROR_CODES.APPROVAL_DENIED,
      message: `Approval ${approval.status}: ${approval.title}`,
      details: approval,
    });
    this.name = 'ApprovalDeniedError';
    this.approval = approval;
  }
}

/**
 * The `approvals.gate()` wait elapsed with the approval still pending.
 * The gated function did NOT run; the approval can still be decided later.
 */
export class ApprovalPendingError extends AnlyonError {
  /** The still-pending approval; poll it with `approvals.waitForDecision()`. */
  readonly approval: { id: string; status: string };

  constructor(approval: { id: string; status: string; title: string }) {
    super({
      code: ERROR_CODES.APPROVAL_PENDING,
      message: `Approval still pending after the wait: ${approval.title}`,
      details: approval,
    });
    this.name = 'ApprovalPendingError';
    this.approval = approval;
  }
}

/**
 * `202` with `signOffRequired: true`: the change loosens a guardrail, and the credential that asked
 * (an API key, a CLI login or an MCP session) may not loosen its own guardrails. Nothing was
 * applied. The API stored the change as a sign-off request that a workspace admin approves or
 * rejects at `signOffUrl`.
 *
 * The SDK throws rather than returns, so code that assumed the change applied never treats a
 * pending request as the updated object. No API key or CLI login can approve it. Give `signOffUrl`
 * to a person, then follow the request with `client.signOffs.wait(signOffId)`.
 *
 * @example
 * ```typescript
 * try {
 *   await client.impactLimits.update(limitId, { amount: 200_000 });
 * } catch (error) {
 *   if (!(error instanceof SignOffRequiredError)) throw error;
 *   console.log(`Ask an admin to approve: ${error.signOffUrl}`);
 *   const decided = await client.signOffs.wait(error.signOffId);
 *   if (decided.status === 'applied') console.log('Applied', decided.result);
 * }
 * ```
 */
export class SignOffRequiredError extends AnlyonError {
  /** The pending sign-off request, as the API returned it. */
  readonly signOff: SignOffRequest;
  /** The page a workspace admin opens to approve or reject the change. */
  readonly signOffUrl: string;
  /** The request's id, `sor_...`. Pass it to `client.signOffs.get()` or `wait()`. */
  readonly signOffId: string;

  constructor(signOff: SignOffRequest, requestId?: string) {
    super({
      code: ERROR_CODES.SIGN_OFF_REQUIRED,
      message: `A human must approve this change before it applies. Give them this link: ${signOff.signOffUrl}`,
      status: 202,
      details: signOff,
      requestId,
    });
    this.name = 'SignOffRequiredError';
    this.signOff = signOff;
    this.signOffUrl = signOff.signOffUrl;
    this.signOffId = signOff.id;
  }
}

/** True when a response body is the 202 that holds a pending sign-off request. */
export function isSignOffRequiredBody(body: unknown): body is { signOffRequired: true; data: SignOffRequest } {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  const data = b.data as Record<string, unknown> | undefined;
  return b.signOffRequired === true && !!data && typeof data === 'object' && typeof data.id === 'string';
}

/**
 * What the API says when an end user has to connect, or connect again, before an action can run
 * for them. `connectUrl` is a fresh connect link: send the end user there.
 */
export interface EndUserConnectDetails {
  /** The integration the action needs, e.g. `gmail`, or `mcp-<id>` for a tool adopted from an MCP server. */
  integration: string;
  /** The name to show the end user: the integration's, e.g. `Gmail`, or the MCP server's. Null from an older API. */
  displayName: string | null;
  /** The end user the call was made for. */
  endUserId: string;
  /**
   * A connect link for this end user and integration. It works once. Null when the environment has
   * no default redirect URL: then make one with `endUsers.createConnectLink()` and your own
   * `redirectUrl`.
   */
  connectUrl: string | null;
  /** When `connectUrl` stops working (ISO 8601), ten minutes after it was made. Null without one. */
  expiresAt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function endUserConnectDetails(details: unknown): EndUserConnectDetails {
  const d = (details && typeof details === 'object' ? details : {}) as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  return {
    integration: text(d.integration) ?? '',
    displayName: text(d.displayName),
    endUserId: text(d.endUserId) ?? '',
    connectUrl: text(d.connectUrl),
    expiresAt: text(d.expiresAt),
  };
}

/**
 * The end user has no working connection for the integration an action needs. The base class of
 * {@link EndUserNotConnectedError} and {@link EndUserReconnectRequiredError}: catch it to handle
 * both the same way, by sending the end user to `connectUrl`.
 */
export class EndUserConnectionRequiredError extends AnlyonError implements EndUserConnectDetails {
  readonly integration: string;
  readonly displayName: string | null;
  readonly endUserId: string;
  readonly connectUrl: string | null;
  readonly expiresAt: string | null;

  constructor(
    code: typeof ERROR_CODES.END_USER_NOT_CONNECTED | typeof ERROR_CODES.END_USER_RECONNECT_REQUIRED,
    message: string,
    details: unknown,
    requestId?: string
  ) {
    const fields = endUserConnectDetails(details);
    super({ code, message, status: 409, details: fields, requestId });
    this.name = 'EndUserConnectionRequiredError';
    this.integration = fields.integration;
    this.displayName = fields.displayName;
    this.endUserId = fields.endUserId;
    this.connectUrl = fields.connectUrl;
    this.expiresAt = fields.expiresAt;
  }
}

/**
 * `409 END_USER_NOT_CONNECTED`: the end user has not connected the integration the action needs.
 * Nothing was sent. Show them a "Connect" button that opens `connectUrl`, then call again.
 *
 * @example
 * ```typescript
 * try {
 *   await anlyon.forUser(user.id).actions.invoke('gmail.send', input);
 * } catch (error) {
 *   if (error instanceof EndUserNotConnectedError && error.connectUrl) return redirect(error.connectUrl);
 *   throw error;
 * }
 * ```
 */
export class EndUserNotConnectedError extends EndUserConnectionRequiredError {
  constructor(message: string, details: unknown, requestId?: string) {
    super(ERROR_CODES.END_USER_NOT_CONNECTED, message, details, requestId);
    this.name = 'EndUserNotConnectedError';
  }
}

/**
 * `409 END_USER_RECONNECT_REQUIRED`: the end user's connection was revoked at the provider, or its
 * token could not be refreshed. Nothing was sent. Send them to `connectUrl` to connect again.
 */
export class EndUserReconnectRequiredError extends EndUserConnectionRequiredError {
  constructor(message: string, details: unknown, requestId?: string) {
    super(ERROR_CODES.END_USER_RECONNECT_REQUIRED, message, details, requestId);
    this.name = 'EndUserReconnectRequiredError';
  }
}

/**
 * `400 END_USER_REQUIRED`: the API key requires an end user, and the call named none. Make the
 * call with a client from `anlyon.forUser(endUserId)`. Such a key never falls back to a workspace
 * connection.
 */
export class EndUserRequiredError extends AnlyonError {
  constructor(message: string, details?: unknown, requestId?: string) {
    super({ code: ERROR_CODES.END_USER_REQUIRED, message, status: 400, details, requestId });
    this.name = 'EndUserRequiredError';
  }
}

/**
 * `403 END_USER_MISMATCH` from `endUsers.confirmConnection()`: the connect flow was started for a
 * different end user than the one confirming it. Nothing was connected. This is the check that
 * stops a link sent to someone else from attaching their account to your user: confirm with the
 * end user from your own session, never one read from the redirect.
 */
export class EndUserMismatchError extends AnlyonError {
  constructor(message: string, details?: unknown, requestId?: string) {
    super({ code: ERROR_CODES.END_USER_MISMATCH, message, status: 403, details, requestId });
    this.name = 'EndUserMismatchError';
  }
}

/**
 * `400 REDIRECT_URL_REQUIRED` from `endUsers.createConnectLink()`: the request named no
 * `redirectUrl` and the environment has no default redirect URL. A connect flow has to come back
 * to your server to be confirmed. Pass one of the environment's allowed redirect URLs, or set a
 * default in the console.
 */
export class RedirectUrlRequiredError extends AnlyonError {
  constructor(message: string, details?: unknown, requestId?: string) {
    super({ code: ERROR_CODES.REDIRECT_URL_REQUIRED, message, status: 400, details, requestId });
    this.name = 'RedirectUrlRequiredError';
  }
}

/**
 * Factory function to create appropriate error from API response
 */
export function createErrorFromResponse(
  status: number,
  response: { error?: { code: string; message: string; details?: unknown; fix?: unknown } },
  requestId?: string,
  retryAfter?: number
): AnlyonError {
  const created = errorForCode(status, response, requestId, retryAfter);
  const fix = parseErrorFix(response?.error?.fix);
  if (fix) (created as { fix?: ErrorFix }).fix = fix;
  return created;
}

function errorForCode(
  status: number,
  response: { error?: { code: string; message: string; details?: unknown } },
  requestId?: string,
  retryAfter?: number
): AnlyonError {
  const error = response?.error ?? {
    code: 'UNKNOWN_ERROR',
    message: 'Unknown error occurred',
  };

  switch (error.code) {
    case ERROR_CODES.AUTHENTICATION_FAILED:
      return new AuthenticationError(error.message, error.details, requestId);

    case ERROR_CODES.RATE_LIMIT_EXCEEDED:
      return new RateLimitError(error.message, retryAfter, requestId);

    case ERROR_CODES.QUOTA_EXCEEDED:
      return new QuotaExceededError(error.message, error.details, requestId);

    case ERROR_CODES.VALIDATION_ERROR:
      return new ValidationError(error.message, error.details, requestId);

    case ERROR_CODES.NOT_FOUND:
      return new NotFoundError(error.message, error.details, requestId);

    case ERROR_CODES.FEATURE_NOT_AVAILABLE:
      return new FeatureNotAvailableError(
        error.message,
        error.details,
        requestId
      );

    case ERROR_CODES.END_USER_NOT_CONNECTED:
      return new EndUserNotConnectedError(error.message, { ...error, ...asRecord(error.details) }, requestId);

    case ERROR_CODES.END_USER_RECONNECT_REQUIRED:
      return new EndUserReconnectRequiredError(error.message, { ...error, ...asRecord(error.details) }, requestId);

    case ERROR_CODES.END_USER_REQUIRED:
      return new EndUserRequiredError(error.message, error.details, requestId);

    case ERROR_CODES.END_USER_MISMATCH:
      return new EndUserMismatchError(error.message, error.details, requestId);

    case ERROR_CODES.REDIRECT_URL_REQUIRED:
      return new RedirectUrlRequiredError(error.message, error.details, requestId);

    default:
      return new AnlyonError({
        code: (error.code as ErrorCode) ?? ERROR_CODES.UNKNOWN_ERROR,
        message: error.message,
        status,
        details: error.details,
        requestId,
      });
  }
}

/**
 * The credential does not hold what the application needs, or holds something it should not.
 *
 * Thrown by `client.auth.requireScopes()`. It says which scopes, never anything about the key itself.
 */
export class ScopeCheckError extends AnlyonError {
  /** Scopes the application requires and the credential lacks. */
  readonly missing: string[];
  /** Scopes the application refuses to run with and the credential holds. */
  readonly forbidden: string[];

  constructor(missing: string[], forbidden: string[]) {
    const parts: string[] = [];
    if (missing.length) parts.push(`missing scopes: ${missing.join(', ')}`);
    if (forbidden.length) parts.push(`holds scopes it must not: ${forbidden.join(', ')}`);
    super({ code: ERROR_CODES.AUTHORIZATION_ERROR, message: `This credential ${parts.join('; ')}`, details: { missing, forbidden } });
    this.name = 'ScopeCheckError';
    this.missing = missing;
    this.forbidden = forbidden;
  }
}
