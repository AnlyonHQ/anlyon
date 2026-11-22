import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { workspaceBudgets, workspaceBudgetPeriods } from "../../db/schema/billing.ts";
import { getUsageAllowances } from "../billing/allowances.ts";
import { ACTION_ALERT_THRESHOLDS, actionCapUnits, getPlanLimits } from "../plans/limits.ts";
import { actionCreditUnits } from "../billing/action-allowance.ts";
import { limitAdvice } from "../billing/limit-advice.ts";
import { getMonthKey } from "../../lib/workspace-cache.ts";
import { createAndSendNotification, wasAlertRecentlySent, recordAlertSent, getNotificationPreferences } from "./notification-service.ts";
import { logger } from "../../lib/logger.ts";
import { consoleLink } from "./console-link.ts";

export interface UsageAlertCheck {
  workspaceId: string;
  quotaType: "daily" | "monthly";
}

export async function checkAndSendUsageAlerts(workspaceId: string): Promise<void> {
  try {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!workspace) return;
    const usage = await getUsageAllowances(workspaceId);
    const limits = getPlanLimits(workspace.plan, workspace);
    const month = getMonthKey();
    const prefs = await getNotificationPreferences(workspaceId);
    const thresholds: number[] = Array.isArray(prefs?.quotaAlertThresholds)
      ? prefs.quotaAlertThresholds.filter((value): value is number => typeof value === "number" && value > 0 && value <= 100)
      : [50, 75, 90, 100];
    const credits = await actionCreditUnits(db, workspaceId, month);
    for (const [dimension, label] of [["actionInvokes", "Action executions"], ["messages", "Delivery messages"]] as const) {
      const allowance = usage[dimension];
      const includedUnits = (allowance.includedUnits ?? 0) + (dimension === "actionInvokes" ? credits : 0);
      if (!includedUnits) continue;
      const policy = limits.usagePolicy[dimension];
      const percent = Math.floor(100 * allowance.usedUnits / includedUnits);
      const dimensionThresholds = dimension === "actionInvokes" ? [...new Set([...thresholds, ...ACTION_ALERT_THRESHOLDS])] : thresholds;
      const threshold = Math.max(0, ...dimensionThresholds.filter(value => percent >= value));
      if (!threshold) continue;
      const alertType = `allowance_${month}_${dimension}_${threshold}`;
      if (await wasAlertRecentlySent(workspaceId, alertType, 32 * 24)) continue;
      const cap = dimension === "actionInvokes" ? actionCapUnits(policy, credits) : policy.kind === "hard-cap" ? policy.capUnits : null;
      const graced = policy.kind === "included-with-grace";
      await createAndSendNotification({
        workspaceId, type: percent >= 100 ? "quota_exceeded" : "quota_warning",
        priority: percent >= 90 ? "high" : "medium",
        title: `${label}: ${percent}% of monthly allowance used`,
        message: `${allowance.usedUnits.toLocaleString("en-US")} of ${includedUnits.toLocaleString("en-US")} used. ` +
          (graced && cap !== null
            ? `Actions keep running to ${cap.toLocaleString("en-US")} (a 10% buffer), then stop until the next UTC month. Nothing extra is charged. ${limitAdvice("monthly")}`
            : `Requests stop at the allowance until the next UTC month. ${limitAdvice("monthly")}`),
        metadata: { dimension, month, threshold, percent, ...(cap !== null ? { capUnits: cap } : {}) },
        actionUrl: "/settings/billing", actionLabel: "Review usage",
      });
      await recordAlertSent(workspaceId, alertType, { month, threshold });
    }
    const [budget] = await db.select().from(workspaceBudgets).where(eq(workspaceBudgets.workspaceId, workspaceId));
    await db.insert(workspaceBudgetPeriods).values({
      workspaceId, month, projectedOverageCents: Math.ceil(usage.projectedOverageCents),
    }).onConflictDoUpdate({ target: [workspaceBudgetPeriods.workspaceId, workspaceBudgetPeriods.month],
      set: { projectedOverageCents: Math.ceil(usage.projectedOverageCents), updatedAt: new Date() } });
    if (!budget?.enabled || budget.maxOverageCents <= 0) return;
    const percent = Math.floor(100 * usage.projectedOverageCents / budget.maxOverageCents);
    const threshold = Math.max(0, ...budget.alertThresholds.filter(value => percent >= value));
    const alertType = `overage_${month}_${budget.maxOverageCents}_${threshold}`;
    if (!threshold || await wasAlertRecentlySent(workspaceId, alertType, 32 * 24)) return;
    await createAndSendNotification({
      workspaceId, type: "budget_alert", priority: "high",
      title: `Projected overage reached ${percent}% of your alert target`,
      message: `Projected overage so far: $${(usage.projectedOverageCents / 100).toFixed(2)}. Target: $${(budget.maxOverageCents / 100).toFixed(2)}. Alerts do not stop usage or cap your invoice.`,
      metadata: { month, threshold, projectedOverageCents: usage.projectedOverageCents },
      actionUrl: "/settings/billing", actionLabel: "Review usage",
    });
    await recordAlertSent(workspaceId, alertType, { month, threshold });
  } catch (error) {
    logger.error({ workspaceId, error }, "Failed to check usage alerts");
  }
}

