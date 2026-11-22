import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { rateLimitByIp } from "../middleware/rateLimit.ts";
import { validateBody } from "../middleware/validation.ts";
import { auditCaller } from "../audit-caller.ts";
import { NotFoundError } from "../../utils/errors.ts";
import { completeSetup, isSetupPending, MAX_OWNER_PASSWORD, MIN_OWNER_PASSWORD, verifySetupToken } from "../../core/instance/setup.ts";

const setupRouter = new Hono();
setupRouter.use("*", rateLimitByIp);

async function requirePending(_c: Context, next: Next) {
  if (!(await isSetupPending())) throw new NotFoundError("Setup");
  await next();
}
setupRouter.use("*", requirePending);

const tokenSchema = z.object({ token: z.string().min(1).max(512) });

const ownerSchema = tokenSchema.extend({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  password: z.string().min(MIN_OWNER_PASSWORD, `At least ${MIN_OWNER_PASSWORD} characters`).max(MAX_OWNER_PASSWORD),
  workspaceName: z.string().trim().min(1).max(100).optional(),
});

setupRouter.get("/", (c: Context) => c.json({ success: true, data: { pending: true } }));

setupRouter.post("/verify", validateBody(tokenSchema), async (c: Context) => {
  const { token } = c.get("validatedBody") as z.infer<typeof tokenSchema>;
  return c.json({ success: true, data: { valid: await verifySetupToken(token) } });
});

setupRouter.post("/owner", validateBody(ownerSchema), async (c: Context) => {
  const body = c.get("validatedBody") as z.infer<typeof ownerSchema>;
  const created = await completeSetup(body, auditCaller(c).context);
  return c.json({ success: true, data: { userId: created.userId, workspaceId: created.workspaceId } }, 201);
});

export default setupRouter;
