import { randomUUID } from 'node:crypto';
import type { Connection } from './context';
import { CliError, LOGIN_HINT } from './errors';
import { EXIT, type ExitCode } from './exit-codes';
import { sanitizeRemoteText } from './redact';
import type { Runtime } from './runtime';
import { CLI_VERSION } from './version';

/**
 * A governance change the server did not apply because it loosens a guardrail.
 *
 * An agent may never loosen its own guardrails: a loosening change sent with an API
 * key, an MCP session or a CLI login answers `202 Accepted` with
 * `{ signOffRequired: true, data: <sign-off request> }`. A workspace admin approves or rejects it
 * at `signOffUrl`; anyone holding the credential polls `GET /api/v2/sign-offs/{id}`. Only the
 * fields the CLI reads are typed here.
 */
export interface SignOff {
  id: string;
  status: 'pending' | 'applied' | 'rejected' | 'expired' | 'cancelled' | 'failed' | (string & {});
  signOffUrl: string;
  summary?: string;
  diff?: string;
  expiresAt?: string;
  pollAfterSeconds?: number;
  decisionNote?: string | null;
  error?: { code: string; message: string } | null;
}

export interface ApiResult<T = unknown> {
  status: number;
  data: T;
  /** Present when the server answered 202 and is waiting for a person. */
  signoff?: SignOff;
}

function asSignOff(value: unknown): SignOff | undefined {
  const v = value as Partial<SignOff> | null | undefined;
  return v && typeof v === 'object' && typeof v.id === 'string' && typeof v.signOffUrl === 'string' ? (v as SignOff) : undefined;
}

/** The sign-off request in a 202 body, or undefined. */
export function readSignOff(body: unknown): SignOff | undefined {
  const b = body as { signOffRequired?: unknown; data?: unknown } | null | undefined;
  return b && b.signOffRequired === true ? asSignOff(b.data) : undefined;
}

/** The sign-off request an SDK call threw (SignOffRequiredError), or undefined. Duck-typed. */
export function signOffFromError(error: unknown): SignOff | undefined {
  const e = error as { code?: unknown; signOff?: unknown; details?: unknown } | null;
  if (!e || typeof e !== 'object' || e.code !== 'SIGN_OFF_REQUIRED') return undefined;
  return asSignOff(e.signOff) ?? asSignOff(e.details);
}

function exitFor(status: number): ExitCode {
  if (status === 401) return EXIT.AUTH_REQUIRED;
  if (status === 403) return EXIT.PERMISSION_DENIED;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 429) return EXIT.RATE_LIMITED;
  if (status === 400 || status === 409 || status === 422) return EXIT.REJECTED;
  if (status >= 500) return EXIT.UNAVAILABLE;
  return EXIT.ERROR;
}

/**
 * One request to the connection's API, outside the SDK, for the calls where the status matters:
 * a write that may come back `202` with a sign-off link instead of being applied. Errors become the
 * same CliError, exit code and redaction as any SDK call.
 */
export async function apiRequest<T = unknown>(
  rt: Runtime,
  connection: Pick<Connection, 'target' | 'bearer'>,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  options: { idempotencyKey?: string } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${connection.bearer}`,
    Accept: 'application/json',
    'User-Agent': `anlyon-cli/${CLI_VERSION}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = options.idempotencyKey ?? `cli_${randomUUID()}`;
  let response: Response;
  try {
    response = await rt.fetch(`${connection.target.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: rt.signal,
    });
  } catch (error) {
    if (rt.signal.aborted) throw error;
    throw new CliError('NETWORK_ERROR', `Could not reach ${connection.target.apiUrl}: ${error instanceof Error ? error.message : String(error)}`, EXIT.UNAVAILABLE);
  }
  const text = await response.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (response.status >= 400) {
    const error = (parsed as { error?: { code?: string; message?: string; fix?: CliError['fix'] } } | undefined)?.error;
    const exitCode = exitFor(response.status);
    throw new CliError(error?.code ?? 'API_ERROR', sanitizeRemoteText(error?.message ?? `HTTP ${response.status}`), exitCode, {
      status: response.status,
      requestId: response.headers.get('x-request-id') ?? undefined,
      hint: exitCode === EXIT.AUTH_REQUIRED ? LOGIN_HINT : undefined,
      fix: error?.fix,
    });
  }
  const data = ((parsed as { data?: unknown } | undefined)?.data ?? parsed) as T;
  const signoff = response.status === 202 ? readSignOff(parsed) : undefined;
  return signoff ? { status: 202, data, signoff } : { status: response.status, data };
}

function pause(rt: Runtime, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    rt.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new CliError('CANCELLED', 'Cancelled.', EXIT.CANCELLED));
    }, { once: true });
  });
}

/**
 * Poll a sign-off request until a person decides it or the wait ends. Returns it as last read:
 * still `pending` means the wait ran out.
 */
export async function followSignOff(rt: Runtime, connection: Pick<Connection, 'target' | 'bearer'>, signOff: SignOff, waitMs: number): Promise<SignOff> {
  const deadline = Date.now() + waitMs;
  let current = signOff;
  while (current.status === 'pending') {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const seconds = typeof current.pollAfterSeconds === 'number' && current.pollAfterSeconds > 0 ? current.pollAfterSeconds : 5;
    await pause(rt, Math.min(Math.max(50, seconds * 1000), remaining));
    current = (await apiRequest<SignOff>(rt, connection, 'GET', `/api/v2/sign-offs/${encodeURIComponent(current.id)}`)).data;
  }
  return current;
}
