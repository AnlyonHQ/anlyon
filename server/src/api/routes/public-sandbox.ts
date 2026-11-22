import { Hono, type Context, type Next } from "hono";
import { sandboxWorkspaceFromAuthorization } from "../../core/sandbox/token.ts";
import { ApiError } from "../../utils/errors.ts";
import { rateLimitByIp, rateLimitByVerifiedBucket } from "../middleware/rateLimit.ts";

export const SANDBOX_MOUNT_PATH = "/api/v2/public/sandbox";

export async function rateLimitPublic(c: Context, next: Next) {
  if (c.req.path.startsWith(`${SANDBOX_MOUNT_PATH}/`)) {
    const workspaceId = sandboxWorkspaceFromAuthorization(c.req.header("authorization"));
    if (workspaceId) return rateLimitByVerifiedBucket(c, next, `sandbox:ws:${workspaceId}`);
  }
  return rateLimitByIp(c, next);
}

export const SANDBOX_MAX_BODY_BYTES = 16 * 1024;

const publicSandboxRouter = new Hono({ strict: false });

publicSandboxRouter.post("/echo", async (c) => {
  const tooLarge = () => new ApiError(413, "PAYLOAD_TOO_LARGE", "The sandbox accepts request bodies up to 16 KB.");
  if (Number(c.req.header("content-length") ?? 0) > SANDBOX_MAX_BODY_BYTES) throw tooLarge();
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > SANDBOX_MAX_BODY_BYTES) throw tooLarge();

  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  c.header("Cache-Control", "no-store");
  return c.json({
    success: true,
    data: {
      receivedAt: new Date().toISOString(),
      method: c.req.method,
      authorization: c.req.header("authorization") ?? null,
      contentType: c.req.header("content-type") ?? null,
      body,
    },
  });
});

export default publicSandboxRouter;
