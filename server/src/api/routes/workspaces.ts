import { Hono } from "hono";
import type { Context, Next } from "hono";
import { auditCaller, auditRequest } from "../audit-caller.ts";
import { assertCallerPermission, requireSession, requireWorkspaceAccess, requirePermission } from "../middleware/auth.ts";
import { validateBody, validateQuery } from "../middleware/validation.ts";
import { versionPageResponse, versionParam } from "../policy-versions.ts";
import { createWorkspaceSchema, updateWorkspaceDefaultsSchema, updateWorkspaceSchema } from "../../utils/validation.ts";
import { getWorkspaceDefaults, updateWorkspaceDefaults } from "../../core/workspace/defaults.ts";
import {
  createWorkspace,
  getWorkspace,
  getUserWorkspaces,
  updateWorkspace,
  deleteWorkspace,
} from "../../core/workspace/service.ts";
import { toPublicWorkspace } from "../../core/workspace/public-workspace.ts";
import { NotFoundError } from "../../utils/errors.ts";
import { validateUUID } from "../../utils/uuid-validator.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ module: "workspaces-route" });
import {
  createApiKey,
  listApiKeys,
  deleteApiKey,
  regenerateApiKey,
  rollbackApiKey,
  getApiKeyHistory,
  getApiKey,
} from "../../core/auth/api-keys.ts";
import {
  createDeliverySecret,
  getDeliverySecretInfo,
  regenerateDeliverySecret,
} from "../../core/auth/delivery-secrets.ts";
import {
  createApiKeySchema,
  createEnvironmentSchema,
  updateEnvironmentSchema,
  haltEnvironmentSchema,
  deleteEnvironmentSchema,
  createAgentSchema,
  createAgentVersionSchema,
  updateAgentSchema,
} from "../../utils/validation.ts";
import {
  listEnvironments,
  getEnvironment,
  createEnvironment,
  updateEnvironment,
  deleteEmptyEnvironment,
  toPublicEnvironment,
} from "../../core/environments/service.ts";
import { haltEnvironment, resumeEnvironment } from "../../core/environments/halt.ts";
import {
  createAgent,
  listAgents,
  getAgent,
  updateAgent,
  createAgentVersion,
  listAgentVersions,
  getAgentVersion,
  promoteAgent,
} from "../../core/agents/service.ts";
import {
  createPolicy,
  listPolicies,
  getPolicy,
  updatePolicy,
  deletePolicy,
  listPolicyVersions,
  getPolicyVersion,
  assistCondition,
} from "../../core/approvals/policy.ts";
import { policyActor } from "../policy-actor.ts";
import { draftCondition } from "../../core/approvals/condition-draft.ts";
import {
  adviceAuditSchema,
  assistantSettingsSchema,
  createApprovalPolicySchema,
  conditionAssistSchema,
  conditionDraftSchema,
  sessionPolicyVersionsQuerySchema,
  updateApprovalPolicySchema,
  promoteAgentSchema,
} from "../../utils/validation.ts";
import { pathParam } from "../params.ts";
import { refuseUnknownApiKeyScopes } from "../scope-input.ts";
import { requireFeature } from "../middleware/feature-gate.ts";
import {
  getAssistantSettings,
  listAuditQueue,
  recordAuditVerdict,
  updateAssistantSettings,
} from "../../core/assistant/service.ts";
import { getAssistantUsage } from "../../core/assistant/usage.ts";
import { acceptPolicySuggestion, listPolicySuggestions } from "../../core/assistant/policy-suggestions.ts";

const workspaces = new Hono({ strict: false });
const getApiKeyId = (c: Context) => validateUUID(pathParam(c, "keyId"), "API key ID");

workspaces.get("/", requireSession, async (c:Context) => {
  const userId = c.get("userId");
  const userWorkspaces = await getUserWorkspaces(userId);

  return c.json({
    success: true,
    data: userWorkspaces.map(({ workspace, role, joinedAt }) => ({
      workspace: toPublicWorkspace(workspace),
      role,
      joinedAt,
    })),
  });
});

workspaces.post("/", requireSession, validateBody(createWorkspaceSchema), async (c:Context) => {
  const userId = c.get("userId");
  const body = c.get("validatedBody");

  logger.info({ userId, body }, "Creating workspace - validated body");

  const workspace = await createWorkspace(userId, body);
  c.header("Cache-Control", "no-store");

  logger.info({ userId, workspaceId: workspace.id, name: workspace.name, slug: workspace.slug }, "Workspace created successfully");

  return c.json({
    success: true,
    data: {
      ...toPublicWorkspace(workspace),
      credentials: workspace.credentials,
    },
  });
});

