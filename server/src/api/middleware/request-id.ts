import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._~-]{1,128}$/;

export function resolveRequestId(value: string | undefined): string {
  if (value && SAFE_REQUEST_ID.test(value)) return value;
  return `req_${randomUUID().replaceAll("-", "")}`;
}

export async function requestId(c: Context, next: Next): Promise<void> {
  const id = resolveRequestId(c.req.header("x-request-id"));
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
}

