import { db } from "../../db/index.ts";
import { workspaceInvitations } from "../../db/schema/invitations.ts";
import { workspaces, workspaceMembers, roleEnum } from "../../db/schema/workspaces.ts";
import { user } from "../../db/schema/user.ts";
import { eq, and, or, gt } from "drizzle-orm";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { logger } from "../../lib/logger.ts";
import { hasPermission, type AssignableRole } from "./permissions.ts";

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
import { env } from "../../config/env.ts";
import {
  NotFoundError,
  AuthorizationError as ForbiddenError,
  ConflictError,
  ValidationError,
} from "../../utils/errors.ts";
import { fromAddress, isEmailConfigured, resendClient as resend } from "../../lib/resend-client.ts";
import {
  EMAIL_COLORS,
  emailBody,
  emailFooter,
  emailHeader,
  emailShell,
  fallbackLink,
  neutralPanel,
  primaryButton,
} from "../../lib/emails/shared-email-template.ts";
import { escapeHtml } from "../../utils/html.ts";
import z from "zod";
import { checkSeatLimit } from "../billing/usage-enforcement.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import type { StoredAuditContext } from "../audit/event-schema.ts";
const INVITATION_EXPIRY_DAYS = 7;

export type InvitationRole = AssignableRole;

export interface CreateInvitationInput {
  workspaceId: string;
  email: string;
  role?: InvitationRole;
  invitedByUserId: string;
  context?: StoredAuditContext;
}

export interface InvitationWithDetails {
  id: string;
  email: string;
  role: string;
  status: string;
  invitedBy: {
    id: string;
    name: string | null;
    email: string;
  } | null;
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  inviteUrl?: string;
}

export const emailValidationSchema = z.string().email();
export async function createInvitation(input: CreateInvitationInput): Promise<InvitationWithDetails> {
  const { workspaceId, email, role = "member", invitedByUserId } = input;

  const normalizedEmail = email.toLowerCase().trim();

  const { success, data: validatedEmail } = emailValidationSchema.safeParse(normalizedEmail);
  if (!success) {
    throw new ValidationError("Invalid email address");
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  if (!workspace) {
    throw new NotFoundError("Workspace");
  }

  const [inviterMembership] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, invitedByUserId)
      )
    );

  if (!inviterMembership || !hasPermission(inviterMembership.role, "members.manage")) {
    throw new ForbiddenError("Only workspace admins can invite members");
  }

  const [existingUser] = await db
    .select()
    .from(user)
    .where(eq(user.email, normalizedEmail));

  if (existingUser) {
    const [existingMember] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, existingUser.id)
        )
      );

    if (existingMember) {
      throw new ConflictError("This user is already a member of this workspace");
    }
  }

  const [existingInvitation] = await db
    .select()
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        eq(workspaceInvitations.email, normalizedEmail),
        eq(workspaceInvitations.status, "pending"),
        gt(workspaceInvitations.expiresAt, new Date())
      )
    );

  if (existingInvitation) {
    throw new ConflictError("An invitation has already been sent to this email");
  }

  const token = nanoid(32);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + INVITATION_EXPIRY_DAYS);

  const invitation = await db.transaction(async tx => {
  await checkSeatLimit(workspaceId, tx);
  const [pending] = await tx.select({ id: workspaceInvitations.id }).from(workspaceInvitations).where(and(
    eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.email, normalizedEmail),
    eq(workspaceInvitations.status, "pending"), gt(workspaceInvitations.expiresAt, new Date()),
  ));
  if (pending) throw new ConflictError("An invitation has already been sent to this email");
  if (existingUser) {
    const [member] = await tx.select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, existingUser.id),
    ));
    if (member) throw new ConflictError("This user is already a member of this workspace");
  }
  const [created] = await tx
    .insert(workspaceInvitations)
    .values({
      workspaceId,
      email: normalizedEmail,
      role,
      token: hashInvitationToken(token),
      invitedBy: invitedByUserId,
      invitedUserId: existingUser?.id || null,
      expiresAt,
    })
    .returning();
  await writeAuditEvents(tx, [{
    workspaceId, type: "invitation.created", actor: { type: "user", id: invitedByUserId }, context: input.context,
    resource: { type: "invitation", id: created.id },
    data: { invitationId: created.id, email: normalizedEmail, role, expiresAt: expiresAt.toISOString() },
  }]);
  return created;
  });

  const [inviter] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, invitedByUserId));

  const inviteUrl = await sendInvitationEmail({
    email: normalizedEmail,
    token,
    workspace: { name: workspace.name, slug: workspace.slug },
    inviterName: inviter?.name || inviter?.email || "A team member",
    role,
    expiresAt,
  });

  logger.info(
    { workspaceId, email: normalizedEmail, invitedBy: invitedByUserId },
    "Workspace invitation created and sent"
  );

  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    invitedBy: inviter ? { id: inviter.id, name: inviter.name, email: inviter.email } : null,
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
    ...(inviteUrl ? { inviteUrl } : {}),
  };
}

