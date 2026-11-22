import type { Context, Next } from "hono";
import { env } from "../../config/env.ts";
import { bodyLimit } from "hono/body-limit";
import { ApiError } from "../../utils/errors.ts";

export function httpsRequired(): boolean {
  if (env.ENFORCE_HTTPS === "true") return true;
  if (env.ENFORCE_HTTPS === "false") return false;
  return env.NODE_ENV === "production";
}

export async function enforceHttps(c: Context, next: Next) {
  if (httpsRequired()) {
    const protocol = c.req.header("x-forwarded-proto") || 
                    (c.req.url.startsWith("https://") ? "https" : "http");
    
    if (protocol !== "https") {
      return c.json({
        success: false,
        error: {
          code: "HTTPS_REQUIRED",
          message: "HTTPS is required."
        }
      }, 403);
    }
  }
  
  await next();
}

export function isBodyLimitError(error: unknown): boolean {
  return error instanceof Error && error.name === "BodyLimitError";
}

export function bodySizeLimit(maxSize: number = 1024 * 1024) {
  return bodyLimit({
    maxSize,
    onError: () => {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxSize} bytes`);
    },
  });
}

