import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaceMembers } from "../../db/schema/workspaces.ts";
import { environments } from "../../db/schema/environments.ts";
import { memberEnvironmentRoles } from "../../db/schema/member-environment-roles.ts";
import { isFeatureEnabled } from "../edition/features.ts";
import { AuthorizationError, NotFoundError, ValidationError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import type { StoredAuditContext } from "../audit/event-schema.ts";
import { membershipRecord } from "./membership-records.ts";
import {
  ENVIRONMENT_ROLES,
  hasPermission,
  isRole,
  permissionDeniedMessage,
  permissionScope,
  permissionsFor,
  type EnvironmentRole,
  type Permission,
  type Role,
} from "./permissions.ts";

const logger = createLogger({ module: "workspace-roles" });

export const ENV_PERMISSIONS_FEATURE = "env_permissions";

export function environmentGrantsEnabled(): boolean {
  return isFeatureEnabled(ENV_PERMISSIONS_FEATURE);
}

export interface ResolvedRole {
  workspaceRole: Role;
  role: Role;
  grantedInEnvironmentId: string | null;
  emergencyAccess: boolean;
}

export async function resolveMemberRole(
  workspaceId: string,
  userId: string,
  environmentId?: string | null,
): Promise<ResolvedRole | null> {
  const useGrants = Boolean(environmentId) && environmentGrantsEnabled();

  const [row] = useGrants
    ? await db
        .select({ workspaceRole: workspaceMembers.role, emergencyAccess: workspaceMembers.emergencyAccess, grantRole: memberEnvironmentRoles.role })
        .from(workspaceMembers)
        .leftJoin(
          memberEnvironmentRoles,
          and(
            eq(memberEnvironmentRoles.workspaceId, workspaceMembers.workspaceId),
            eq(memberEnvironmentRoles.userId, workspaceMembers.userId),
            eq(memberEnvironmentRoles.environmentId, environmentId as string),
          ),
        )
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
        .limit(1)
    : await db
        .select({ workspaceRole: workspaceMembers.role, emergencyAccess: workspaceMembers.emergencyAccess })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
        .limit(1);

  if (!row) return null;
  const workspaceRole = row.workspaceRole as Role;
  const grantRole = "grantRole" in row ? (row.grantRole as Role | null) : null;
  const emergencyAccess = row.emergencyAccess === true;
  if (grantRole && !emergencyAccess) {
    return { workspaceRole, role: grantRole, grantedInEnvironmentId: environmentId ?? null, emergencyAccess };
  }
  return { workspaceRole, role: workspaceRole, grantedInEnvironmentId: null, emergencyAccess };
}

export async function approvalDecidersIn(workspaceId: string, environmentId: string): Promise<string[]> {
  const rows = environmentGrantsEnabled()
    ? await db
        .select({ userId: workspaceMembers.userId, workspaceRole: workspaceMembers.role, emergencyAccess: workspaceMembers.emergencyAccess, grantRole: memberEnvironmentRoles.role })
        .from(workspaceMembers)
        .leftJoin(
          memberEnvironmentRoles,
          and(
            eq(memberEnvironmentRoles.workspaceId, workspaceMembers.workspaceId),
            eq(memberEnvironmentRoles.userId, workspaceMembers.userId),
            eq(memberEnvironmentRoles.environmentId, environmentId),
          ),
        )
        .where(eq(workspaceMembers.workspaceId, workspaceId))
    : await db
        .select({ userId: workspaceMembers.userId, workspaceRole: workspaceMembers.role, emergencyAccess: workspaceMembers.emergencyAccess })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId));
  return rows
    .filter((row) => {
      const workspaceRole = row.workspaceRole as Role;
      const grantRole = "grantRole" in row ? (row.grantRole as Role | null) : null;
      const role = grantRole && row.emergencyAccess !== true ? grantRole : workspaceRole;
      return hasPermission(role, "approvals.decide");
    })
    .map((row) => row.userId);
}

