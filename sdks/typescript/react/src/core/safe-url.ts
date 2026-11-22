/**
 * Only an https link (http on localhost) is followed or becomes an href. A tool result is not
 * trusted markup, and a connect link from the API is checked the same way: a compromised API or a
 * `baseUrl` pointed at a hostile host must not send the browser to `javascript:` or another scheme.
 */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local) ? parsed.toString() : null;
  } catch {
    return null;
  }
}