workspaces.get("/:workspaceId", requireSession, requireWorkspaceAccess, async (c:Context) => {
  const workspaceId = pathParam(c, "workspaceId");
  const userId = c.get("userId");

  const { workspace, role } = await getWorkspace(workspaceId, userId);

  return c.json({
    success: true,
    data: {
      workspace: toPublicWorkspace(workspace),
      role,
    },
  });
});

workspaces.patch(
  "/:workspaceId",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("workspace.update"),
  validateBody(updateWorkspaceSchema),
  async (c:Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const userId = c.get("userId");
    const body = c.get("validatedBody");

    const workspace = await updateWorkspace(workspaceId, userId, body);

    return c.json({
      success: true,
      data: toPublicWorkspace(workspace),
    });
  }
);

workspaces.delete("/:workspaceId", requireSession, requireWorkspaceAccess, requirePermission("workspace.delete"), async (c:Context) => {
  const workspaceId = pathParam(c, "workspaceId");
  const userId = c.get("userId");

  await deleteWorkspace(workspaceId, userId);

  return c.json({
    success: true,
    data: {
      message: "Workspace deleted successfully",
    },
  });
});

workspaces.get("/:workspaceId/defaults", requireSession, requireWorkspaceAccess, async (c: Context) => {
  return c.json({ success: true, data: await getWorkspaceDefaults(pathParam(c, "workspaceId")) });
});

workspaces.patch(
  "/:workspaceId/defaults",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("workspace.update"),
  validateBody(updateWorkspaceDefaultsSchema),
  async (c: Context) => {
    const { source, ...patch } = c.get("validatedBody");
    const caller = auditCaller(c);
    const defaults = await updateWorkspaceDefaults(pathParam(c, "workspaceId"), c.get("userId") ?? null, patch, {
      actor: caller.actor,
      context: caller.context,
      source,
    });
    return c.json({ success: true, data: defaults });
  },
);

workspaces.get("/:workspaceId/api-keys", requireSession, requireWorkspaceAccess, async (c:Context) => {
  const workspaceId = pathParam(c, "workspaceId");
  const keys = await listApiKeys(workspaceId);

  return c.json({
    success: true,
    data: keys,
  });
});

workspaces.post(
  "/:workspaceId/api-keys",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("keys.manage"),
  refuseUnknownApiKeyScopes,
  validateBody(createApiKeySchema),
  async (c:Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const userId = c.get("userId");
    const { name, expiresAt, scopes, environmentId, endUserRequired } = c.get("validatedBody");

    const result = await createApiKey(
      workspaceId,
      userId,
      name,
      expiresAt ? new Date(expiresAt) : undefined,
      scopes,
      environmentId,
      { context: auditCaller(c).context },
      { endUserRequired },
    );
    c.header("Cache-Control", "no-store");

    return c.json({
      success: true,
      data: result,
    });
  }
);

workspaces.get(
  "/:workspaceId/environments",
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const envs = await listEnvironments(workspaceId);
    return c.json({ success: true, data: envs.map(toPublicEnvironment) });
  },
);

workspaces.post(
  "/:workspaceId/environments",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("environments.manage"),
  validateBody(createEnvironmentSchema),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const { name, slug, kind, isProtected } = c.get("validatedBody");
    const env = await createEnvironment(workspaceId, { name, slug, kind, isProtected });
    return c.json({ success: true, data: toPublicEnvironment(env) }, 201);
  },
);

workspaces.get(
  "/:workspaceId/environments/:environmentId",
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const environmentId = validateUUID(pathParam(c, "environmentId"), "Environment ID");
    const env = await getEnvironment(workspaceId, environmentId);
    return c.json({ success: true, data: toPublicEnvironment(env) });
  },
);

workspaces.patch(
  "/:workspaceId/environments/:environmentId",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("environments.manage"),
  validateBody(updateEnvironmentSchema),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const environmentId = validateUUID(pathParam(c, "environmentId"), "Environment ID");
    const { name, kind, isDefault, isProtected, confirmProtected, allowedRedirectUrls, defaultRedirectUrl, connectConfirmation } = c.get("validatedBody");
    const before = await getEnvironment(workspaceId, environmentId);
    const env = await updateEnvironment(workspaceId, environmentId, {
      name,
      kind,
      isDefault,
      isProtected,
      confirmProtected,
      allowedRedirectUrls,
      defaultRedirectUrl,
      connectConfirmation,
    });
    if (connectConfirmation !== undefined && connectConfirmation !== before.connectConfirmation) {
      auditRequest(c, {
        workspaceId, environmentId, type: "environment.connect_confirmation_changed",
        resource: { type: "environment", id: environmentId }, data: { connectConfirmation },
      });
    }
    if (allowedRedirectUrls !== undefined || defaultRedirectUrl !== undefined) {
      auditRequest(c, {
        workspaceId, environmentId, type: "environment.redirects_updated",
        resource: { type: "environment", id: environmentId },
        data: { allowedRedirectUrls: env.allowedRedirectUrls, defaultRedirectUrl: env.defaultRedirectUrl },
      });
    }
    return c.json({ success: true, data: toPublicEnvironment(env) });
  },
);

