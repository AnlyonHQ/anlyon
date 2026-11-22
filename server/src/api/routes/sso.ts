import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { requirePermission, requireSession, requireWorkspaceAccess } from "../middleware/auth.ts";
import { validateBody } from "../middleware/validation.ts";
import { isFeatureEnabled, type EnterpriseFeature } from "../../core/edition/features.ts";
import { provisionableRoleSchema } from "../../core/workspace/provisioned-roles.ts";
import { resolveMemberRole } from "../../core/workspace/roles.ts";
import {
  createSsoConnection,
  deleteSsoConnection,
  getSsoConnection,
  updateSsoConnection,
  verifySsoDomains,
} from "../../core/sso/service.ts";
import {
  getScimSettings,
  issueScimToken,
  replaceRoleMappings,
  revokeScimToken,
  updateScimDefaultRole,
} from "../../core/scim/settings.ts";
import { reapplyDirectoryRoles } from "../../core/scim/service.ts";
import { ApiError, AuthorizationError, NotFoundError } from "../../utils/errors.ts";
import { auditCaller } from "../audit-caller.ts";
import { requireTeamFeature } from "../middleware/team-feature.ts";
import { assertTeamFeature } from "../../core/billing/team-features.ts";

const identity = new Hono();

function requireEdition(feature: EnterpriseFeature) {
  return async (_c: Context, next: Next) => {
    if (!isFeatureEnabled(feature)) throw new NotFoundError("Endpoint");
    await next();
  };
}

const sso = [requireEdition("sso"), requireSession, requireWorkspaceAccess, requirePermission("identity.manage")] as const;
const scim = [requireEdition("scim"), requireSession, requireWorkspaceAccess, requirePermission("identity.manage")] as const;

async function assertEmergencyAccess(c: Context, action: string): Promise<void> {
  const resolved = await resolveMemberRole(c.get("workspaceId"), c.get("userId"));
  if (!resolved?.emergencyAccess) {
    throw new AuthorizationError(`Only an admin with emergency access can ${action}`);
  }
}

const domainsSchema = z.array(z.string().min(1).max(253)).min(1).max(20);

const createSsoSchema = z.discriminatedUnion("protocol", [
  z.object({
    protocol: z.literal("oidc"),
    domains: domainsSchema,
    defaultRole: provisionableRoleSchema.optional().default("member"),
    oidc: z.object({
      issuer: z.string().url().max(500),
      clientId: z.string().min(1).max(500),
      clientSecret: z.string().min(1).max(2000),
    }),
  }),
  z.object({
    protocol: z.literal("saml"),
    domains: domainsSchema,
    defaultRole: provisionableRoleSchema.optional().default("member"),
    saml: z.object({
      entityId: z.string().url().max(500),
      ssoUrl: z.string().url().max(2000),
      certificate: z.string().min(20).max(20_000),
      emailAttribute: z.string().min(1).max(300).optional(),
      nameAttribute: z.string().min(1).max(300).optional(),
    }),
  }),
]);

const updateSsoSchema = z
  .object({
    enforced: z.boolean().optional(),
    defaultRole: provisionableRoleSchema.optional(),
  })
  .refine((value) => value.enforced !== undefined || value.defaultRole !== undefined, {
    message: "Provide enforced or defaultRole",
  });

const updateScimSchema = z.object({ defaultRole: provisionableRoleSchema });

const roleMappingsSchema = z.object({
  mappings: z
    .array(
      z.object({
        groupName: z.string().min(1).max(256),
        role: provisionableRoleSchema,
        priority: z.number().int().min(-1000).max(1000).optional(),
      }),
    )
    .max(100),
});

