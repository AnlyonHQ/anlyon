import { db } from "../../db/index.ts";
import { workspaceMembers } from "../../db/schema/workspaces.ts";
import { user } from "../../db/schema/user.ts";
import { eq, and } from "drizzle-orm";
import { ApiError, NotFoundError, AuthorizationError, ConflictError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";
import type { Role } from "../../types/workspace.ts";
import { hasPermission, isAdmin } from "./permissions.ts";
import { toPublicWorkspaceMember } from "./public-member.ts";
import { type AuditRecordInput, writeAuditEvents } from "../audit/outbox.ts";
import type { StoredAuditContext } from "../audit/event-schema.ts";
import { revokeMemberAccess } from "./access-revocation.ts";
import { assertAdminsRemain } from "./admin-invariants.ts";

const logger = createLogger({ module: "workspace-members" });

function memberRecord(
  type: string,
  workspaceId: string,
  actorUserId: string,
  memberUserId: string,
  data: Record<string, unknown>,
  context?: StoredAuditContext,
): AuditRecordInput {
  return {
    workspaceId, type, actor: { type: "user", id: actorUserId }, context,
    resource: { type: "member", id: memberUserId }, data: { userId: memberUserId, ...data },
  };
}

export async function addMember(
  workspaceId: string,
  invitedByUserId: string,
  userIdOrEmail: string,
  role: Role = "member",
  context?: StoredAuditContext,
) {
  const [inviter] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, invitedByUserId)
      )
    );

  if (!inviter || !hasPermission(inviter.role, "members.manage")) {
    throw new AuthorizationError("Only admins can add members");
  }

  if (userIdOrEmail.includes("@")) {
    throw new ApiError(
      410,
      "USE_INVITATIONS",
      "Adding a member by email address is no longer supported. Send an invitation instead: POST /api/v2/workspaces/{workspaceId}/invitations.",
    );
  }
  const userIdToAdd = userIdOrEmail;

  const [existing] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userIdToAdd)
      )
    );

  if (existing) {
    throw new ConflictError("User is already a member of this workspace");
  }

  const member = await db.transaction(async (tx) => {
    const [added] = await tx
      .insert(workspaceMembers)
      .values({
        workspaceId,
        userId: userIdToAdd,
        role,
        invitedBy: invitedByUserId,
      })
      .returning();
    await writeAuditEvents(tx, [memberRecord("member.added", workspaceId, invitedByUserId, userIdToAdd, { role }, context)]);
    return added;
  });

  logger.info({ workspaceId, userId: userIdToAdd, role }, "Member added to workspace");

  return member;
}

export async function updateMemberRole(
  workspaceId: string,
  updaterUserId: string,
  memberUserId: string,
  newRole: Role,
  context?: StoredAuditContext,
) {
  const [updater] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, updaterUserId)
      )
    );

  if (!updater || !hasPermission(updater.role, "members.manage")) {
    throw new AuthorizationError("Only admins can update member roles");
  }

  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, memberUserId)
      )
    );

  if (!member) {
    throw new NotFoundError("Member");
  }

  if (member.emergencyAccess && !isAdmin(newRole)) {
    throw new AuthorizationError("This admin has emergency access. Remove their emergency access before changing their role.");
  }

  const updated = await db.transaction(async (tx) => {
    if (isAdmin(member.role) && !isAdmin(newRole)) {
      await assertAdminsRemain(tx, workspaceId, { userId: memberUserId, admin: false, emergencyAccess: false });
    }
    const [changed] = await tx
      .update(workspaceMembers)
      .set({ role: newRole })
      .where(eq(workspaceMembers.id, member.id))
      .returning();
    await writeAuditEvents(tx, [memberRecord("member.role_changed", workspaceId, updaterUserId, memberUserId, { role: newRole, previousRole: member.role }, context)]);
    return changed;
  });

  logger.info(
    { workspaceId, userId: memberUserId, oldRole: member.role, newRole },
    "Member role updated"
  );

  return updated;
}

export async function removeMember(
  workspaceId: string,
  removerUserId: string,
  memberUserId: string,
  context?: StoredAuditContext,
) {
  const [remover] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, removerUserId)
      )
    );

  if (!remover || !hasPermission(remover.role, "members.manage")) {
    throw new AuthorizationError("Only admins can remove members");
  }

  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, memberUserId)
      )
    );

  if (!member) {
    throw new NotFoundError("Member");
  }

  if (member.emergencyAccess) {
    throw new AuthorizationError("This admin has emergency access. Remove their emergency access before removing them.");
  }

  const result = await revokeMemberAccess(workspaceId, memberUserId, {
    reason: "member_removed",
    actor: { type: "user", id: removerUserId },
    context,
    membershipRecord: ({ apiKeysRevoked }) =>
      memberRecord("member.removed", workspaceId, removerUserId, memberUserId, { role: member.role, apiKeysRevoked }, context),
  }, isAdmin(member.role)
    ? (tx) => assertAdminsRemain(tx, workspaceId, { userId: memberUserId, admin: false, emergencyAccess: false })
    : undefined);

  logger.info({ workspaceId, userId: memberUserId, ...result }, "Member removed from workspace");
}

