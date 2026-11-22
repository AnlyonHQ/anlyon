import type { ErrorFix, SignOffRequest } from '@anlyonhq/sdk';
import { EXIT, type ExitCode } from './exit-codes';
import { redact, sanitizeRemoteText } from './redact';

/**
 * The one error type a command surfaces. `code` is a stable machine-readable
 * string (part of the --json contract); `exitCode` is the process exit status.
 */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly status?: number;
  readonly requestId?: string;
  readonly hint?: string;
  readonly details?: unknown;
  /** What to do about it, from the API's `error.fix`. */
  readonly fix?: ErrorFix;

  constructor(
    code: string,
    message: string,
    exitCode: ExitCode,
    extra: { status?: number; requestId?: string; hint?: string; details?: unknown; fix?: ErrorFix; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.status = extra.status;
    this.requestId = extra.requestId;
    this.hint = extra.hint;
    this.details = extra.details;
    if (extra.fix) this.fix = extra.fix;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: redact(this.message),
      exitCode: this.exitCode,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.hint ? { hint: redact(this.hint) } : {}),
      ...(this.fix ? { fix: redactFix(this.fix) } : {}),
    };
  }
}

function redactFix(fix: ErrorFix): ErrorFix {
  return Object.fromEntries(Object.entries(fix).map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value])) as unknown as ErrorFix;
}

/** The SDK's `fix`, when it has the documented shape. */
function fixFrom(value: unknown): ErrorFix | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const fix = value as Partial<ErrorFix>;
  if (typeof fix.summary !== 'string' || !fix.summary) return undefined;
  const text = (v: unknown) => (typeof v === 'string' && v ? sanitizeRemoteText(v, 500) : undefined);
  const out: ErrorFix = { summary: sanitizeRemoteText(fix.summary, 500) };
  const command = text(fix.command);
  const url = text(fix.url);
  const docs = text(fix.docs);
  if (command) out.command = command;
  if (url) out.url = url;
  if (docs) out.docs = docs;
  return out;
}

export const SIGN_OFF_REQUIRED = 'SIGN_OFF_REQUIRED';

/** The pending request inside the SDK's SignOffRequiredError, or undefined for anything else. */
export function signOffFrom(error: unknown): SignOffRequest | undefined {
  const e = error as { code?: unknown; signOff?: unknown } | null;
  if (!e || e.code !== SIGN_OFF_REQUIRED || !e.signOff || typeof e.signOff !== 'object') return undefined;
  const signOff = e.signOff as SignOffRequest;
  return typeof signOff.id === 'string' && typeof signOff.signOffUrl === 'string' ? signOff : undefined;
}

/** A sign-off request carried on a CliError's details, for output. */
export function signOffDetails(error: CliError): SignOffRequest | undefined {
  const d = error.details as { object?: unknown; id?: unknown; signOffUrl?: unknown } | undefined;
  return d && d.object === 'sign_off_request' && typeof d.id === 'string' && typeof d.signOffUrl === 'string'
    ? (error.details as SignOffRequest)
    : undefined;
}

/** The error a command surfaces when its change waits for a human's sign-off. Exit 15. */
export function signOffRequiredError(signOff: SignOffRequest, cause?: unknown): CliError {
  return new CliError(
    SIGN_OFF_REQUIRED,
    `Needs a human's sign-off. A workspace admin must approve this change before it applies: ${signOff.signOffUrl}`,
    EXIT.SIGN_OFF_REQUIRED,
    { status: 202, details: signOff, cause },
  );
}

export const usageError = (message: string, hint?: string) => new CliError('USAGE', message, EXIT.USAGE, { hint });

export const LOGIN_HINT = 'Run `anlyon auth login`, or set ANLYON_API_KEY for automation.';

/** The same error with a hint added, for a caller that knows what fixes it. */
export function withHint(error: CliError, hint: string): CliError {
  return new CliError(error.code, error.message, error.exitCode, { status: error.status, requestId: error.requestId, hint, details: error.details, cause: error });
}

function exitForStatus(status: number | undefined): ExitCode | undefined {
  if (status === undefined) return undefined;
  if (status === 401) return EXIT.AUTH_REQUIRED;
  if (status === 403) return EXIT.PERMISSION_DENIED;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 429) return EXIT.RATE_LIMITED;
  if (status === 400 || status === 409 || status === 422) return EXIT.REJECTED;
  if (status >= 500) return EXIT.UNAVAILABLE;
  return undefined;
}

const EXIT_BY_SDK_CODE: Record<string, ExitCode> = {
  AUTHENTICATION_FAILED: EXIT.AUTH_REQUIRED,
  AUTHORIZATION_ERROR: EXIT.PERMISSION_DENIED,
  FORBIDDEN: EXIT.PERMISSION_DENIED,
  NOT_FOUND: EXIT.NOT_FOUND,
  VALIDATION_ERROR: EXIT.REJECTED,
  CONFLICT_ERROR: EXIT.REJECTED,
  RATE_LIMIT_EXCEEDED: EXIT.RATE_LIMITED,
  QUOTA_EXCEEDED: EXIT.RATE_LIMITED,
  NETWORK_ERROR: EXIT.UNAVAILABLE,
  TIMEOUT_ERROR: EXIT.TIMEOUT,
};

/**
 * Normalise anything thrown into a CliError. `cancelled`/`timedOut` report
 * whether the CLI's own abort fired, because an aborted fetch surfaces from the
 * SDK as a TimeoutError either way.
 */
export function toCliError(error: unknown, state: { cancelled?: boolean; timedOut?: boolean } = {}): CliError {
  if (error instanceof CliError && error.code === 'ACTION_UNKNOWN') return error;
  if (state.cancelled) return new CliError('CANCELLED', 'Cancelled.', EXIT.CANCELLED);
  if (state.timedOut) return new CliError('TIMEOUT', 'The command did not finish within --timeout.', EXIT.TIMEOUT);
  if (error instanceof CliError) return error;
  const signOff = signOffFrom(error);
  if (signOff) return signOffRequiredError(signOff, error);

  const e = error as { code?: unknown; status?: unknown; message?: unknown; requestId?: unknown; name?: unknown; fix?: unknown };
  const sdkCode = typeof e?.code === 'string' ? e.code : undefined;
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const message = sanitizeRemoteText(typeof e?.message === 'string' ? e.message : String(error));
  const requestId = typeof e?.requestId === 'string' ? e.requestId : undefined;
  const fix = fixFrom(e?.fix);

  if (e?.name === 'AnlyonError' || (sdkCode && sdkCode in EXIT_BY_SDK_CODE) || status !== undefined) {
    const exitCode: ExitCode = (sdkCode ? EXIT_BY_SDK_CODE[sdkCode] : undefined) ?? exitForStatus(status) ?? EXIT.ERROR;
    return new CliError(sdkCode ?? 'API_ERROR', message, exitCode, {
      status,
      requestId,
      hint: fix?.command ? `Run: ${fix.command}` : fix?.url ? `Open: ${fix.url}` : (fix?.summary ?? (exitCode === EXIT.AUTH_REQUIRED ? LOGIN_HINT : undefined)),
      fix,
      cause: error,
    });
  }
  return new CliError('UNEXPECTED', message, EXIT.ERROR, { cause: error });
}
