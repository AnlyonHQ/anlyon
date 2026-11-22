/**
 * Error types and constants for Anlyon Scheduler SDK
 */

export const ERROR_CODES = {
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  AUTHORIZATION_ERROR: 'AUTHORIZATION_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  FEATURE_NOT_AVAILABLE: 'FEATURE_NOT_AVAILABLE',
  CONFLICT_ERROR: 'CONFLICT_ERROR',
  APPROVAL_DENIED: 'APPROVAL_DENIED',
  APPROVAL_PENDING: 'APPROVAL_PENDING',
  END_USER_NOT_CONNECTED: 'END_USER_NOT_CONNECTED',
  END_USER_RECONNECT_REQUIRED: 'END_USER_RECONNECT_REQUIRED',
  END_USER_REQUIRED: 'END_USER_REQUIRED',
  END_USER_MISMATCH: 'END_USER_MISMATCH',
  REDIRECT_URL_REQUIRED: 'REDIRECT_URL_REQUIRED',
  SIGN_OFF_REQUIRED: 'SIGN_OFF_REQUIRED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * What to do about an error, when the API knows. Every field but `summary` is optional.
 */
export interface ErrorFix {
  /** What to do, in one sentence. */
  summary: string;
  /** The exact CLI command that fixes it, for example `anlyon auth login --scope anlyon:approvals.decide`. */
  command?: string;
  /** The console page where a person fixes it. */
  url?: string;
  /** The docs page that explains it. */
  docs?: string;
}

export interface AnlyonErrorOptions {
  code: ErrorCode;
  message: string;
  status?: number;
  details?: unknown;
  cause?: Error;
  requestId?: string;
  retryAfter?: number;
  /** What to do about it, from the API's `error.fix`. */
  fix?: ErrorFix;
}