export async function acceptInvitation(token: string, userId: string, context?: StoredAuditContext): Promise<void> {
  const [invitation] = await db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.token, hashInvitationToken(token)));

  if (!invitation) {
    throw new NotFoundError("Invitation not found or invalid token");
  }

  if (invitation.status !== "pending") {
    throw new ConflictError(`Invitation has already been ${invitation.status}`);
  }

  if (new Date() > invitation.expiresAt) {
    await db
      .update(workspaceInvitations)
      .set({ status: "expired" })
      .where(eq(workspaceInvitations.id, invitation.id));

    throw new ValidationError("This invitation has expired. Please request a new one.");
  }

  const [acceptingUser] = await db
    .select()
    .from(user)
    .where(eq(user.id, userId));

  if (!acceptingUser) {
    throw new NotFoundError("User");
  }

  if (acceptingUser.email.toLowerCase() !== invitation.email.toLowerCase()) {
    throw new ForbiddenError("This invitation was sent to a different email address");
  }

  const [existingMember] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, invitation.workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    );

  if (existingMember) {
    await db
      .update(workspaceInvitations)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(workspaceInvitations.id, invitation.id));

    throw new ConflictError("You are already a member of this workspace");
  }

  await db.transaction(async tx => {
  await checkSeatLimit(invitation.workspaceId, tx, invitation.id);
  const [current] = await tx.select().from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, invitation.id)).for("update");
  if (!current || current.status !== "pending" || current.expiresAt <= new Date()) {
    throw new ConflictError("This invitation is no longer pending or has expired");
  }
  await tx.insert(workspaceMembers).values({
    workspaceId: invitation.workspaceId,
    userId: userId,
    role: invitation.role as InvitationRole,
    invitedBy: invitation.invitedBy,
    invitedAt: invitation.createdAt,
  });

  await tx
    .update(workspaceInvitations)
    .set({
      status: "accepted",
      acceptedAt: new Date(),
      invitedUserId: userId,
    })
    .where(eq(workspaceInvitations.id, invitation.id));

  await writeAuditEvents(tx, [{
    workspaceId: invitation.workspaceId, type: "invitation.accepted", actor: { type: "user", id: userId }, context,
    resource: { type: "invitation", id: invitation.id },
    data: { invitationId: invitation.id, userId, role: invitation.role, invitedBy: invitation.invitedBy },
  }]);
  });

  logger.info(
    { workspaceId: invitation.workspaceId, userId, invitationId: invitation.id },
    "Workspace invitation accepted"
  );
}

export async function getInvitationByToken(token: string): Promise<InvitationWithDetails | null> {
  const [invitation] = await db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.token, hashInvitationToken(token)));

  if (!invitation) {
    return null;
  }

  const [workspace] = await db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, invitation.workspaceId));

  let inviter = null;
  if (invitation.invitedBy) {
    const [inviterData] = await db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, invitation.invitedBy));
    inviter = inviterData || null;
  }

  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    invitedBy: inviter,
    workspace: workspace || { id: "", name: "Unknown", slug: "" },
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
  };
}

export async function declineInvitation(token: string): Promise<void> {
  const [invitation] = await db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.token, hashInvitationToken(token)));

  if (!invitation) {
    throw new NotFoundError("Invitation");
  }

  if (invitation.status !== "pending") {
    throw new ConflictError(`Invitation has already been ${invitation.status}`);
  }

  await db
    .update(workspaceInvitations)
    .set({ status: "declined", declinedAt: new Date() })
    .where(eq(workspaceInvitations.id, invitation.id));

  logger.info({ invitationId: invitation.id }, "Workspace invitation declined");
}

