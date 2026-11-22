import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { notificationPreferences } from "../../db/schema/notifications.ts";
import type { SignOffRequestRow } from "../../db/schema/sign-offs.ts";
import { user } from "../../db/schema/user.ts";
import { workspaceMembers } from "../../db/schema/workspaces.ts";
import { env } from "../../config/env.ts";
import { createLogger } from "../../lib/logger.ts";
import { fromAddress, isEmailConfigured, resendClient } from "../../lib/resend-client.ts";
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
import { hasPermission } from "../workspace/permissions.ts";
import { type Classification, renderDiff } from "./classify.ts";
import { signSignOffLink } from "./sign-off-links.ts";
import { signOffUrl } from "./sign-offs.ts";

const logger = createLogger({ module: "sign-off-notify" });

function apiOrigin(): string {
  return (env.API_BASE_URL || env.BETTER_AUTH_URL).replace(/\/$/, "");
}

export function emailedSignOffLink(row: Pick<SignOffRequestRow, "signOffId" | "expiresAt">, userId: string): string {
  const token = signSignOffLink({ signOffId: row.signOffId, userId, expiresAt: Math.floor(row.expiresAt.getTime() / 1000) }, env.DELIVERY_SECRET_MASTER_KEY);
  return `${apiOrigin()}/api/v2/sign-off-links/${token}`;
}

async function workspaceAdmins(workspaceId: string): Promise<Array<{ userId: string; email: string }>> {
  const rows = await db.select({ userId: workspaceMembers.userId, role: workspaceMembers.role, email: user.email })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId)));
  return rows.filter((r) => hasPermission(r.role, "governance.sign_off")).map((r) => ({ userId: r.userId, email: r.email }));
}

export function signOffEmail(row: Pick<SignOffRequestRow, "summary" | "classification" | "expiresAt" | "signOffId">, link: string): { subject: string; html: string; text: string } {
  const changes = (row.classification as unknown as Classification).changes ?? [];
  const diff = renderDiff(changes);
  const subject = `Sign-off needed: ${row.summary}`.slice(0, 200);
  const intro = "An agent asked to loosen one of its guardrails. It cannot apply the change itself: a workspace admin has to approve it.";
  const html = emailShell(`${emailHeader()}${emailBody(`
    <h1 style="margin:0 0 12px;font-size:20px;line-height:28px;color:${EMAIL_COLORS.text};">${escapeHtml(row.summary)}</h1>
    <p style="margin:0 0 16px;font-size:14px;line-height:22px;color:${EMAIL_COLORS.body};">${escapeHtml(intro)}</p>
    ${neutralPanel(`<pre style="margin:0;font-size:12px;line-height:18px;white-space:pre-wrap;color:${EMAIL_COLORS.text};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(diff)}</pre>`)}
    ${primaryButton("Review and decide", link)}
    <p style="margin:0;font-size:13px;line-height:20px;color:${EMAIL_COLORS.muted};">The link is yours alone and works until ${escapeHtml(row.expiresAt.toUTCString())}. Opening it changes nothing. You can reject the change there; approving it needs you signed in to the console.</p>
    ${fallbackLink(link)}
  `)}${emailFooter("You receive this because you are an admin of the workspace.")}`, subject);
  const text = `${row.summary}\n\n${intro}\n\n${diff}\n\nReview and decide: ${link}\n\nThe link is yours alone and works until ${row.expiresAt.toUTCString()}.\nConsole: ${signOffUrl(row.signOffId)}\n`;
  return { subject, html, text };
}

export async function announceSignOff(row: SignOffRequestRow): Promise<void> {
  const admins = await workspaceAdmins(row.workspaceId);
  if (isEmailConfigured()) {
    await Promise.allSettled(admins.map(async (admin) => {
      const message = signOffEmail(row, emailedSignOffLink(row, admin.userId));
      await resendClient.emails.send({ from: fromAddress(), to: admin.email, ...message });
    })).then((results) => {
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed) logger.warn({ signOffId: row.signOffId, failed }, "Some sign-off emails were not sent");
    });
  }

  try {
    const [prefs] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.workspaceId, row.workspaceId));
    const channels = (["in_app", "slack", "discord", "webhook"] as const).filter((channel) =>
      channel === "in_app" ? prefs?.inAppEnabled ?? true
        : channel === "slack" ? prefs?.slackEnabled
          : channel === "discord" ? prefs?.discordEnabled
            : prefs?.webhookEnabled && prefs.webhookUrl);
    if (!channels.length) return;
    const { createAndSendNotification } = await import("../notifications/notification-service.ts");
    await createAndSendNotification({
      workspaceId: row.workspaceId,
      type: "approval_requested",
      priority: "high",
      title: `Sign-off needed: ${row.summary}`.slice(0, 200),
      message: "An agent asked to loosen one of its guardrails. A workspace admin has to approve it before it applies.",
      metadata: { signOffId: row.signOffId, kind: "sign_off", operation: row.operation },
      actionUrl: signOffUrl(row.signOffId),
      actionLabel: "Review",
      expiresAt: row.expiresAt,
    }, { channels: [...channels] });
  } catch (error) {
    logger.warn({ signOffId: row.signOffId, error: error instanceof Error ? error.message : error }, "Sign-off notification failed");
  }
}