export async function sendDeliveryFailureAlert(
  workspaceId: string,
  failureRate: number,
  totalMessages: number,
  failedMessages: number
): Promise<void> {
  const alertType = "delivery_failure_spike";
  const alreadySent = await wasAlertRecentlySent(workspaceId, alertType, 6);

  if (alreadySent) {
    return;
  }

  await createAndSendNotification({
    workspaceId,
    type: "delivery_failure_spike",
    priority: "high",
    title: "High Delivery Failure Rate Detected",
    message: `Your workspace has experienced a ${failureRate.toFixed(1)}% failure rate in message delivery. ${failedMessages} out of ${totalMessages} recent messages failed to deliver. Please check your endpoint URLs and authentication.`,
    metadata: {
      failureRate,
      totalMessages,
      failedMessages,
    },
    actionUrl: consoleLink("/dlq"),
    actionLabel: "View failed deliveries",
  });

  await recordAlertSent(workspaceId, alertType, {
    failureRate,
    totalMessages,
    failedMessages,
  });

  logger.info({
    workspaceId,
    failureRate,
  }, "Delivery failure alert sent");
}

export async function sendApiKeyExpiringAlert(
  workspaceId: string,
  apiKeyName: string,
  apiKeyPrefix: string,
  expiresAt: Date
): Promise<void> {
  const daysUntilExpiry = Math.ceil(
    (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );

  const alertType = `api_key_expiring_${apiKeyPrefix}`;
  const alreadySent = await wasAlertRecentlySent(workspaceId, alertType, 24 * 7);

  if (alreadySent) {
    return;
  }

  await createAndSendNotification({
    workspaceId,
    type: "api_key_expiring",
    priority: daysUntilExpiry <= 3 ? "high" : "medium",
    title: "API Key Expiring Soon",
    message: `Your API key "${apiKeyName}" (${apiKeyPrefix}***) will expire in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? "s" : ""}. Please create a new API key to avoid service interruption.`,
    metadata: {
      apiKeyName,
      apiKeyPrefix,
      expiresAt: expiresAt.toISOString(),
      daysUntilExpiry,
    },
    actionUrl: consoleLink("/settings/api-keys"),
    actionLabel: "Manage API Keys",
  });

  await recordAlertSent(workspaceId, alertType, {
    apiKeyName,
    apiKeyPrefix,
    expiresAt,
    daysUntilExpiry,
  });

  logger.info({
    workspaceId,
    apiKeyName,
    daysUntilExpiry,
  }, "API key expiring alert sent");
}

export async function sendPlanUpgradeNotification(
  workspaceId: string,
  oldPlan: string,
  newPlan: string
): Promise<void> {
  await createAndSendNotification({
    workspaceId,
    type: "plan_upgraded",
    priority: "low",
    title: "Plan Upgraded Successfully",
    message: `Your workspace has been upgraded from ${oldPlan} to ${newPlan}. You now have access to all ${newPlan} features and higher limits.`,
    metadata: {
      oldPlan,
      newPlan,
    },
    actionUrl: consoleLink("/settings/billing"),
    actionLabel: "View Plan Details",
  });

  logger.info({
    workspaceId,
    oldPlan,
    newPlan,
  }, "Plan upgrade notification sent");
}

export async function sendPaymentFailedAlert(
  workspaceId: string,
  amount: number,
  reason?: string
): Promise<void> {
  await createAndSendNotification({
    workspaceId,
    type: "payment_failed",
    priority: "critical",
    title: "Payment Failed",
    message: `We were unable to process your payment of $${(amount / 100).toFixed(2)}. ${reason ? `Reason: ${reason}.` : ""} Please update your payment method to avoid service interruption.`,
    metadata: {
      amount,
      reason,
    },
    actionUrl: consoleLink("/settings/billing"),
    actionLabel: "Update Payment Method",
  });

  logger.info({
    workspaceId,
    amount,
  }, "Payment failed alert sent");
}
