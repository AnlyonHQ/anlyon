import type { Context, Next } from "hono";
import { cors as honoCors } from "hono/cors";
import { getAllowedOrigins } from "../../utils/origins.ts";

const OWN_CORS_PREFIX = "/api/v2/end-user-session";

const consoleCors = honoCors({
  origin: getAllowedOrigins(),
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Requested-With", "X-Request-Referer", "X-Workspace-Id", "X-Environment-Id", "Idempotency-Key"],
  exposeHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
  maxAge: 600,
  credentials: true,
});

export function corsMiddleware(c: Context, next: Next) {
  const path = c.req.path;
  if (path === OWN_CORS_PREFIX || path.startsWith(`${OWN_CORS_PREFIX}/`)) return next();
  return consoleCors(c, next);
}
