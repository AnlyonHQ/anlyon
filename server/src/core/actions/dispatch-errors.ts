import { SsrfBlockedError } from "../../lib/safe-http.ts";
import { AuthorizationError, ValidationError } from "../../utils/errors.ts";

export function outcomeOfDispatchError(error: unknown): "failed" | "unknown" {
  if (error instanceof SsrfBlockedError) return "failed";

  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  if (code && CONNECT_FAILURES.has(code)) return "failed";

  if (error instanceof ValidationError || error instanceof AuthorizationError) return "failed";

  return "unknown";
}

const CONNECT_FAILURES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EACCES",
]);

export function outcomeOfResponseStatus(status: number): "succeeded" | "failed" | "unknown" {
  if (status >= 200 && status < 300) return "succeeded";
  if (status >= 500) return "unknown";
  return "failed";
}