workspaces.delete(
  "/:workspaceId/environments/:environmentId",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("environments.delete"),
  validateBody(deleteEnvironmentSchema),
  async (c: Context) => {
    await deleteEmptyEnvironment(pathParam(c, "workspaceId"),
      validateUUID(pathParam(c, "environmentId"), "Environment ID"), c.get("validatedBody").confirmSlug);
    return c.json({ success: true, data: { deleted: true } });
  },
);

workspaces.post(
  "/:workspaceId/environments/:environmentId/halt",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("environments.halt", { environmentId: (c) => pathParam(c, "environmentId") }),
  validateBody(haltEnvironmentSchema),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const environmentId = validateUUID(pathParam(c, "environmentId"), "Environment ID");
    const { reason } = c.get("validatedBody");
    const env = await haltEnvironment(workspaceId, environmentId, {
      reason,
      actor: c.get("userId"),
      context: auditCaller(c).context,
    });
    return c.json({ success: true, data: toPublicEnvironment(env) });
  },
);

workspaces.post(
  "/:workspaceId/environments/:environmentId/resume",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("environments.resume", { environmentId: (c) => pathParam(c, "environmentId") }),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const environmentId = validateUUID(pathParam(c, "environmentId"), "Environment ID");
    const env = await resumeEnvironment(workspaceId, environmentId, { actor: c.get("userId"), context: auditCaller(c).context });
    return c.json({ success: true, data: toPublicEnvironment(env) });
  },
);

workspaces.get("/:workspaceId/agents", requireSession, requireWorkspaceAccess, async (c: Context) => {
  const workspaceId = pathParam(c, "workspaceId");
  const environmentId = c.req.query("environmentId");
  const list = await listAgents(workspaceId, environmentId);
  return c.json({ success: true, data: list });
});

workspaces.post(
  "/:workspaceId/agents",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("agents.manage"),
  validateBody(createAgentSchema),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const userId = c.get("userId");
    const { name, description, environmentId, config } = c.get("validatedBody");
    const result = await createAgent(workspaceId, { name, description, environmentId, config }, userId);
    return c.json({ success: true, data: result }, 201);
  },
);

workspaces.get("/:workspaceId/agents/:agentId", requireSession, requireWorkspaceAccess, async (c: Context) => {
  const workspaceId = pathParam(c, "workspaceId");
  const agent = await getAgent(workspaceId, pathParam(c, "agentId"));
  return c.json({ success: true, data: agent });
});

workspaces.patch(
  "/:workspaceId/agents/:agentId",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("agents.manage"),
  validateBody(updateAgentSchema),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const agent = await updateAgent(workspaceId, pathParam(c, "agentId"), c.get("validatedBody"));
    return c.json({ success: true, data: agent });
  },
);

workspaces.post(
  "/:workspaceId/agents/:agentId/versions",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("agents.manage"),
  validateBody(createAgentVersionSchema),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const userId = c.get("userId");
    const { config, publish } = c.get("validatedBody");
    const version = await createAgentVersion(workspaceId, pathParam(c, "agentId"), { config, publish }, userId);
    return c.json({ success: true, data: version }, 201);
  },
);

workspaces.get(
  "/:workspaceId/agents/:agentId/versions",
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const versions = await listAgentVersions(workspaceId, pathParam(c, "agentId"));
    return c.json({ success: true, data: versions });
  },
);

workspaces.post(
  "/:workspaceId/agents/:agentId/promote",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("agents.manage"),
  validateBody(promoteAgentSchema),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const userId = c.get("userId");
    const { targetEnvironmentId, confirmProtected } = c.get("validatedBody");
    const result = await promoteAgent(workspaceId, pathParam(c, "agentId"), targetEnvironmentId, userId, {
      confirmProtected,
    });
    return c.json({ success: true, data: result }, 201);
  },
);

workspaces.get(
  "/:workspaceId/agents/:agentId/versions/:version",
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const version = Number(pathParam(c, "version"));
    if (!Number.isInteger(version) || version < 1) throw new NotFoundError("Agent version not found");
    const result = await getAgentVersion(workspaceId, pathParam(c, "agentId"), version);
    return c.json({ success: true, data: result });
  },
);

