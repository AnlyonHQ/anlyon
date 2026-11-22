import { upgradesPurchasable } from "../plans/limits.ts";
import { limitAdvice } from "../billing/limit-advice.ts";
import { adviceSummary } from "../assistant/notification-text.ts";
import { absoluteActionUrl, consoleLink } from "./console-link.ts";

function usageAdvice(isNearLimit: boolean): string {
  if (!upgradesPurchasable()) {
    return isNearLimit
      ? `You're close to your limit. ${limitAdvice("monthly")}`
      : "Keep an eye on usage. Early Beta Access has fixed allowances and no automatic charges.";
  }
  return isNearLimit
    ? "You're close to your limit. Upgrade from Settings > Billing for a larger allowance."
    : "Keep an eye on usage as you scale. Upgrade anytime to raise your limits.";
}
import { logger } from "../../lib/logger.ts";
import { captureMessage } from "../../lib/sentry.ts";
import { instanceSetting } from "../instance/settings.ts";
import { NOTIFICATION_EMAIL_ALERT_DEFAULT } from "../instance/registry.ts";
import type { notifications } from "../../db/schema/notifications.ts";
import { fromAddress, isEmailConfigured, mailTransport, resendClient as resend } from "../../lib/resend-client.ts";
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

interface EmailTemplate {
  subject: string;
  htmlContent: string;
  textContent: string;
}

export async function sendEmailNotification(
  notification: typeof notifications.$inferSelect,
  recipients: string[]
): Promise<void> {
  if (mailTransport() === "none") {
    logger.warn("Email is not configured (RESEND_API_KEY or SMTP_URL), skipping email notification");
    return;
  }

  if (!fromAddress()) {
    logger.warn("FROM_EMAIL not configured, skipping email notification");
    return;
  }

  const allowed = await consumeEmailAllowance(notification.workspaceId, recipients.length);
  if (!allowed) {
    logger.info(
      { workspaceId: notification.workspaceId, type: notification.type },
      "Email notification skipped: plan email cap"
    );
    return;
  }

  try {
    const template = getEmailTemplate(notification);

    const emailPromises = recipients.map((recipient) =>
      resend.emails.send({
        from: fromAddress()!,
        to: recipient,
        subject: template.subject,
        html: template.htmlContent,
        text: template.textContent,
      })
    );

    await Promise.all(emailPromises);

    logger.info({
      notificationId: notification.id,
      recipients: recipients.length,
      type: notification.type,
    }, "Email notifications sent");
  } catch (error) {
    logger.error({
      notificationId: notification.id,
      error,
    }, "Failed to send email notification");
    throw error;
  }
}

async function consumeEmailAllowance(workspaceId: string, count: number): Promise<boolean> {
  try {
    const { getWorkspaceCached, getMonthKey } = await import("../../lib/workspace-cache.ts");
    const { getPlanLimits } = await import("../plans/limits.ts");
    const { redis, RedisKeys } = await import("../../lib/redis.ts");

    const workspace = await getWorkspaceCached(workspaceId);
    const cap = getPlanLimits(workspace?.plan ?? "free", workspace).maxMonthlyNotificationEmails;
    if (cap === 0) return false;

    const month = getMonthKey();
    const key = RedisKeys.notificationEmails(workspaceId, month);
    const used = await redis.incrby(key, count);
    if (used === count) await redis.expire(key, 40 * 24 * 3600);
    emailVolumeAlert({ workspaceId, month, used, count, threshold: notificationEmailAlertThreshold() });
    return cap === "unlimited" || used <= cap;
  } catch (error) {
    logger.warn({ workspaceId, error }, "Email allowance check failed; sending anyway");
    return true;
  }
}

export function notificationEmailAlertThreshold(): number {
  const value = Number(instanceSetting("email.notification_alert_threshold"));
  return Number.isInteger(value) && value >= 0 ? value : NOTIFICATION_EMAIL_ALERT_DEFAULT;
}

export function emailVolumeAlert(input: { workspaceId: string; month: string; used: number; count: number; threshold: number }): boolean {
  const { workspaceId, month, used, count, threshold } = input;
  if (threshold <= 0 || Math.floor((used - count) / threshold) === Math.floor(used / threshold)) return false;
  const message = `Unusual notification email volume: ${used} this month for one workspace (alert every ${threshold})`;
  logger.warn({ workspaceId, month, sent: used, threshold }, message);
  captureMessage(message, "warning", { workspaceId, month, sent: used, threshold });
  return true;
}

function getEmailTemplate(
  notification: typeof notifications.$inferSelect
): EmailTemplate {
  const { type, title, actionLabel, priority, metadata } = notification;
  const actionUrl = notification.actionUrl ? absoluteActionUrl(notification.actionUrl) : null;
  const advice = adviceSummary(metadata);
  const message = advice ? `${notification.message}\n\n${advice.headline}` : notification.message;

  const subject = `[${priority?.toUpperCase()}] ${title}`;

  const htmlContent = generateHTMLEmail({
    title,
    message,
    actionUrl: actionUrl || undefined,
    actionLabel: actionLabel || undefined,
    priority: priority || "medium",
    metadata,
  });

  const textContent = generateTextEmail({
    title,
    message,
    actionUrl: actionUrl || undefined,
    actionLabel: actionLabel || undefined,
  });

  return { subject, htmlContent, textContent };
}

