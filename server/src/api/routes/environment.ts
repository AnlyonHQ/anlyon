import { auditCaller } from "../audit-caller.ts";
import { Hono, type Context } from "hono";
import { requireApiKey, requireApiKeyScope, requirePermission } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody } from "../middleware/validation.ts";
import { haltEnvironmentSchema } from "../../utils/validation.ts";
import { haltEnvironment, resumeEnvironment } from "../../core/environments/halt.ts";
import { getEnvironment, toPublicEnvironment } from "../../core/environments/service.ts";
import { signOffIfLoosening } from "../governance-gate.ts";

const environmentRouter = new Hono();

environmentRouter.use("*", requireApiKey);
environmentRouter.use("*", rateLimitByWorkspace);

environmentRouter.get("/", async (c: Context) => {
  const env = await getEnvironment(c.get("workspaceId"), c.get("environmentId"));
  return c.json({ success: true, data: toPublicEnvironment(env) });
});

environmentRouter.post(
  "/halt",
  requireApiKeyScope("environments:halt"),
  requirePermission("environments.halt"),
  validateBody(haltEnvironmentSchema),
  async (c: Context) => {
    const { reason } = c.get("validatedBody");
    const env = await haltEnvironment(c.get("workspaceId"), c.get("environmentId"), {
      reason,
      actor: actorOf(c),
      context: auditCaller(c).context,
    });
    return c.json({ success: true, data: toPublicEnvironment(env) });
  },
);

environmentRouter.post(
  "/resume",
  requireApiKeyScope("environments:halt"),
  requirePermission("environments.resume"),
  async (c: Context) => {
    const pending = await signOffIfLoosening(c, "environment.resume", {}, {});
    if (pending) return pending;
    const env = await resumeEnvironment(c.get("workspaceId"), c.get("environmentId"), {
      actor: actorOf(c),
      context: auditCaller(c).context,
    });
    return c.json({ success: true, data: toPublicEnvironment(env) });
  },
);

function actorOf(c: Context): string {
  const keyId = c.get("apiKeyId") as string | undefined;
  return keyId ? `key:${keyId}` : (c.get("userId") as string);
}

export default environmentRouter;