export function roleFor(resolved: ResolvedRole, permission: Permission): Role {
  return permissionScope(permission) === "environment" ? resolved.role : resolved.workspaceRole;
}

export async function assertMemberPermission(
  workspaceId: string,
  userId: string,
  permission: Permission,
  environmentId?: string | null,
): Promise<ResolvedRole> {
  const resolved = await resolveMemberRole(
    workspaceId,
    userId,
    permissionScope(permission) === "environment" ? environmentId : null,
  );
  if (!resolved) throw new AuthorizationError("You are not a member of this workspace");
  const role = roleFor(resolved, permission);
  if (!hasPermission(role, permission)) {
    throw new AuthorizationError(permissionDeniedMessage(role, permission));
  }
  return resolved;
}

export interface EnvironmentRoleGrant {
  environmentId: string;
  role: EnvironmentRole;
  grantedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function assertGrantsEnabled(): void {
  if (!environmentGrantsEnabled()) throw new NotFoundError("Endpoint");
}

function toGrant(row: typeof memberEnvironmentRoles.$inferSelect): EnvironmentRoleGrant {
  return {
    environmentId: row.environmentId,
    role: row.role as EnvironmentRole,
    grantedBy: row.grantedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listEnvironmentRoles(workspaceId: string, userId: string): Promise<EnvironmentRoleGrant[]> {
  assertGrantsEnabled();
  const rows = await db
    .select()
    .from(memberEnvironmentRoles)
    .where(and(eq(memberEnvironmentRoles.workspaceId, workspaceId), eq(memberEnvironmentRoles.userId, userId)));
  return rows.map(toGrant);
}

export async function listWorkspaceEnvironmentRoles(workspaceId: string): Promise<Map<string, EnvironmentRoleGrant[]>> {
  const byUser = new Map<string, EnvironmentRoleGrant[]>();
  if (!environmentGrantsEnabled()) return byUser;
  const rows = await db.select().from(memberEnvironmentRoles).where(eq(memberEnvironmentRoles.workspaceId, workspaceId));
  for (const row of rows) {
    const list = byUser.get(row.userId) ?? [];
    list.push(toGrant(row));
    byUser.set(row.userId, list);
  }
  return byUser;
}

async function loadTarget(workspaceId: string, actorUserId: string, memberUserId: string, environmentId: string) {
  await assertMemberPermission(workspaceId, actorUserId, "members.manage");

  const [member] = await db
    .select({ role: workspaceMembers.role, emergencyAccess: workspaceMembers.emergencyAccess })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, memberUserId)))
    .limit(1);
  if (!member) throw new NotFoundError("Member");
  if (member.emergencyAccess) {
    throw new AuthorizationError("An admin with emergency access keeps their role in every environment; it cannot be overridden");
  }

  const [environment] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.id, environmentId)))
    .limit(1);
  if (!environment) throw new NotFoundError("Environment");
}

export async function setEnvironmentRole(
  workspaceId: string,
  actorUserId: string,
  memberUserId: string,
  environmentId: string,
  role: string,
  context?: StoredAuditContext,
): Promise<EnvironmentRoleGrant> {
  assertGrantsEnabled();
  if (!isRole(role) || !(ENVIRONMENT_ROLES as readonly string[]).includes(role)) {
    throw new ValidationError(`role must be one of: ${ENVIRONMENT_ROLES.join(", ")}`);
  }
  await loadTarget(workspaceId, actorUserId, memberUserId, environmentId);

  const now = new Date();
  const row = await db.transaction(async (tx) => {
    const [previous] = await tx
      .select({ role: memberEnvironmentRoles.role })
      .from(memberEnvironmentRoles)
      .where(and(
        eq(memberEnvironmentRoles.workspaceId, workspaceId),
        eq(memberEnvironmentRoles.userId, memberUserId),
        eq(memberEnvironmentRoles.environmentId, environmentId),
      ))
      .limit(1);
    const [saved] = await tx
      .insert(memberEnvironmentRoles)
      .values({ workspaceId, userId: memberUserId, environmentId, role, grantedBy: actorUserId })
      .onConflictDoUpdate({
        target: [memberEnvironmentRoles.workspaceId, memberEnvironmentRoles.userId, memberEnvironmentRoles.environmentId],
        set: { role, grantedBy: actorUserId, updatedAt: now },
      })
      .returning();
    await writeAuditEvents(tx, [
      membershipRecord(
        "member.environment_role_granted",
        { workspaceId, actorUserId, source: "dashboard", userId: memberUserId, environmentId, role, previousRole: previous?.role ?? null },
        { context, environmentId },
      ),
    ]);
    return saved;
  });

  logger.info({ workspaceId, userId: memberUserId, environmentId, role, grantedBy: actorUserId }, "Environment role granted");
  return toGrant(row);
}