function generateHTMLEmail(params: {
  title: string;
  message: string;
  actionUrl?: string;
  actionLabel?: string;
  priority: string;
  metadata?: any;
}): string {
  const { title, message, actionUrl, actionLabel, priority } = params;

  const priorityConfig: Record<string, { label: string }> = {
    low:      { label: "Low" },
    medium:   { label: "Medium" },
    high:     { label: "High" },
    critical: { label: "Critical" },
  };
  const { label: priorityLabel } = priorityConfig[priority] ?? priorityConfig.medium;
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safePriorityLabel = escapeHtml(priorityLabel);

  return emailShell(
    `${emailHeader()}${emailBody(`
      <p style="margin:0 0 10px;font-size:13px;line-height:20px;color:${EMAIL_COLORS.muted};">Priority: ${safePriorityLabel}</p>
      <h1 style="margin:0 0 12px;font-size:22px;line-height:28px;font-weight:600;color:${EMAIL_COLORS.text};letter-spacing:-0.3px;">${safeTitle}</h1>
      <p style="margin:0;font-size:15px;line-height:24px;color:${EMAIL_COLORS.body};">${safeMessage}</p>

      ${actionUrl && actionLabel ? primaryButton(actionLabel, actionUrl) : ""}
      ${actionUrl ? fallbackLink(actionUrl) : ""}
    `)}${emailFooter()}`,
    title
  );
}

function generateTextEmail(params: {
  title: string;
  message: string;
  actionUrl?: string;
  actionLabel?: string;
}): string {
  const { title, message, actionUrl, actionLabel } = params;

  const lines: string[] = [
    `Anlyon  ${title}`,
    "",
    message,
  ];

  if (actionUrl && actionLabel) {
    lines.push("", `${actionLabel}: ${actionUrl}`);
  }

  lines.push("", `© ${new Date().getFullYear()} Anlyon · anlyon.com`);
  return lines.join("\n");
}

export async function sendQuotaWarningEmail(
  recipients: string[],
  workspaceId: string,
  data: {
    plan: string;
    usagePercentage: number;
    currentUsage: number;
    limit: number;
    quotaType: "daily" | "monthly";
  }
): Promise<void> {
  if (!isEmailConfigured()) return;
  const { plan, usagePercentage, currentUsage, limit, quotaType } = data;

  const isNearLimit = usagePercentage >= 90;
  const subject = isNearLimit
    ? `Action needed: ${usagePercentage}% of your ${quotaType} delivery message quota used`
    : `${usagePercentage}% of your ${quotaType} delivery message quota used`;

  const remaining = (limit - currentUsage).toLocaleString();
  const safePlan = escapeHtml(plan);
  const safeQuotaType = escapeHtml(quotaType);
  const progressWidth = Math.min(Math.max(usagePercentage, 0), 100);

  const htmlContent = emailShell(
    `${emailHeader()}${emailBody(`
      <h1 style="margin:0 0 8px;font-size:22px;line-height:28px;font-weight:600;color:${EMAIL_COLORS.text};letter-spacing:-0.3px;">
        ${usagePercentage}% of your ${safeQuotaType} delivery message quota used
      </h1>
      <p style="margin:0 0 24px;font-size:14px;line-height:22px;color:${EMAIL_COLORS.muted};">${safePlan} plan</p>

      <div style="background-color:${EMAIL_COLORS.border};border-radius:999px;height:8px;overflow:hidden;margin-bottom:8px;">
        <div style="background-color:${EMAIL_COLORS.brand};width:${progressWidth}%;height:100%;border-radius:999px;"></div>
      </div>
      <p style="margin:0 0 24px;font-size:12px;line-height:18px;color:${EMAIL_COLORS.subtle};text-align:right;">${remaining} delivery messages remaining</p>

      ${neutralPanel(`
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;line-height:20px;color:${EMAIL_COLORS.text};">
          <tr>
            <td style="padding:3px 0;width:110px;color:${EMAIL_COLORS.muted};">Used</td>
            <td style="padding:3px 0;font-weight:600;">${currentUsage.toLocaleString()}</td>
          </tr>
          <tr>
            <td style="padding:3px 0;color:${EMAIL_COLORS.muted};">Limit</td>
            <td style="padding:3px 0;font-weight:600;">${limit.toLocaleString()}</td>
          </tr>
          <tr>
            <td style="padding:3px 0;color:${EMAIL_COLORS.muted};">Remaining</td>
            <td style="padding:3px 0;font-weight:600;">${remaining}</td>
          </tr>
        </table>
      `)}

      <p style="margin:22px 0 0;font-size:14px;line-height:22px;color:${EMAIL_COLORS.body};">
        ${usageAdvice(isNearLimit)}
      </p>

      ${primaryButton(upgradesPurchasable() ? "Upgrade plan" : "Review usage", consoleLink("/settings/billing"))}
    `)}${emailFooter()}`,
    subject
  );

  const textContent = `
Anlyon: ${usagePercentage}% of your ${quotaType} delivery message quota used

Used:      ${currentUsage.toLocaleString()}
Limit:     ${limit.toLocaleString()}
Remaining: ${remaining}

${usageAdvice(isNearLimit)}

${upgradesPurchasable() ? "Upgrade plan" : "Review usage"}: ${consoleLink("/settings/billing")}

© ${new Date().getFullYear()} Anlyon · anlyon.com
  `.trim();

  try {
    const emailPromises = recipients.map((recipient) =>
      resend.emails.send({
        from: fromAddress()!,
        to: recipient,
        subject,
        html: htmlContent,
        text: textContent,
      })
    );

    await Promise.all(emailPromises);

    logger.info({
      workspaceId,
      recipients: recipients.length,
      usagePercentage,
    }, "Quota warning email sent");
  } catch (error) {
    logger.error({
      workspaceId,
      error,
    }, "Failed to send quota warning email");
    throw error;
  }
}
