import { Hono, type Context } from "hono";
import { auditCaller } from "../audit-caller.ts";
import { requirePermission, requireSession, requireWorkspaceAccess } from "../middleware/auth.ts";
import { validateBody } from "../middleware/validation.ts";
import { limitInvitationEmails } from "../middleware/rateLimit.ts";
import { z } from "zod";
import {
  createInvitation,
  acceptInvitation,
  declineInvitation,
  cancelInvitation,
  resendInvitation,
  listWorkspaceInvitations,
  getInvitationByToken,
  getPendingInvitationsForEmail,
} from "../../core/workspace/invitations.ts";
import { NotFoundError } from "../../utils/errors.ts";
import { refuseRetiredOwnerRole, roleInputSchema } from "../role-input.ts";
import { pathParam } from "../params.ts";

const workspaceInvitationsRouter = new Hono();
export const publicInvitationsRouter = new Hono();

const createInvitationSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: roleInputSchema.optional().default("member"),
});

workspaceInvitationsRouter.get(
  "/:workspaceId/invitations",
  requireSession,
  requireWorkspaceAccess,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const userId = c.get("userId");

    const invitationList = await listWorkspaceInvitations(workspaceId, userId);

    return c.json({
      success: true,
      data: invitationList,
    });
  }
);

workspaceInvitationsRouter.post(
  "/:workspaceId/invitations",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("members.manage"),
  validateBody(createInvitationSchema),
  refuseRetiredOwnerRole,
  limitInvitationEmails,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const userId = c.get("userId");
    const { email, role } = c.get("validatedBody");

    const invitation = await createInvitation({
      workspaceId,
      email,
      role,
      invitedByUserId: userId,
      context: auditCaller(c).context,
    });

    return c.json({
      success: true,
      data: invitation,
    });
  }
);

workspaceInvitationsRouter.post(
  "/:workspaceId/invitations/:invitationId/resend",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("members.manage"),
  limitInvitationEmails,
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const invitationId = pathParam(c, "invitationId");
    const userId = c.get("userId");

    const invitation = await resendInvitation(invitationId, workspaceId, userId);

    return c.json({
      success: true,
      data: invitation,
    });
  }
);

workspaceInvitationsRouter.delete(
  "/:workspaceId/invitations/:invitationId",
  requireSession,
  requireWorkspaceAccess,
  requirePermission("members.manage"),
  async (c: Context) => {
    const workspaceId = pathParam(c, "workspaceId");
    const invitationId = pathParam(c, "invitationId");
    const userId = c.get("userId");

    await cancelInvitation(invitationId, workspaceId, userId, auditCaller(c).context);

    return c.json({
      success: true,
      data: { message: "Invitation cancelled" },
    });
  }
);

publicInvitationsRouter.get("/invitations/pending", requireSession, async (c: Context) => {
  const userEmail = c.get("userEmail");

  if (!userEmail) {
    return c.json({
      success: true,
      data: [],
    });
  }

  const pendingInvitations = await getPendingInvitationsForEmail(userEmail);

  return c.json({
    success: true,
    data: pendingInvitations,
  });
});

publicInvitationsRouter.get("/invitations/:token", async (c: Context) => {
  const token = pathParam(c, "token");

  const invitation = await getInvitationByToken(token);

  if (!invitation) {
    throw new NotFoundError("Invitation");
  }

  if (new Date() > invitation.expiresAt) {
    return c.json({
      success: true,
      data: {
        ...invitation,
        status: "expired",
      },
    });
  }

  return c.json({
    success: true,
    data: invitation,
  });
});

publicInvitationsRouter.post("/invitations/:token/accept", requireSession, async (c: Context) => {
  const token = pathParam(c, "token");
  const userId = c.get("userId");

  await acceptInvitation(token, userId, auditCaller(c).context);

  const invitation = await getInvitationByToken(token);

  return c.json({
    success: true,
    data: {
      message: "Invitation accepted",
      workspace: invitation?.workspace,
    },
  });
});

publicInvitationsRouter.post("/invitations/:token/decline", async (c: Context) => {
  const token = pathParam(c, "token");

  await declineInvitation(token);

  return c.json({
    success: true,
    data: { message: "Invitation declined" },
  });
});

export default workspaceInvitationsRouter;