async function requirePolicyPermissionInItsEnvironment(c: Context, next: Next) {
  const policy = await getPolicy(c.req.param("workspaceId") ?? "", c.req.param("policyId") ?? "");
  await assertCallerPermission(c, "policies.manage", policy.environmentId);
  await next();
}

workspaces.get(
  "/:workspaceId/approval-policies",
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const policies = await listPolicies(workspaceId, c.req.query("environmentId"));
    return c.json({ success: true, data: policies });
  },
);

workspaces.post(
  "/:workspaceId/approval-policies",
  requireSession,
  requireWorkspaceAccess,
  validateBody(createApprovalPolicySchema),
  requirePermission("policies.manage", { environmentId: (c) => c.get("validatedBody").environmentId }),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const policy = await createPolicy(workspaceId, c.get("validatedBody"), { actor: policyActor(c) });
    return c.json({ success: true, data: policy }, 201);
  },
);

workspaces.get(
  "/:workspaceId/approval-policies/:policyId",
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const policy = await getPolicy(workspaceId, pathParam(c, "policyId"));
    return c.json({ success: true, data: policy });
  },
);

workspaces.get(
  "/:workspaceId/approval-policies/:policyId/versions",
  requireSession,
  requireWorkspaceAccess,
  validateQuery(sessionPolicyVersionsQuerySchema),
  async (c: Context) => {
    const query = c.get("validatedQuery");
    const page = await listPolicyVersions(
      pathParam(c, "workspaceId"), pathParam(c, "policyId"),
      query.environmentId ? { environmentId: query.environmentId } : {},
      { limit: query.limit, before: query.before },
    );
    return c.json(versionPageResponse(page, query.limit));
  },
);

workspaces.get(
  "/:workspaceId/approval-policies/:policyId/versions/:version",
  requireSession,
  requireWorkspaceAccess,
  validateQuery(sessionPolicyVersionsQuerySchema),
  async (c: Context) => {
    const { environmentId } = c.get("validatedQuery");
    const version = await getPolicyVersion(
      pathParam(c, "workspaceId"), pathParam(c, "policyId"), versionParam(c), environmentId ? { environmentId } : {},
    );
    return c.json({ success: true, data: version });
  },
);

workspaces.post(
  "/:workspaceId/approval-policies/condition-assist",
  requireSession,
  requireWorkspaceAccess,
  validateBody(conditionAssistSchema),
  async (c: Context) => {
    const result = await assistCondition(pathParam(c, "workspaceId"), c.get("validatedBody"));
    return c.json({ success: true, data: result });
  },
);

workspaces.post(
  "/:workspaceId/approval-policies/condition-draft",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("policies.manage"),
  validateBody(conditionDraftSchema),
  async (c: Context) => {
    const result = await draftCondition(pathParam(c, "workspaceId"), c.get("validatedBody"));
    return c.json({ success: true, data: result });
  },
);

workspaces.patch(
  "/:workspaceId/approval-policies/:policyId",
  requireSession,
  requireWorkspaceAccess,
  requirePolicyPermissionInItsEnvironment,
  validateBody(updateApprovalPolicySchema),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const policy = await updatePolicy(workspaceId, pathParam(c, "policyId"), c.get("validatedBody"), { actor: policyActor(c) });
    return c.json({ success: true, data: policy });
  },
);

workspaces.delete(
  "/:workspaceId/approval-policies/:policyId",
  requireSession,
  requireWorkspaceAccess,
  requirePolicyPermissionInItsEnvironment,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    await deletePolicy(workspaceId, pathParam(c, "policyId"), { actor: policyActor(c) });
    return c.json({ success: true, data: { deleted: true } });
  },
);

workspaces.get(
  "/:workspaceId/assistant",
  requireFeature("ai-assistant"),
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const [settings, usage] = await Promise.all([getAssistantSettings(workspaceId), getAssistantUsage(workspaceId)]);
    return c.json({ success: true, data: { ...settings, usage } });
  },
);

workspaces.put(
  "/:workspaceId/assistant",
  requireFeature("ai-assistant"),
  requireSession,
  requireWorkspaceAccess,
  requirePermission("assistant.manage"),
  validateBody(assistantSettingsSchema),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const settings = await updateAssistantSettings(workspaceId, c.get("validatedBody"), c.get("userId") ?? null);
    const usage = await getAssistantUsage(workspaceId);
    return c.json({ success: true, data: { ...settings, usage } });
  },
);

