import { Hono, type Context } from "hono";
import {
  assertCallerPermission,
  requireApiKey,
  requireApiKeyResourceScopes,
  requireApiKeyScope,
  requirePermissionForWrites,
} from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody } from "../middleware/validation.ts";
import { putSecretSchema, secretNameSchema } from "../../utils/validation.ts";
import {
  assertSecretWillBeBound,
  checkExternalSecret,
  deleteSecret,
  getSecretMetadata,
  listSecrets,
  putExternalSecret,
  putSecret,
} from "../../core/actions/secrets.ts";
import { assertSecretStoresAvailable } from "../../core/secret-stores/service.ts";
import { ValidationError } from "../../utils/errors.ts";
import { resolveEnvironmentId } from "./environment-context.ts";
import { pathParam } from "../params.ts";
import { signOffIfLoosening } from "../governance-gate.ts";

const secretsRouter = new Hono();

secretsRouter.use("*", requireApiKey);
secretsRouter.use("*", requireApiKeyResourceScopes("secrets:read", "secrets:write"));
secretsRouter.use("*", requirePermissionForWrites("connections.manage"));
secretsRouter.use("*", rateLimitByWorkspace);

function requireName(c: Context): string {
  const parsed = secretNameSchema.safeParse(pathParam(c, "name"));
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid secret name");
  }
  return parsed.data;
}

secretsRouter.get("/", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const secrets = await listSecrets(workspaceId, await resolveEnvironmentId(c));
  return c.json({ success: true, data: secrets });
});

secretsRouter.get("/:name", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const secret = await getSecretMetadata(workspaceId, requireName(c), await resolveEnvironmentId(c));
  return c.json({ success: true, data: secret });
});

secretsRouter.put("/:name", validateBody(putSecretSchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const { value, external, ...rest } = c.get("validatedBody");
  if (external) {
    assertSecretStoresAvailable();
    await requireApiKeyScope("secret-stores:write")(c, async () => undefined);
    await assertCallerPermission(c, "secret-stores.manage");
  }
  if (!external) await assertSecretWillBeBound(workspaceId, requireName(c), rest, await resolveEnvironmentId(c));
  await resolveEnvironmentId(c);
  const pending = await signOffIfLoosening(c, "secret.put", { name: requireName(c) }, c.get("validatedBody"));
  if (pending) return pending;
  if (external) {
    const { secret, warning } = await putExternalSecret(workspaceId, requireName(c), { external, ...rest }, await resolveEnvironmentId(c));
    return c.json({ success: true, data: secret, ...(warning ? { warning } : {}) });
  }
  const secret = await putSecret(workspaceId, requireName(c), { value, ...rest }, await resolveEnvironmentId(c));
  return c.json({ success: true, data: secret });
});

secretsRouter.post("/:name/check", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const secret = await checkExternalSecret(workspaceId, await resolveEnvironmentId(c), requireName(c));
  return c.json({ success: true, data: secret });
});

secretsRouter.delete("/:name", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  await deleteSecret(workspaceId, requireName(c), await resolveEnvironmentId(c), {
    confirmProtected: c.req.query("confirmProtected") === "true",
  });
  return c.json({ success: true, data: { deleted: true } });
});

export default secretsRouter;
