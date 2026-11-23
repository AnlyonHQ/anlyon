import { Hono, type Context } from "hono";
import { auditCaller } from "../audit-caller.ts";
import { requirePermission, requireSession, requireWorkspaceAccess } from "../middleware/auth.ts";
import { validateBody } from "../middleware/validation.ts";
import { z } from "zod";
import {
  updateMemberRole,
  removeMember,
  leaveWorkspace,
  handOverEmergencyAccess,
  setEmergencyAccess,
  getMemberDetails,
  listMembersWithDetails,
} from "../../core/workspace/members.ts";
import { ENVIRONMENT_ROLES } from "../../core/workspace/permissions.ts";
import { refuseRetiredOwnerRole, roleInputSchema } from "../role-input.ts";
import {
  describeCallerPermissions,
  listEnvironmentRoles,
  listWorkspaceEnvironmentRoles,
  removeEnvironmentRole,
  setEnvironmentRole,
} from "../../core/workspace/roles.ts";
import { validateUUID } from "../../utils/uuid-validator.ts";
import { pathParam } from "../params.ts";
import { ApiError } from "../../utils/errors.ts";
import { requireTeamFeature } from "../middleware/team-feature.ts";

const members = new Hono();

const updateRoleSchema = z.object({
  role: roleInputSchema,
});

const emergencyAccessSchema = z.object({
  enabled: z.boolean(),
});

const environmentRoleSchema = z.object({
  role: z.enum(ENVIRONMENT_ROLES),
});

const transferOwnershipSchema = z.object({
  newOwnerId: z.string().min(1).max(100),
});

members.get("/:workspaceId/members", requireSession, requireWorkspaceAccess, async (c: Context) => {
  const workspaceId = pathParam(c, "workspaceId");
  const [membersList, grants] = await Promise.all([
    listMembersWithDetails(workspaceId),
    listWorkspaceEnvironmentRoles(workspaceId),
  ]);

  return c.json({
    success: true,
    data: membersList.map((member) => ({ ...member, environmentRoles: grants.get(member.userId) ?? [] })),
  });
});

members.get("/:workspaceId/permissions", requireSession, requireWorkspaceAccess, async (c: Context) => {
  const data = await describeCallerPermissions(pathParam(c, "workspaceId"), c.get("userId"));
  return c.json({ success: true, data });
});

members.get(
  "/:workspaceId/members/:userId",
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const userId = pathParam(c, "userId");

    const member = await getMemberDetails(workspaceId, userId);

    return c.json({
      success: true,
      data: member,
    });
  }
);

members.post(
  "/:workspaceId/members",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("members.manage"),
  async () => {
    throw new ApiError(
      410,
      "USE_INVITATIONS",
      "Adding a member directly is no longer supported: the person must agree to join. Send an invitation instead: POST /api/v2/workspaces/{workspaceId}/invitations.",
    );
  }
);

members.patch(
  "/:workspaceId/members/:userId",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("members.manage"),
  validateBody(updateRoleSchema),
  refuseRetiredOwnerRole,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const updaterUserId = c.get("userId");
    const memberUserId = pathParam(c, "userId");
    const { role } = c.get("validatedBody");

    await updateMemberRole(workspaceId, updaterUserId, memberUserId, role, auditCaller(c).context);
    const member = await getMemberDetails(workspaceId, memberUserId);

    return c.json({
      success: true,
      data: member,
    });
  }
);

members.delete(
  "/:workspaceId/members/:userId",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("members.manage"),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const removerUserId = c.get("userId");
    const memberUserId = pathParam(c, "userId");

    await removeMember(workspaceId, removerUserId, memberUserId, auditCaller(c).context);

    return c.json({
      success: true,
      data: {
        message: "Member removed",
      },
    });
  }
);

members.get(
  "/:workspaceId/members/:userId/environment-roles",
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const data = await listEnvironmentRoles(pathParam(c, "workspaceId"), pathParam(c, "userId"));
    return c.json({ success: true, data });
  }
);

members.put(
  "/:workspaceId/members/:userId/environment-roles/:environmentId",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("members.manage"),
  requireTeamFeature("env_permissions"),
  validateBody(environmentRoleSchema),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const environmentId = validateUUID(pathParam(c, "environmentId"), "Environment ID");
    const { role } = c.get("validatedBody");
    const data = await setEnvironmentRole(workspaceId, c.get("userId"), pathParam(c, "userId"), environmentId, role, auditCaller(c).context);
    return c.json({ success: true, data });
  }
);

members.delete(
  "/:workspaceId/members/:userId/environment-roles/:environmentId",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("members.manage"),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const environmentId = validateUUID(pathParam(c, "environmentId"), "Environment ID");
    await removeEnvironmentRole(workspaceId, c.get("userId"), pathParam(c, "userId"), environmentId, auditCaller(c).context);
    return c.json({ success: true, data: { removed: true } });
  }
);

members.post("/:workspaceId/leave", requireSession, requireWorkspaceAccess, async (c: Context) => {
  const workspaceId = pathParam(c, "workspaceId");
  const userId = c.get("userId");

  await leaveWorkspace(workspaceId, userId, auditCaller(c).context);

  return c.json({
    success: true,
    data: {
      message: "Left workspace",
    },
  });
});

members.put(
  "/:workspaceId/members/:userId/emergency-access",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("members.manage"),
  validateBody(emergencyAccessSchema),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const memberUserId = pathParam(c, "userId");
    const { enabled } = c.get("validatedBody");

    await setEmergencyAccess(workspaceId, c.get("userId"), memberUserId, enabled, auditCaller(c).context);
    const member = await getMemberDetails(workspaceId, memberUserId);

    return c.json({ success: true, data: member });
  }
);

members.post(
  "/:workspaceId/transfer-ownership",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("members.manage"),
  validateBody(transferOwnershipSchema),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const { newOwnerId } = c.get("validatedBody");

    await handOverEmergencyAccess(workspaceId, c.get("userId"), newOwnerId, auditCaller(c).context);

    return c.json({
      success: true,
      data: {
        message: "Emergency access handed over",
      },
    });
  }
);

export default members;
