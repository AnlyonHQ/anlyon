/**
 * Exit codes are part of the CLI's public contract: scripts branch on them, so a
 * code is never reused for a different meaning. Add new codes; never renumber.
 */
export const EXIT = {
  OK: 0,
  /** Unexpected failure, or a failure with no more specific code. */
  ERROR: 1,
  /** Bad flags, arguments or --input. Nothing was sent. */
  USAGE: 2,
  /** No usable credential: not logged in, expired, revoked, or rejected (401). */
  AUTH_REQUIRED: 3,
  /** Authenticated, but not permitted: missing scope or role (403). */
  PERMISSION_DENIED: 4,
  /** The resource does not exist in the credential's workspace/environment (404). */
  NOT_FOUND: 5,
  /** The server rejected the request as invalid or conflicting (400, 409, 422). */
  REJECTED: 6,
  /** Rate limit or quota (429). Safe to retry later. */
  RATE_LIMITED: 7,
  /** The server failed or could not be reached (5xx, network). */
  UNAVAILABLE: 8,
  /** --timeout elapsed before the command finished. */
  TIMEOUT: 9,
  /**
   * The resolved target is not what was asked for or recorded: --environment does
   * not match the credential's server-side binding, the credential now resolves to
   * a different workspace/environment than at login, or the API origin was
   * overridden for a profile credential. Nothing was sent past resolution.
   */
  TARGET_MISMATCH: 10,
  /** The command needs an endpoint this server does not provide yet. Nothing was sent. */
  NOT_AVAILABLE: 11,
  /**
   * The action was accepted but has not finished: it is waiting for a human
   * approval, or still running. Nothing failed. Check again with
   * `anlyon invocations get <id>`, or pass --wait.
   */
  ACTION_PENDING: 12,
  /**
   * The action may or may not have taken effect (e.g. the provider timed out
   * after receiving it). Do NOT retry with a new idempotency key: reconcile
   * first. Retrying with the SAME key is safe and returns the recorded result.
   */
  ACTION_UNKNOWN: 13,
  /** The action finished without succeeding: it failed, was denied, or its approval expired. */
  ACTION_NOT_SUCCEEDED: 14,
  /**
   * Waiting for a human's sign-off. The change loosens a guardrail, and no API key or CLI login
   * may loosen its own guardrails, so it was not applied. A workspace admin approves or rejects it
   * at the printed link. Follow it with `anlyon sign-offs get <id> --wait <duration>`.
   */
  SIGN_OFF_REQUIRED: 15,
  /** Interrupted (SIGINT), by convention 128 + 2. */
  CANCELLED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
