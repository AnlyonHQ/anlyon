import { env } from "../../config/env.ts";

export const CONSENT_BASE_PATH = "/api/v2/connection-consent";
export const CONNECT_PAGE_PATHS = ["/link", "/key", "/start", "/callback"] as const;
export type ConsentPage = "link" | "key" | "start" | "callback";

const trim = (url: string) => url.replace(/\/+$/, "");

export function consentBase(): string {
  if (env.CONNECT_PAGES_URL) return trim(env.CONNECT_PAGES_URL);
  return `${trim(env.CONNECT_PUBLIC_URL ?? env.BETTER_AUTH_URL)}${CONSENT_BASE_PATH}`;
}

export function consentUrl(page: ConsentPage): string {
  return `${consentBase()}/${page}`;
}

export function connectPagesHost(): string | null {
  return env.CONNECT_PAGES_URL ? new URL(env.CONNECT_PAGES_URL).host.toLowerCase() : null;
}