export async function removeEnvironmentRole(
  workspaceId: string,
  actorUserId: string,
  memberUserId: string,
  environmentId: string,
  context?: StoredAuditContext,
): Promise<void> {
  assertGrantsEnabled();
  await loadTarget(workspaceId, actorUserId, memberUserId, environmentId);
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(memberEnvironmentRoles)
      .where(and(
        eq(memberEnvironmentRoles.workspaceId, workspaceId),
        eq(memberEnvironmentRoles.userId, memberUserId),
        eq(memberEnvironmentRoles.environmentId, environmentId),
      ))
      .returning({ id: memberEnvironmentRoles.id, role: memberEnvironmentRoles.role });
    if (deleted.length === 0) throw new NotFoundError("Environment role");
    await writeAuditEvents(tx, [
      membershipRecord(
        "member.environment_role_removed",
        { workspaceId, actorUserId, source: "dashboard", userId: memberUserId, environmentId, previousRole: deleted[0].role },
        { context, environmentId },
      ),
    ]);
  });
  logger.info({ workspaceId, userId: memberUserId, environmentId, removedBy: actorUserId }, "Environment role removed");
}

export interface CallerPermissions {
  role: Role;
  emergencyAccess: boolean;
  permissions: Permission[];
  environmentRolesEnabled: boolean;
  environments: Array<{ environmentId: string; role: Role; granted: boolean; permissions: Permission[] }>;
}

export async function describeCallerPermissions(workspaceId: string, userId: string): Promise<CallerPermissions> {
  const resolved = await resolveMemberRole(workspaceId, userId);
  if (!resolved) throw new AuthorizationError("You are not a member of this workspace");
  const workspaceRole = resolved.workspaceRole;
  const enabled = environmentGrantsEnabled();

  const [envRows, grantRows] = await Promise.all([
    db.select({ id: environments.id }).from(environments).where(eq(environments.workspaceId, workspaceId)),
    enabled && !resolved.emergencyAccess
      ? db
          .select({ environmentId: memberEnvironmentRoles.environmentId, role: memberEnvironmentRoles.role })
          .from(memberEnvironmentRoles)
          .where(and(eq(memberEnvironmentRoles.workspaceId, workspaceId), eq(memberEnvironmentRoles.userId, userId)))
      : Promise.resolve([] as Array<{ environmentId: string; role: string }>),
  ]);
  const grants = new Map(grantRows.map((grant) => [grant.environmentId, grant.role as Role]));

  return {
    role: workspaceRole,
    emergencyAccess: resolved.emergencyAccess,
    permissions: permissionsFor(workspaceRole),
    environmentRolesEnabled: enabled,
    environments: envRows.map(({ id }) => {
      const role = grants.get(id) ?? workspaceRole;
      return {
        environmentId: id,
        role,
        granted: grants.has(id),
        permissions: permissionsFor(role).filter((p) => permissionScope(p) === "environment")
          .concat(permissionsFor(workspaceRole).filter((p) => permissionScope(p) === "workspace"))
          .sort(),
      };
    }),
  };
}
