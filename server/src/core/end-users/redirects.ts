import { ApiError, ValidationError } from "../../utils/errors.ts";

export const MAX_ALLOWED_REDIRECTS = 20;
const MAX_URL_LENGTH = 2048;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function strictUrl(raw: string): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  if (/[\s\\\u0000-\u001f\u007f]/.test(raw)) return null;
  if (!/^https?:\/\/[^/]/i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url;
}

export function normalizeAllowedRedirect(raw: string): string {
  const url = strictUrl(raw);
  if (!url || url.search) {
    throw new ValidationError(
      `${String(raw).slice(0, 200)} is not an allowed redirect URL: use https://host/path (http only for localhost), with no query, fragment or user info.`,
    );
  }
  return `${url.origin}${url.pathname}`;
}

export function normalizeAllowedRedirects(list: readonly string[]): string[] {
  if (list.length > MAX_ALLOWED_REDIRECTS) throw new ValidationError(`At most ${MAX_ALLOWED_REDIRECTS} allowed redirect URLs.`);
  return [...new Set(list.map(normalizeAllowedRedirect))];
}

function underPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  if (!path.startsWith(prefix)) return false;
  return prefix.endsWith("/") || path.charAt(prefix.length) === "/";
}

export function matchRedirect(raw: string, allowed: readonly string[]): URL | null {
  const url = strictUrl(raw);
  if (!url) return null;
  for (const entry of allowed) {
    const base = strictUrl(entry);
    if (!base) continue;
    if (url.origin === base.origin && underPrefix(url.pathname, base.pathname)) return url;
  }
  return null;
}

export function resolveRedirect(
  requested: string | null | undefined,
  settings: { allowedRedirectUrls: readonly string[]; defaultRedirectUrl: string | null },
): string | null {
  if (requested !== undefined && requested !== null) {
    const url = matchRedirect(requested, settings.allowedRedirectUrls);
    if (!url) {
      throw new ApiError(400, "REDIRECT_URL_NOT_ALLOWED", "redirectUrl is not under one of this environment's allowed redirect URLs.");
    }
    return url.toString();
  }
  if (settings.defaultRedirectUrl && matchRedirect(settings.defaultRedirectUrl, settings.allowedRedirectUrls)) {
    return settings.defaultRedirectUrl;
  }
  return null;
}

export function redirectWithResult(redirectUrl: string, params: Record<string, string>): string {
  const url = new URL(redirectUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
