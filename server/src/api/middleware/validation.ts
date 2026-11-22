import type { Context, Next } from "hono";
import type { ZodSchema } from "zod";
import { ValidationError } from "../../utils/errors.ts";
import { legacyZodIssues } from "../../utils/zod-compat.ts";
import { createLogger } from "../../lib/logger.ts";
import { env } from "../../config/env.ts";
import { redactSensitivePath } from "../../utils/sensitive-paths.ts";
import { isBodyLimitError } from "./security.ts";

const logger = createLogger({ module: "validation-middleware" });

export function validateBody(schema: ZodSchema) {
  return async (c: Context, next: Next) => {
    let body: unknown;
    try {
      const rawBody = await c.req.text();
      const maxSize = Number(env.MAX_MESSAGE_SIZE ?? 1048576);
      if (new TextEncoder().encode(rawBody).length > maxSize) {
        throw new ValidationError(`Request body exceeds ${maxSize} bytes`);
      }
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch (parseError) {
      if (parseError instanceof ValidationError || isBodyLimitError(parseError)) {
        throw parseError;
      }
      logger.warn({ path: redactSensitivePath(c.req.path), error: parseError }, "Failed to parse JSON body");
      throw new ValidationError("Invalid JSON body");
    }

    if (c.req.path.includes("/workspaces") && c.req.method === "POST") {
      logger.debug({ path: c.req.path, receivedKeys: body && typeof body === "object" ? Object.keys(body) : typeof body }, "Validating workspace creation body");
    }

    const result = schema.safeParse(body);

    if (!result.success) {
      logger.warn(
        {
          path: redactSensitivePath(c.req.path),
          issues: result.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
          receivedKeys: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : typeof body,
        },
        "Validation failed",
      );
      throw new ValidationError("Invalid request body", legacyZodIssues(result.error.issues));
    }

    c.set("validatedBody", result.data);

    await next();
  };
}

export function validateQuery(schema: ZodSchema) {
  return async (c: Context, next: Next) => {
    const query = c.req.query();
    const result = schema.safeParse(query);

    if (!result.success) {
      throw new ValidationError("Invalid query parameters", legacyZodIssues(result.error.issues));
    }

    c.set("validatedQuery", result.data);

    await next();
  };
}

export function validateParams(schema: ZodSchema) {
  return async (c: Context, next: Next) => {
    const params = c.req.param();
    const result = schema.safeParse(params);

    if (!result.success) {
      throw new ValidationError("Invalid URL parameters", legacyZodIssues(result.error.issues));
    }

    c.set("validatedParams", result.data);

    await next();
  };
}
