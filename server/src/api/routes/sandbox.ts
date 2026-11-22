import { Hono, type Context } from "hono";
import { mintSandboxToken } from "../../core/sandbox/token.ts";
import { requireSessionOnly } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";

const sandboxRouter = new Hono();

sandboxRouter.use("*", requireSessionOnly);
sandboxRouter.use("*", rateLimitByWorkspace);

sandboxRouter.post("/token", (c: Context) => {
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: { token: mintSandboxToken(c.get("workspaceId")) } });
});

export default sandboxRouter;
