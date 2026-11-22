import { env } from "../config/env.ts";
import { isCloudEdition } from "../core/edition/edition.ts";

function splitOrigins(value?: string, name = "CORS_ORIGINS"): string[] {
  return (value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((entry) => {
      let parsed: URL;
      try {
        parsed = new URL(entry);
      } catch {
        throw new Error(`${name}: "${entry}" is not a URL`);
      }
      if (parsed.origin !== entry.replace(/\/+$/, "")) {
        throw new Error(`${name}: "${entry}" must be an origin (scheme and host only), such as ${parsed.origin}`);
      }
      return parsed.origin;
    });
}

export function getAllowedOrigins(): string[] {
  const defaults = !isCloudEdition()
    ? (env.NODE_ENV === "production" ? [] : ["http://localhost:3000"])
    : env.NODE_ENV === "production"
      ? ["https://console.anlyon.com"]
      : ["http://localhost:3000", "https://console.anlyon.com"];

  return [...new Set([
    ...defaults,
    ...splitOrigins(env.CORS_ORIGINS),
    ...splitOrigins(env.BETTER_AUTH_TRUSTED_ORIGINS, "BETTER_AUTH_TRUSTED_ORIGINS"),
    ...(env.FRONTEND_URL ? [env.FRONTEND_URL] : []),
  ])];
}

export function isAllowedRedirectTarget(value: string | null | undefined): boolean {
  if (!value) return false;

  if (/[\\\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith("//")) return false;
  if (value.startsWith("/") && !value.startsWith("//")) return true;

  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    return false;
  }

  return getAllowedOrigins().includes(origin);
}

export function resolveSafeRedirect(value: string | null | undefined): string {
  const fallback = env.FRONTEND_URL || "https://console.anlyon.com";
  return value && isAllowedRedirectTarget(value) ? value : fallback;
}
