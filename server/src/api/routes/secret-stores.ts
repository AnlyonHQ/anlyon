import { Hono, type Context, type Next } from "hono";
import { requireApiKey, requireApiKeyResourceScopes, requirePermission } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody } from "../middleware/validation.ts";
import {
  createSecretStoreSchema,
  secretStoreNameSchema,
  updateSecretStoreSchema,
  updateSecretStoreSettingsSchema,
} from "../../utils/validation.ts";
import {
  BYO_VAULT_FEATURE,
  checkSecretStore,
  createSecretStore,
  deleteSecretStore,
  getSecretStore,
  getSecretStoreSettings,
  listSecretStores,
  updateSecretStore,
  updateSecretStoreSettings,
} from "../../core/secret-stores/service.ts";
import { isFeatureEnabled } from "../../core/edition/features.ts";
import { NotFoundError, ValidationError } from "../../utils/errors.ts";
import { resolveEnvironmentId } from "./environment-context.ts";
import { pathParam } from "../params.ts";
import { requireTeamFeature } from "../middleware/team-feature.ts";
import { signOffIfLoosening } from "../governance-gate.ts";

const secretStoresRouter = new Hono();

async function requireByoVault(_c: Context, next: Next) {
  if (!isFeatureEnabled(BYO_VAULT_FEATURE)) throw new NotFoundError("Endpoint");
  await next();
}

secretStoresRouter.use("*", requireByoVault);
secretStoresRouter.use("*", requireApiKey);
secretStoresRouter.use("*", requireApiKeyResourceScopes("secret-stores:read", "secret-stores:write"));
secretStoresRouter.use("*", rateLimitByWorkspace);

function requireName(c: Context): string {
  const parsed = secretStoreNameSchema.safeParse(pathParam(c, "name"));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid store name");
  return parsed.data;
}

async function scopeOf(c: Context) {
  return { workspaceId: c.get("workspaceId") as string, environmentId: await resolveEnvironmentId(c) };
}

secretStoresRouter.get("/", async (c: Context) => {
  return c.json({ success: true, data: await listSecretStores(await scopeOf(c)) });
});

secretStoresRouter.get("/:name", async (c: Context) => {
  return c.json({ success: true, data: await getSecretStore(await scopeOf(c), requireName(c)) });
});

secretStoresRouter.post("/", requirePermission("secret-stores.manage"), requireTeamFeature("byo_vault"), validateBody(createSecretStoreSchema), async (c: Context) => {
  await scopeOf(c);
  const pending = await signOffIfLoosening(c, "secret_store.create", {}, c.get("validatedBody"));
  if (pending) return pending;
  const store = await createSecretStore(await scopeOf(c), c.get("validatedBody"));
  return c.json({ success: true, data: store }, 201);
});

secretStoresRouter.patch("/:name", requirePermission("secret-stores.manage"), requireTeamFeature("byo_vault"), validateBody(updateSecretStoreSchema), async (c: Context) => {
  await scopeOf(c);
  const pending = await signOffIfLoosening(c, "secret_store.update", {
    name: requireName(c), confirmProtected: c.req.query("confirmProtected") === "true" ? "true" : "false",
  }, c.get("validatedBody"));
  if (pending) return pending;
  const store = await updateSecretStore(await scopeOf(c), requireName(c), c.get("validatedBody"), {
    confirmProtected: c.req.query("confirmProtected") === "true",
  });
  return c.json({ success: true, data: store });
});

secretStoresRouter.post("/:name/check", requirePermission("secret-stores.manage"), async (c: Context) => {
  return c.json({ success: true, data: await checkSecretStore(await scopeOf(c), requireName(c)) });
});

secretStoresRouter.delete("/:name", requirePermission("secret-stores.manage"), async (c: Context) => {
  await deleteSecretStore(await scopeOf(c), requireName(c), {
    confirmProtected: c.req.query("confirmProtected") === "true",
  });
  return c.json({ success: true, data: { deleted: true } });
});

export const secretStoreSettingsRouter = new Hono();

secretStoreSettingsRouter.use("*", requireByoVault);
secretStoreSettingsRouter.use("*", requireApiKey);
secretStoreSettingsRouter.use("*", requireApiKeyResourceScopes("secret-stores:read", "secret-stores:write"));
secretStoreSettingsRouter.use("*", rateLimitByWorkspace);

secretStoreSettingsRouter.get("/", async (c: Context) => {
  return c.json({ success: true, data: await getSecretStoreSettings(c.get("workspaceId")) });
});

secretStoreSettingsRouter.put("/", requirePermission("secret-stores.manage"), validateBody(updateSecretStoreSettingsSchema), async (c: Context) => {
  const pending = await signOffIfLoosening(c, "secret_store_settings.update", {}, c.get("validatedBody"));
  if (pending) return pending;
  const settings = await updateSecretStoreSettings(
    c.get("workspaceId"),
    c.get("validatedBody"),
    (c.get("userId") as string | undefined) ?? null,
  );
  return c.json({ success: true, data: settings });
});

export default secretStoresRouter;