identity.get("/:workspaceId/sso", requireSession, requireWorkspaceAccess, requirePermission("identity.manage"), async (c: Context) => {
  const connection = await getSsoConnection(c.get("workspaceId"));
  if (!isFeatureEnabled("sso")) {
    if (connection?.enforced) {
      throw new ApiError(
        404,
        "SSO_ENFORCEMENT_SUSPENDED",
        "Single sign-on is not part of this deployment's edition, so it is no longer required: members can sign in with a password or social login again.",
      );
    }
    throw new ApiError(404, "FEATURE_NOT_IN_EDITION", "Single sign-on is not part of this deployment's edition");
  }
  return c.json({ success: true, data: connection });
});

identity.post("/:workspaceId/sso", ...sso, requireTeamFeature("sso"), validateBody(createSsoSchema), async (c: Context) => {
  const connection = await createSsoConnection(
    c.get("workspaceId"),
    c.get("userId"),
    c.req.raw.headers,
    c.get("validatedBody"),
    auditCaller(c).context,
  );
  return c.json({ success: true, data: connection }, 201);
});

identity.post("/:workspaceId/sso/verify-domains", ...sso, requireTeamFeature("sso"), async (c: Context) => {
  return c.json({ success: true, data: await verifySsoDomains(c.get("workspaceId"), c.get("userId"), undefined, auditCaller(c).context) });
});

identity.patch("/:workspaceId/sso", ...sso, validateBody(updateSsoSchema), async (c: Context) => {
  const body = c.get("validatedBody") as z.infer<typeof updateSsoSchema>;
  const relaxOnly = body.enforced === false && body.defaultRole === undefined;
  if (!relaxOnly) await assertTeamFeature(c.get("workspaceId"), "sso");
  if (body.enforced !== undefined) await assertEmergencyAccess(c, "change whether single sign-on is required");
  return c.json({ success: true, data: await updateSsoConnection(c.get("workspaceId"), c.get("userId"), body, auditCaller(c).context) });
});

identity.delete("/:workspaceId/sso", ...sso, async (c: Context) => {
  const current = await getSsoConnection(c.get("workspaceId"));
  if (current?.enforced) await assertEmergencyAccess(c, "remove a required identity provider");
  await deleteSsoConnection(c.get("workspaceId"), c.get("userId"), auditCaller(c).context);
  return c.json({ success: true, data: { message: "Identity provider removed" } });
});

identity.get("/:workspaceId/scim", ...scim, async (c: Context) => {
  return c.json({ success: true, data: await getScimSettings(c.get("workspaceId")) });
});

identity.patch("/:workspaceId/scim", ...scim, requireTeamFeature("scim"), validateBody(updateScimSchema), async (c: Context) => {
  const { defaultRole } = c.get("validatedBody") as z.infer<typeof updateScimSchema>;
  await updateScimDefaultRole(c.get("workspaceId"), c.get("userId"), defaultRole, auditCaller(c).context);
  await reapplyDirectoryRoles(c.get("workspaceId"));
  return c.json({ success: true, data: await getScimSettings(c.get("workspaceId")) });
});

identity.post("/:workspaceId/scim/token", ...scim, requireTeamFeature("scim"), async (c: Context) => {
  const { token, settings } = await issueScimToken(c.get("workspaceId"), c.get("userId"), auditCaller(c).context);
  return c.json({ success: true, data: { token, settings } }, 201);
});

identity.delete("/:workspaceId/scim/token", ...scim, async (c: Context) => {
  await revokeScimToken(c.get("workspaceId"), c.get("userId"), auditCaller(c).context);
  return c.json({ success: true, data: { message: "SCIM token revoked" } });
});

identity.put("/:workspaceId/scim/role-mappings", ...scim, requireTeamFeature("scim"), validateBody(roleMappingsSchema), async (c: Context) => {
  const { mappings } = c.get("validatedBody") as z.infer<typeof roleMappingsSchema>;
  await replaceRoleMappings(c.get("workspaceId"), c.get("userId"), mappings, auditCaller(c).context);
  await reapplyDirectoryRoles(c.get("workspaceId"));
  return c.json({ success: true, data: await getScimSettings(c.get("workspaceId")) });
});

export default identity;
