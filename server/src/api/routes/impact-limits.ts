import { auditRequest } from "../audit-caller.ts";
import { Hono, type Context } from "hono";
import { requireApiKey, requireApiKeyResourceScopes, requirePermissionForWrites } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody } from "../middleware/validation.ts";
import { createImpactLimitSchema, updateImpactLimitSchema } from "../../utils/validation.ts";
import { archiveLimit, createLimit, getLimit, listLimits, updateLimit } from "../../core/effects/impact.ts";
import { pathParam } from "../params.ts";
import { listedEndUser } from "../end-user-context.ts";
import { parseEndUserId } from "../../core/end-users/identity.ts";
import { signOffIfLoosening } from "../governance-gate.ts";

const impactLimitsRouter = new Hono();

impactLimitsRouter.use("*", requireApiKey);
impactLimitsRouter.use("*", requireApiKeyResourceScopes("impact-limits:read", "impact-limits:write"));
impactLimitsRouter.use("*", requirePermissionForWrites("limits.manage"));
impactLimitsRouter.use("*", rateLimitByWorkspace);

impactLimitsRouter.get("/", async (c: Context) => {
  const limits = await listLimits(c.get("workspaceId"), c.get("environmentId") as string, {
    includeArchived: c.req.query("includeArchived") === "true",
    endUserId: queriedEndUser(c),
  });
  return c.json({ success: true, data: limits });
});

function queriedEndUser(c: Context): string | undefined {
  const raw = c.req.query("endUserId");
  return listedEndUser(c, raw === undefined ? undefined : parseEndUserId(raw, "endUserId"));
}

impactLimitsRouter.post("/", validateBody(createImpactLimitSchema), async (c: Context) => {
  const limit = await createLimit(c.get("workspaceId"), c.get("environmentId") as string, c.get("validatedBody"));
  auditRequest(c, {
    workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") as string, type: "impact_limit.created",
    resource: { type: "impact_limit", id: limit.id }, data: limitAuditData(limit),
  });
  return c.json({ success: true, data: limit }, 201);
});

impactLimitsRouter.get("/:id", async (c: Context) => {
  const limit = await getLimit(c.get("workspaceId"), c.get("environmentId") as string, pathParam(c, "id"), queriedEndUser(c));
  return c.json({ success: true, data: limit });
});

impactLimitsRouter.patch("/:id", validateBody(updateImpactLimitSchema), async (c: Context) => {
  const pending = await signOffIfLoosening(c, "impact_limit.update", { id: pathParam(c, "id") }, c.get("validatedBody"));
  if (pending) return pending;
  const limit = await updateLimit(c.get("workspaceId"), c.get("environmentId") as string, pathParam(c, "id"), c.get("validatedBody"));
  auditRequest(c, {
    workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") as string, type: "impact_limit.updated",
    resource: { type: "impact_limit", id: limit.id }, data: limitAuditData(limit),
  });
  return c.json({ success: true, data: limit });
});

impactLimitsRouter.delete("/:id", async (c: Context) => {
  const pending = await signOffIfLoosening(c, "impact_limit.archive", { id: pathParam(c, "id") }, {});
  if (pending) return pending;
  const limit = await archiveLimit(c.get("workspaceId"), c.get("environmentId") as string, pathParam(c, "id"));
  auditRequest(c, {
    workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") as string, type: "impact_limit.archived",
    resource: { type: "impact_limit", id: limit.id }, data: limitAuditData(limit),
  });
  return c.json({ success: true, data: limit });
});

function limitAuditData(limit: { id: string; name: string; dimension: string; currency: string | null; scope: unknown; period: unknown; limit: number }) {
  return { limitId: limit.id, name: limit.name, dimension: limit.dimension, currency: limit.currency, scope: limit.scope, period: limit.period, limit: limit.limit };
}

export default impactLimitsRouter;
