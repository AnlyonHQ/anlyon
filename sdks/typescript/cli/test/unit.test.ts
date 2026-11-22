import { describe, expect, it, beforeEach } from 'vitest';
import { parseCommandLine, parseDuration, parseLimit, GLOBAL_OPTIONS, type OptionSpec } from '../src/args';
import { challengeFor, constantTimeEqual, createPkce, createState } from '../src/auth/pkce';
import { CliError, toCliError } from '../src/errors';
import { EXIT } from '../src/exit-codes';
import { decodeCursor, encodeCursor, localPage, offsetPage } from '../src/pagination';
import { clearRegisteredSecrets, redact, redactValue, registerSecret, sanitizeRemoteText } from '../src/redact';
import { normaliseApiUrl, assertProfileName } from '../src/config';

describe('PKCE and state', () => {
  it('matches the RFC 7636 appendix B test vector', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('makes 43-character verifiers and unguessable, unique state', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(challengeFor(verifier));
    expect(createState()).not.toBe(createState());
    expect(createState().length).toBeGreaterThanOrEqual(43);
  });
  it('compares state in constant time and rejects length mismatches', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('redaction', () => {
  beforeEach(() => clearRegisteredSecrets());
  it('removes registered secrets and credential shapes it has never seen', () => {
    registerSecret('refresh-token-value-123');
    const text = [
      'token refresh-token-value-123',
      'key anlyon_live_xxxAbCdEf0123456789',
      'Authorization: Bearer abc.def.ghi',
      'jwt eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJlLXZhbHVl',
      'refresh_token=zzz&client_id=cli_1',
      '{"accessToken":"secret-json-value"}',
    ].join('\n');
    const out = redact(text);
    expect(out).not.toContain('refresh-token-value-123');
    expect(out).not.toContain('anlyon_live_xxxAbCdEf');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('eyJzdWIiOiJ1In0');
    expect(out).not.toContain('zzz');
    expect(out).not.toContain('secret-json-value');
    expect(out).toContain('client_id=cli_1');
    expect(out).toContain('Bearer [REDACTED]');
  });
  it('redacts nested values and strips terminal escapes from remote text', () => {
    registerSecret('nested-secret-value');
    expect(redactValue({ a: ['nested-secret-value'], b: 2 })).toEqual({ a: ['[REDACTED]'], b: 2 });
    expect(sanitizeRemoteText('bad\u001b[31mred\u0007')).toBe('bad[31mred');
  });
});

describe('argument parsing', () => {
  const paths = [['runs', 'list'], ['auth', 'login'], ['whoami']];
  const strings = new Set(Object.entries(GLOBAL_OPTIONS).filter(([, s]) => s.type === 'string').map(([n]) => n));
  strings.add('status');
  const opts = (path: string[]): Record<string, OptionSpec> =>
    path.join(' ') === 'runs list' ? { status: { type: 'string', description: '', choices: ['running', 'failed'] } } : {};

  it('finds the command with flags before, between and after', () => {
    const parsed = parseCommandLine(['--profile', 'work', 'runs', '--json', 'list', '--status', 'failed', '--limit=5'], paths, opts, strings);
    expect(parsed.path).toEqual(['runs', 'list']);
    expect(parsed.globals).toMatchObject({ profile: 'work', json: true, limit: '5' });
    expect(parsed.options.status).toBe('failed');
  });
  it('treats a flag value that looks like a command as a value', () => {
    expect(parseCommandLine(['--profile', 'runs', 'whoami'], paths, opts, strings).path).toEqual(['whoami']);
  });
  it('rejects unknown flags and bad choices as usage errors (exit 2)', () => {
    expect(() => parseCommandLine(['whoami', '--nope'], paths, opts, strings)).toThrow(CliError);
    try {
      parseCommandLine(['runs', 'list', '--status', 'weird'], paths, opts, strings);
    } catch (error) {
      expect((error as CliError).exitCode).toBe(EXIT.USAGE);
    }
  });
  it('parses durations and limits strictly', () => {
    expect(parseDuration('30')).toBe(30_000);
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('2m')).toBe(120_000);
    expect(() => parseDuration('soon')).toThrow(CliError);
    expect(parseLimit('100')).toBe(100);
    expect(() => parseLimit('0')).toThrow(CliError);
    expect(() => parseLimit('101')).toThrow(CliError);
    expect(() => parseLimit('5.5')).toThrow(CliError);
  });
});

describe('cursors', () => {
  it('round-trips and is bound to the list that issued it', () => {
    const cursor = encodeCursor({ l: 'runs.list', o: 40 });
    expect(decodeCursor(cursor, 'runs.list')).toEqual({ l: 'runs.list', o: 40 });
    expect(() => decodeCursor(cursor, 'approvals.list')).toThrow(/issued by `runs list`/);
    expect(() => decodeCursor('not-a-cursor', 'runs.list')).toThrow(CliError);
    expect(() => decodeCursor(encodeCursor({ l: 'runs.list', o: -1 }), 'runs.list')).toThrow(CliError);
  });
  it('emits nextCursor only when there is more', () => {
    expect(offsetPage('runs.list', [1, 2], 0, { hasMore: true }).nextCursor).not.toBeNull();
    expect(offsetPage('runs.list', [1, 2], 0, { hasMore: false }).nextCursor).toBeNull();
    const page = localPage('actions.list', [1, 2, 3, 4, 5], 2, 2);
    expect(page.data).toEqual([3, 4]);
    expect(decodeCursor(page.nextCursor!, 'actions.list')!.o).toBe(4);
    expect(localPage('actions.list', [1, 2, 3], 2, 2).nextCursor).toBeNull();
  });
});

describe('exit codes', () => {
  it('maps API failures to stable codes', () => {
    const cases: [unknown, number][] = [
      [{ name: 'AnlyonError', code: 'AUTHENTICATION_FAILED', message: 'x' }, EXIT.AUTH_REQUIRED],
      [{ name: 'AnlyonError', code: 'AUTHORIZATION_ERROR', status: 403, message: 'x' }, EXIT.PERMISSION_DENIED],
      [{ name: 'AnlyonError', code: 'NOT_FOUND', message: 'x' }, EXIT.NOT_FOUND],
      [{ name: 'AnlyonError', code: 'VALIDATION_ERROR', message: 'x' }, EXIT.REJECTED],
      [{ name: 'AnlyonError', code: 'SOMETHING', status: 409, message: 'x' }, EXIT.REJECTED],
      [{ name: 'AnlyonError', code: 'RATE_LIMIT_EXCEEDED', message: 'x' }, EXIT.RATE_LIMITED],
      [{ name: 'AnlyonError', code: 'SOMETHING', status: 503, message: 'x' }, EXIT.UNAVAILABLE],
      [{ name: 'AnlyonError', code: 'NETWORK_ERROR', message: 'x' }, EXIT.UNAVAILABLE],
      [new Error('boom'), EXIT.ERROR],
    ];
    for (const [error, code] of cases) expect(toCliError(error).exitCode).toBe(code);
  });
  it('reports the CLI’s own abort, not the SDK’s TimeoutError', () => {
    const sdkTimeout = { name: 'AnlyonError', code: 'TIMEOUT_ERROR', message: 'Request timeout' };
    expect(toCliError(sdkTimeout, { cancelled: true }).exitCode).toBe(EXIT.CANCELLED);
    expect(toCliError(sdkTimeout, { timedOut: true }).exitCode).toBe(EXIT.TIMEOUT);
  });
  it('never renumbers', () => {
    expect(EXIT).toEqual({
      OK: 0, ERROR: 1, USAGE: 2, AUTH_REQUIRED: 3, PERMISSION_DENIED: 4, NOT_FOUND: 5, REJECTED: 6,
      RATE_LIMITED: 7, UNAVAILABLE: 8, TIMEOUT: 9, TARGET_MISMATCH: 10, NOT_AVAILABLE: 11,
      ACTION_PENDING: 12, ACTION_UNKNOWN: 13, ACTION_NOT_SUCCEEDED: 14, SIGN_OFF_REQUIRED: 15, CANCELLED: 130,
    });
  });
  it('maps the SDK’s SignOffRequiredError to exit 15 with the request as details', () => {
    const signOff = { object: 'sign_off_request', id: 'sor_1', status: 'pending', signOffUrl: 'https://console.anlyon.test/sign-offs/sor_1' };
    const failure = toCliError({ name: 'SignOffRequiredError', code: 'SIGN_OFF_REQUIRED', status: 202, message: 'x', signOff });
    expect(failure.exitCode).toBe(EXIT.SIGN_OFF_REQUIRED);
    expect(failure.code).toBe('SIGN_OFF_REQUIRED');
    expect(failure.details).toBe(signOff);
    expect(failure.message).toContain('https://console.anlyon.test/sign-offs/sor_1');
  });
  it('uses the API’s error.fix as the hint and keeps it in --json', () => {
    const withCommand = toCliError({
      name: 'AnlyonError', code: 'AUTHORIZATION_ERROR', status: 403, message: 'missing scope',
      fix: { summary: 'Log in with the scope.', command: 'anlyon auth login --scope anlyon:approvals.decide', extra: 'dropped' },
    });
    expect(withCommand.hint).toBe('Run: anlyon auth login --scope anlyon:approvals.decide');
    expect(withCommand.toJSON().fix).toEqual({ summary: 'Log in with the scope.', command: 'anlyon auth login --scope anlyon:approvals.decide' });

    const withUrl = toCliError({ name: 'AnlyonError', code: 'AUTHENTICATION_FAILED', status: 401, message: 'x', fix: { summary: 'Make a key.', url: 'https://console.anlyon.test/settings/api-keys' } });
    expect(withUrl.hint).toBe('Open: https://console.anlyon.test/settings/api-keys');

    const without = toCliError({ name: 'AnlyonError', code: 'AUTHENTICATION_FAILED', status: 401, message: 'x', fix: { command: 'no summary' } });
    expect(without.fix).toBeUndefined();
    expect(without.toJSON()).not.toHaveProperty('fix');
  });
});

describe('config validation', () => {
  it('accepts https and loopback http only, and normalises to the origin', () => {
    expect(normaliseApiUrl('https://api.anlyon.com/')).toBe('https://api.anlyon.com');
    expect(normaliseApiUrl('http://127.0.0.1:4000/x')).toBe('http://127.0.0.1:4000');
    expect(() => normaliseApiUrl('http://api.anlyon.com')).toThrow(CliError);
    expect(() => normaliseApiUrl('https://user:pw@api.anlyon.com')).toThrow(CliError);
  });
  it('restricts profile names', () => {
    expect(assertProfileName('work-1')).toBe('work-1');
    expect(() => assertProfileName('../etc')).toThrow(CliError);
    expect(() => assertProfileName('has space')).toThrow(CliError);
  });
});