export async function cancelInvitation(
  invitationId: string,
  workspaceId: string,
  cancelledByUserId: string,
  context?: StoredAuditContext,
): Promise<void> {
  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, cancelledByUserId)
      )
    );

  if (!membership || !hasPermission(membership.role, "members.manage")) {
    throw new ForbiddenError("Only workspace admins can cancel invitations");
  }

  const [invitation] = await db
    .select()
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.id, invitationId),
        eq(workspaceInvitations.workspaceId, workspaceId)
      )
    );

  if (!invitation) {
    throw new NotFoundError("Invitation");
  }

  if (invitation.status !== "pending") {
    throw new ConflictError(`Cannot cancel an invitation that has been ${invitation.status}`);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(workspaceInvitations)
      .set({ status: "cancelled" })
      .where(eq(workspaceInvitations.id, invitationId));
    await writeAuditEvents(tx, [{
      workspaceId, type: "invitation.cancelled", actor: { type: "user", id: cancelledByUserId }, context,
      resource: { type: "invitation", id: invitationId }, data: { invitationId, email: invitation.email },
    }]);
  });

  logger.info({ invitationId, cancelledBy: cancelledByUserId }, "Workspace invitation cancelled");
}

export async function resendInvitation(
  invitationId: string,
  workspaceId: string,
  resendByUserId: string
): Promise<InvitationWithDetails> {
  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, resendByUserId)
      )
    );

  if (!membership || !hasPermission(membership.role, "members.manage")) {
    throw new ForbiddenError("Only workspace admins can resend invitations");
  }

  const [invitation] = await db
    .select()
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.id, invitationId),
        eq(workspaceInvitations.workspaceId, workspaceId)
      )
    );

  if (!invitation) {
    throw new NotFoundError("Invitation");
  }

  if (invitation.status !== "pending") {
    throw new ConflictError(`Cannot resend an invitation that has been ${invitation.status}`);
  }

  const newToken = nanoid(32);
  const newExpiresAt = new Date();
  newExpiresAt.setDate(newExpiresAt.getDate() + INVITATION_EXPIRY_DAYS);

  await db
    .update(workspaceInvitations)
    .set({ token: hashInvitationToken(newToken), expiresAt: newExpiresAt })
    .where(eq(workspaceInvitations.id, invitationId));

  const [workspace] = await db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  const [inviter] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, resendByUserId));

  const inviteUrl = await sendInvitationEmail({
    email: invitation.email,
    token: newToken,
    workspace: { name: workspace!.name, slug: workspace!.slug },
    inviterName: inviter?.name || inviter?.email || "A team member",
    role: invitation.role as InvitationRole,
    expiresAt: newExpiresAt,
  });

  logger.info({ invitationId, resendBy: resendByUserId }, "Workspace invitation resent");

  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    invitedBy: inviter ? { id: inviter.id, name: inviter.name, email: inviter.email } : null,
    workspace: workspace || { id: "", name: "Unknown", slug: "" },
    createdAt: invitation.createdAt,
    expiresAt: newExpiresAt,
    acceptedAt: invitation.acceptedAt,
    ...(inviteUrl ? { inviteUrl } : {}),
  };
}

export async function listWorkspaceInvitations(
  workspaceId: string,
  userId: string
): Promise<InvitationWithDetails[]> {
  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    );

  if (!membership) {
    throw new ForbiddenError("You are not a member of this workspace");
  }

  const invitations = await db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.workspaceId, workspaceId));

  const [workspace] = await db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  const inviterIds = [...new Set(invitations.map((i) => i.invitedBy).filter(Boolean))];
  const inviters = inviterIds.length > 0
    ? await db
        .select({ id: user.id, name: user.name, email: user.email })
        .from(user)
        .where(or(...inviterIds.map((id) => eq(user.id, id!))))
    : [];

  const inviterMap = new Map(inviters.map((i) => [i.id, i]));

  return invitations.map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    status: inv.status,
    invitedBy: inv.invitedBy ? inviterMap.get(inv.invitedBy) || null : null,
    workspace: workspace || { id: "", name: "Unknown", slug: "" },
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    acceptedAt: inv.acceptedAt,
  }));
}

