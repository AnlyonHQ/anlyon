/**
 * Redaction for anything the CLI prints. Credentials must never reach stdout,
 * stderr or a file other than the credential store.
 *
 * Two layers: exact secrets this process has handled (registered as they are read
 * or issued) and shape-based patterns for secrets it has not seen (an API key or a
 * JWT echoed back inside a server error, a Bearer header in a stack trace).
 */
const known = new Set<string>();

export function registerSecret(secret: string | null | undefined): void {
  if (secret && secret.length >= 8) known.add(secret);
}

/** For tests. */
export function clearRegisteredSecrets(): void {
  known.clear();
}

const PATTERNS: RegExp[] = [
  /anlyon_(?:live|test)_[A-Za-z0-9_-]+/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  /(Bearer\s+)[^\s"',]+/gi,
  /((?:refresh_token|access_token|code_verifier|client_secret|code)=)[^&\s"']+/gi,
  /("(?:refresh_token|access_token|refreshToken|accessToken|apiKey|api_key|client_secret|code_verifier)"\s*:\s*")[^"]*/g,
];

export function redact(text: string): string {
  let out = text;
  for (const secret of known) out = out.split(secret).join('[REDACTED]');
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (_match, ...groups: unknown[]) =>
      typeof groups[0] === 'string' ? `${groups[0]}[REDACTED]` : '[REDACTED]',
    );
  }
  return out;
}

/** Redact every string in a JSON-able value. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item);
    return out as T;
  }
  return value;
}

/** Strip terminal control sequences from text that came from a remote party. */
export function sanitizeRemoteText(text: string, max = 500): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
