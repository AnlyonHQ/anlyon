import type { Context, Next } from "hono";
import { ApiError, handleError, type ErrorFix } from "../../utils/errors.ts";
import { fixFor, type FixableError } from "../error-fixes.ts";
import { legacyZodIssues } from "../../utils/zod-compat.ts";
import { ZodError } from "zod";
import { apiLogger } from "../../lib/logger.ts";
import { env } from "../../config/env.ts";
import { redactSensitivePath } from "../../utils/sensitive-paths.ts";
import { captureException, setContext, setTag } from "../../lib/sentry.ts";

const PUBLIC_DETAIL_CODES = new Set<string>(["INVALID_SCOPE"]);

export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (error) {
    return buildErrorResponse(error, c);
  }
}

function isInvalidTextRepresentation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === "object" && (current as { code?: unknown }).code === "22P02") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const DB_UNAVAILABLE_SQLSTATES = new Set(["57014", "57P01", "57P02", "57P03", "53300", "08000", "08003", "08006"]);
const DB_UNAVAILABLE_MESSAGES = /^(Query read timeout|timeout exceeded when trying to connect|Connection terminated|The database is busy)/;

export function isDatabaseUnavailable(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === "object") {
      const { code, message } = current as { code?: unknown; message?: unknown };
      if (typeof code === "string" && DB_UNAVAILABLE_SQLSTATES.has(code)) return true;
      if (typeof message === "string" && DB_UNAVAILABLE_MESSAGES.test(message)) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function safeFixFor(error: FixableError & { fix?: ErrorFix }, c: Context): ErrorFix | undefined {
  try {
    return fixFor(error, {
      consoleUrl: env.CONSOLE_URL,
      authType: c.get("authType") as string | undefined,
      environmentId: c.get("environmentId") as string | undefined,
    });
  } catch (fault) {
    apiLogger.warn({ code: error.code, fault: fault instanceof Error ? fault.message : String(fault) }, "Error fix could not be built");
    return error.fix;
  }
}

export function buildErrorResponse(error: unknown, c: Context) {
  {
    const workspaceId = c.get("workspaceId");
    const requestId = c.get("requestId") || c.req.header("x-request-id");

    if (workspaceId) {
      setTag("workspace_id", workspaceId);
    }
    if (requestId) {
      setTag("request_id", requestId);
    }
    setContext("request", {
      method: c.req.method,
      path: c.req.path,
      url: c.req.url,
    });

    if (error instanceof ZodError) {
      apiLogger.error({ error: error.issues }, "Validation error");

      captureException(error, {
        level: "warning",
        validationErrors: error.issues,
      });

      const fix = safeFixFor({ code: "VALIDATION_ERROR", message: "Validation failed" }, c);
      const errorResponse = {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          details: env.NODE_ENV === "production" ? undefined : legacyZodIssues(error.issues),
          ...(fix ? { fix } : {}),
        },
        requestId,
      };

      return c.json(errorResponse, 400);
    }

    if (error instanceof ApiError) {
      apiLogger.error(
        {
          code: error.code,
          message: error.message,
          statusCode: error.statusCode,
        },
        "API error"
      );

      if (error.statusCode >= 500) {
        captureException(error, {
          errorCode: error.code,
          statusCode: error.statusCode,
        });
      }

      const json = error.toJSON();
      const fix = safeFixFor(error, c);
      const errorResponse = { ...json, error: { ...json.error, ...(fix ? { fix } : {}) }, requestId };
      if (env.NODE_ENV === "production" && errorResponse.error && !PUBLIC_DETAIL_CODES.has(error.code)) {
        errorResponse.error.details = undefined;
      }

      return c.json(errorResponse, error.statusCode as any);
    }

    if (isInvalidTextRepresentation(error)) {
      apiLogger.warn(
        { detail: error instanceof Error ? error.message : String(error), path: redactSensitivePath(c.req.path) },
        "Malformed identifier in request"
      );

      const fix = safeFixFor({ code: "VALIDATION_ERROR", message: "Malformed identifier in request path or body" }, c);
      return c.json(
        {
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Malformed identifier in request path or body",
            ...(fix ? { fix } : {}),
          },
          requestId,
        },
        400
      );
    }

    if (isDatabaseUnavailable(error)) {
      apiLogger.error({ path: redactSensitivePath(c.req.path), method: c.req.method }, "Database unavailable");
      captureException(error, { databaseUnavailable: true });
      c.header("Retry-After", "2");
      return c.json(
        {
          success: false,
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "The service is temporarily unavailable. Retry after the interval in Retry-After.",
          },
          requestId,
        },
        503
      );
    }

    apiLogger.error({ error }, "Unexpected error");

    const eventId = captureException(error, {
      unexpected: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    return c.json(
      {
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected error occurred",
          ...(eventId && env.NODE_ENV === "production" && { eventId }),
        },
        requestId,
      },
      500
    );
  }
}