workspaces.get(
  "/:workspaceId/assistant/policy-suggestions",
  requireFeature("ai-assistant"),
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const suggestions = await listPolicySuggestions(pathParam(c, "workspaceId"));
    return c.json({ success: true, data: suggestions });
  },
);

workspaces.post(
  "/:workspaceId/assistant/policy-suggestions/:key/accept",
  requireFeature("ai-assistant"),
  requireSession,
  requireWorkspaceAccess,
  requirePermission("assistant.manage"),
  async (c: Context) => {
    const policies = await acceptPolicySuggestion(pathParam(c, "workspaceId"), pathParam(c, "key"));
    return c.json({ success: true, data: policies }, 201);
  },
);

workspaces.get(
  "/:workspaceId/assistant/audit-queue",
  requireFeature("ai-assistant"),
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const queue = await listAuditQueue(pathParam(c, "workspaceId"));
    return c.json({ success: true, data: queue });
  },
);

workspaces.post(
  "/:workspaceId/approvals/:approvalId/advice/audit",
  requireFeature("ai-assistant"),
  requireSession,
  requireWorkspaceAccess,
  requirePermission("assistant.manage"),
  validateBody(adviceAuditSchema),
  async (c: Context) => {
    const advice = await recordAuditVerdict(
      pathParam(c, "workspaceId"),
      pathParam(c, "approvalId"),
      c.get("validatedBody").verdict,
      c.get("userId"),
    );
    if (!advice) throw new NotFoundError("Assistant advice for this approval");
    return c.json({ success: true, data: advice });
  },
);

workspaces.delete("/:workspaceId/api-keys/:keyId", requireSession, requireWorkspaceAccess, requirePermission("keys.manage"), async (c) => {
  const workspaceId = pathParam(c, "workspaceId");
  const keyId = getApiKeyId(c);

  await deleteApiKey(keyId, workspaceId, auditCaller(c));

  return c.json({
    success: true,
    data: {
      message: "API key deleted successfully",
    },
  });
});

workspaces.get("/:workspaceId/api-keys/:keyId", requireSession, requireWorkspaceAccess, async (c: Context) => {
  const workspaceId = pathParam(c, "workspaceId");
  const keyId = getApiKeyId(c);

  const apiKey = await getApiKey(keyId, workspaceId);

  if (!apiKey) {
    throw new NotFoundError("API key");
  }

  return c.json({
    success: true,
    data: apiKey,
  });
});

workspaces.post(
  "/:workspaceId/api-keys/:keyId/regenerate",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("keys.manage"),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const keyId = getApiKeyId(c);
    const userId = c.get("userId");

    const result = await regenerateApiKey(keyId, workspaceId, userId, { context: auditCaller(c).context });
    c.header("Cache-Control", "no-store");

    return c.json({
      success: true,
      data: {
        apiKey: result.apiKey,
        key: result.key,
        rollbackExpiresAt: result.rollbackExpiresAt.toISOString(),
        message: "API key regenerated successfully. Save the new key - it will only be shown once!",
      },
    });
  }
);

workspaces.post(
  "/:workspaceId/api-keys/:keyId/rollback",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("keys.manage"),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const keyId = getApiKeyId(c);
    const userId = c.get("userId");

    const restoredKey = await rollbackApiKey(keyId, workspaceId, userId, { context: auditCaller(c).context });

    return c.json({
      success: true,
      data: {
        apiKey: restoredKey,
        message: "API key rolled back successfully. Your previous key is now active again.",
      },
    });
  }
);

workspaces.get(
  "/:workspaceId/api-keys/:keyId/history",
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const keyId = getApiKeyId(c);

    const history = await getApiKeyHistory(keyId, workspaceId);

    return c.json({
      success: true,
      data: history,
    });
  }
);

workspaces.get(
  "/:workspaceId/delivery-secret",
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");

    const secretInfo = await getDeliverySecretInfo(workspaceId);

    return c.json({
      success: true,
      data: secretInfo,
    });
  }
);

workspaces.post(
  "/:workspaceId/delivery-secret",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("keys.manage"),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const userId = c.get("userId");

    const result = await createDeliverySecret(workspaceId, userId);
    c.header("Cache-Control", "no-store");

    return c.json({
      success: true,
      data: result,
    });
  }
);

workspaces.post(
  "/:workspaceId/delivery-secret/regenerate",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("keys.manage"),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const userId = c.get("userId");

    const result = await regenerateDeliverySecret(workspaceId, userId);
    c.header("Cache-Control", "no-store");

    return c.json({
      success: true,
      data: result,
    });
  }
);

export default workspaces;
