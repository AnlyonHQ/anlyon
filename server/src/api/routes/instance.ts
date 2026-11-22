import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { requireSession } from "../middleware/auth.ts";
import { validateBody } from "../middleware/validation.ts";
import { auditCaller } from "../audit-caller.ts";
import { AuthorizationError, ValidationError } from "../../utils/errors.ts";
import { grantInstanceAdmin, isInstanceAdmin, listInstanceAdmins, revokeInstanceAdmin } from "../../core/instance/admins.ts";
import { previewLicense, sendTestEmail, testStorage } from "../../core/instance/checks.ts";
import { describeInstanceSettings, updateInstanceSettings } from "../../core/instance/settings-admin.ts";
import { confirmRootKeyBackup, instanceStatus } from "../../core/instance/status.ts";
import { telemetryPreview } from "../../core/instance/telemetry.ts";
import { pathParam } from "../params.ts";

const instanceRouter = new Hono();

async function requireInstanceAdmin(c: Context, next: Next) {
  if (!(await isInstanceAdmin(c.get("userId") as string))) {
    throw new AuthorizationError("Only an instance admin can view or change this server's settings");
  }
  await next();
}

instanceRouter.use("*", requireSession);
instanceRouter.use("*", requireInstanceAdmin);

const settingsSchema = z.object({
  values: z.record(z.string().min(1).max(100), z.string().max(8192).nullable()),
});
const testEmailSchema = z.object({ to: z.string().trim().email().max(320) });
const licenseSchema = z.object({ key: z.string().trim().min(1).max(8192) });
const grantSchema = z.object({ email: z.string().trim().email().max(320) });

instanceRouter.get("/status", async (c: Context) => c.json({ success: true, data: await instanceStatus() }));

instanceRouter.post("/root-key/backup-confirmation", async (c: Context) => {
  const data = await confirmRootKeyBackup(c.get("userId") as string, auditCaller(c).context);
  return c.json({ success: true, data });
});

instanceRouter.get("/settings", (c: Context) => c.json({ success: true, data: { settings: describeInstanceSettings() } }));

instanceRouter.patch("/settings", validateBody(settingsSchema), async (c: Context) => {
  const { values } = c.get("validatedBody") as z.infer<typeof settingsSchema>;
  const changed = await updateInstanceSettings(values, c.get("userId") as string, auditCaller(c).context, async (clean) => {
    const key = clean["license.key"];
    if (key) {
      const preview = previewLicense(key);
      if (!preview.valid && !preview.tier) throw new ValidationError("The licence key is not valid", { "license.key": preview.message });
    }
  });
  return c.json({ success: true, data: { changed, settings: describeInstanceSettings() } });
});

instanceRouter.post("/settings/email/test", validateBody(testEmailSchema), async (c: Context) => {
  const { to } = c.get("validatedBody") as z.infer<typeof testEmailSchema>;
  return c.json({ success: true, data: await sendTestEmail(to) });
});

instanceRouter.post("/settings/storage/test", async (c: Context) => c.json({ success: true, data: await testStorage() }));

instanceRouter.post("/license/preview", validateBody(licenseSchema), async (c: Context) => {
  const { key } = c.get("validatedBody") as z.infer<typeof licenseSchema>;
  return c.json({ success: true, data: previewLicense(key) });
});

instanceRouter.get("/telemetry/preview", async (c: Context) => c.json({ success: true, data: await telemetryPreview() }));

instanceRouter.get("/admins", async (c: Context) => c.json({ success: true, data: { admins: await listInstanceAdmins() } }));

instanceRouter.post("/admins", validateBody(grantSchema), async (c: Context) => {
  const { email } = c.get("validatedBody") as z.infer<typeof grantSchema>;
  const admin = await grantInstanceAdmin(email, c.get("userId") as string, auditCaller(c).context);
  return c.json({ success: true, data: admin }, 201);
});

instanceRouter.delete("/admins/:userId", async (c: Context) => {
  const userId = pathParam(c, "userId");
  if (!userId || userId.length > 100) throw new ValidationError("A user id is required");
  await revokeInstanceAdmin(userId, c.get("userId") as string, auditCaller(c).context);
  return c.json({ success: true, data: { revoked: true } });
});

export default instanceRouter;
