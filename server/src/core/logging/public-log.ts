import { messageExecutionLogs } from "../../db/schema/execution-logs.ts";

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
]);

export function redactLogHeaders(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, headerValue]) => [
      name,
      SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? "[REDACTED]" : headerValue,
    ])
  );
}

export function toPublicMessageExecutionLog(
  log: typeof messageExecutionLogs.$inferSelect
) {
  return {
    id: log.id,
    messageId: log.messageId,
    attemptNumber: log.attemptNumber,
    status: log.status,
    requestUrl: log.requestUrl,
    requestMethod: log.requestMethod,
    requestHeaders: redactLogHeaders(log.requestHeaders),
    requestBody: log.requestBody,
    responseStatus: log.responseStatus,
    responseHeaders: redactLogHeaders(log.responseHeaders),
    responseBody: log.responseBody,
    errorMessage: log.errorMessage,
    errorCode: log.errorCode,
    duration: log.duration,
    timestamp: log.timestamp,
    createdAt: log.createdAt,
  };
}