export async function leaveWorkspace(workspaceId: string, userId: string, context?: StoredAuditContext) {
  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    );

  if (!member) {
    throw new NotFoundError("Membership");
  }

  const result = await revokeMemberAccess(workspaceId, userId, {
    reason: "member_left",
    actor: { type: "user", id: userId },
    context,
    membershipRecord: ({ apiKeysRevoked }) =>
      memberRecord("member.left", workspaceId, userId, userId, { role: member.role, apiKeysRevoked }, context),
  }, isAdmin(member.role)
    ? (tx) => assertAdminsRemain(tx, workspaceId, { userId, admin: false, emergencyAccess: false })
    : undefined);

  logger.info({ workspaceId, userId, ...result }, "User left workspace");
}

export async function setEmergencyAccess(
  workspaceId: string,
  actorUserId: string,
  memberUserId: string,
  enabled: boolean,
  context?: StoredAuditContext,
) {
  const [actor] = await db
    .select({ role: workspaceMembers.role, emergencyAccess: workspaceMembers.emergencyAccess })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorUserId)));
  if (!actor || !isAdmin(actor.role)) {
    throw new AuthorizationError("Only an admin with emergency access can change who has it.");
  }
  if (!actor.emergencyAccess) {
    const [holder] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.emergencyAccess, true)))
      .limit(1);
    if (holder || !enabled) throw new AuthorizationError("Only an admin with emergency access can change who has it.");
  }

  const [member] = await db
    .select({ id: workspaceMembers.id, role: workspaceMembers.role, emergencyAccess: workspaceMembers.emergencyAccess })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, memberUserId)));
  if (!member) throw new NotFoundError("Member");
  if (enabled && !isAdmin(member.role)) {
    throw new ConflictError("Emergency access is for admins. Make this member an admin first.");
  }
  if (member.emergencyAccess === enabled) return;

  await db.transaction(async (tx) => {
    await assertAdminsRemain(tx, workspaceId, { userId: memberUserId, admin: isAdmin(member.role), emergencyAccess: enabled });
    await tx.update(workspaceMembers).set({ emergencyAccess: enabled }).where(eq(workspaceMembers.id, member.id));
    await writeAuditEvents(tx, [memberRecord(
      enabled ? "member.emergency_access_granted" : "member.emergency_access_removed",
      workspaceId, actorUserId, memberUserId, { role: member.role }, context,
    )]);
  });

  logger.info({ workspaceId, userId: memberUserId, enabled }, "Emergency access changed");
}

export async function handOverEmergencyAccess(
  workspaceId: string,
  currentUserId: string,
  newUserId: string,
  context?: StoredAuditContext,
) {
  const [current] = await db
    .select({ id: workspaceMembers.id, role: workspaceMembers.role, emergencyAccess: workspaceMembers.emergencyAccess })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, currentUserId)));
  if (!current || !isAdmin(current.role) || !current.emergencyAccess) {
    throw new AuthorizationError("Only an admin with emergency access can hand it over.");
  }

  const [next] = await db
    .select({ id: workspaceMembers.id, role: workspaceMembers.role, emergencyAccess: workspaceMembers.emergencyAccess })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, newUserId)));
  if (!next) {
    throw new NotFoundError("The new admin must be a member of the workspace");
  }
  if (next.id === current.id) return;

  await db.transaction(async (tx) => {
    await tx
      .update(workspaceMembers)
      .set({ role: "admin", emergencyAccess: true })
      .where(eq(workspaceMembers.id, next.id));
    await tx
      .update(workspaceMembers)
      .set({ emergencyAccess: false })
      .where(eq(workspaceMembers.id, current.id));
    const records: AuditRecordInput[] = [];
    if (!isAdmin(next.role)) {
      records.push(memberRecord("member.role_changed", workspaceId, currentUserId, newUserId, { role: "admin", previousRole: next.role }, context));
    }
    if (!next.emergencyAccess) {
      records.push(memberRecord("member.emergency_access_granted", workspaceId, currentUserId, newUserId, { role: "admin" }, context));
    }
    records.push(memberRecord("member.emergency_access_removed", workspaceId, currentUserId, currentUserId, { role: "admin" }, context));
    await writeAuditEvents(tx, records);
  });

  logger.info({ workspaceId, fromUserId: currentUserId, toUserId: newUserId }, "Emergency access handed over");
}

export async function getMemberDetails(workspaceId: string, userId: string) {
  const [member] = await db
    .select({
      id: workspaceMembers.id,
      workspaceId: workspaceMembers.workspaceId,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      emergencyAccess: workspaceMembers.emergencyAccess,
      invitedBy: workspaceMembers.invitedBy,
      invitedAt: workspaceMembers.invitedAt,
      joinedAt: workspaceMembers.joinedAt,
      createdAt: workspaceMembers.createdAt,
      userName: user.name,
      userEmail: user.email,
    })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    );

  if (!member) {
    throw new NotFoundError("Member");
  }

  return toPublicWorkspaceMember(member);
}

export async function listMembersWithDetails(workspaceId: string) {
  const members = await db
    .select({
      id: workspaceMembers.id,
      workspaceId: workspaceMembers.workspaceId,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      emergencyAccess: workspaceMembers.emergencyAccess,
      invitedBy: workspaceMembers.invitedBy,
      invitedAt: workspaceMembers.invitedAt,
      joinedAt: workspaceMembers.joinedAt,
      createdAt: workspaceMembers.createdAt,
      userName: user.name,
      userEmail: user.email,
    })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId));

  return members.map(toPublicWorkspaceMember);
}
