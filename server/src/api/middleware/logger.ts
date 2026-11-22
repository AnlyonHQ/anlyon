import type { Context, Next } from "hono";
import { apiLogger } from "../../lib/logger.ts";
import { redactSensitivePath } from "../../utils/sensitive-paths.ts";

export async function requestLogger(c: Context, next: Next) {
  const start = Date.now();
  const method = c.req.method;
  const path = redactSensitivePath(c.req.path);
  const requestId = c.get("requestId");

  apiLogger.info({ method, path, requestId }, "Incoming request");

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  apiLogger.info(
    {
      method,
      path,
      status,
      duration: `${duration}ms`,
      requestId,
    },
    "Request completed"
  );
}