export async function getPendingInvitationsForEmail(email: string): Promise<InvitationWithDetails[]> {
  const normalizedEmail = email.toLowerCase().trim();

  const invitations = await db
    .select()
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.email, normalizedEmail),
        eq(workspaceInvitations.status, "pending"),
        gt(workspaceInvitations.expiresAt, new Date())
      )
    );

  if (invitations.length === 0) {
    return [];
  }

  const workspaceIds = [...new Set(invitations.map((i) => i.workspaceId))];
  const workspaceList = await db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
    .from(workspaces)
    .where(or(...workspaceIds.map((id) => eq(workspaces.id, id))));

  const workspaceMap = new Map(workspaceList.map((w) => [w.id, w]));

  const inviterIds = [...new Set(invitations.map((i) => i.invitedBy).filter(Boolean))];
  const inviters = inviterIds.length > 0
    ? await db
        .select({ id: user.id, name: user.name, email: user.email })
        .from(user)
        .where(or(...inviterIds.map((id) => eq(user.id, id!))))
    : [];

  const inviterMap = new Map(inviters.map((i) => [i.id, i]));

  return invitations.map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    status: inv.status,
    invitedBy: inv.invitedBy ? inviterMap.get(inv.invitedBy) || null : null,
    workspace: workspaceMap.get(inv.workspaceId) || { id: "", name: "Unknown", slug: "" },
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    acceptedAt: inv.acceptedAt,
  }));
}

async function sendInvitationEmail(params: {
  email: string;
  token: string;
  workspace: { name: string; slug: string };
  inviterName: string;
  role: InvitationRole;
  expiresAt: Date;
}): Promise<string | null> {
  const { email, token, workspace, inviterName, role, expiresAt } = params;

  const frontendUrl = env.FRONTEND_URL || "https://console.anlyon.com";
  const inviteUrl = `${frontendUrl}/invite/${encodeURIComponent(token)}`;

  if (!isEmailConfigured()) {
    logger.warn({ email, workspace: workspace.slug, inviteUrl }, "Email is not configured, so no invitation email was sent. Send this link to the person yourself");
    return inviteUrl;
  }

  const safeWorkspaceName = escapeHtml(workspace.name);
  const safeInviterName = escapeHtml(inviterName);
  const article = /^[aeiou]/.test(role) ? "an" : "a";
  const safeRoleLower = escapeHtml(role);
  const safeRoleTitle = escapeHtml(role.charAt(0).toUpperCase() + role.slice(1));
  const safeExpires = escapeHtml(
    expiresAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
  );

  const subject = `You've been invited to join ${workspace.name} on Anlyon`;

  const htmlContent = emailShell(
    `${emailHeader()}${emailBody(`
      <h1 style="margin:0 0 12px;font-size:22px;line-height:28px;font-weight:600;color:${EMAIL_COLORS.text};letter-spacing:-0.3px;">You're invited to join ${safeWorkspaceName}</h1>

      <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:${EMAIL_COLORS.body};">
        <strong>${safeInviterName}</strong> invited you to join <strong>${safeWorkspaceName}</strong> as ${article} <strong>${safeRoleLower}</strong>.
      </p>

      ${neutralPanel(`
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;line-height:20px;color:${EMAIL_COLORS.text};">
          <tr>
            <td style="padding:3px 0;width:96px;color:${EMAIL_COLORS.muted};">Workspace</td>
            <td style="padding:3px 0;font-weight:600;">${safeWorkspaceName}</td>
          </tr>
          <tr>
            <td style="padding:3px 0;color:${EMAIL_COLORS.muted};">Role</td>
            <td style="padding:3px 0;font-weight:600;">${safeRoleTitle}</td>
          </tr>
          <tr>
            <td style="padding:3px 0;color:${EMAIL_COLORS.muted};">Expires</td>
            <td style="padding:3px 0;font-weight:600;">${safeExpires}</td>
          </tr>
        </table>
      `)}

      ${primaryButton("Accept invitation", inviteUrl)}

      <p style="margin:0;font-size:14px;line-height:22px;color:${EMAIL_COLORS.muted};">
        Do not have an account yet? You can create one when you accept the invitation.
      </p>

      ${fallbackLink(inviteUrl)}
    `)}${emailFooter("If you did not expect this invitation, you can safely ignore this email.")}`,
    "Workspace Invitation"
  );

  const textContent = `
You're invited to join ${workspace.name} on Anlyon

${inviterName} has invited you to join the workspace "${workspace.name}" as ${article} ${role}.

Workspace: ${workspace.name}
Your role: ${role}
Expires: ${expiresAt.toLocaleDateString()}

Accept the invitation by visiting:
${inviteUrl}

Don't have an account? You'll be able to create one when you accept the invitation.

---
If you didn't expect this invitation, you can safely ignore this email.
  `.trim();

  try {
    await resend.emails.send({
      from: fromAddress(),
      to: email,
      subject,
      html: htmlContent,
      text: textContent,
    });

    logger.info({ email, workspace: workspace.name }, "Invitation email sent");
  } catch (error) {
    logger.error({ email, error }, "Failed to send invitation email");
    throw error;
  }
  return null;
}
