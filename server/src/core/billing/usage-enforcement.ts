import { limitAdvice } from "./limit-advice.ts";
import { db } from "../../db/index.ts";
import { getDurableMessageUsage } from "./message-accounting.ts";
import { resourcePlan } from "./plan-management.ts";
import { workspaces, workspaceMembers } from "../../db/schema/workspaces.ts";
import { workspaceInvitations } from "../../db/schema/invitations.ts";
import { usageLogs, workspaceUsagePeriods } from "../../db/schema/billing.ts";
import { actions, workspaceSecrets } from "../../db/schema/actions.ts";
import { approvals } from "../../db/schema/approvals.ts";
import { eq, and, gte, gt, ne, sql, count, isNull } from "drizzle-orm";
import { getPlanLimits, getNumericLimit, isBandwidthExceeded, type PlanType } from "../plans/limits.ts";
import { ApiError, NotFoundError } from "../../utils/errors.ts";
import {
  getMonthlyEventPublishes,
  getMonthlyActionInvokes,
  getMonthKey,
} from "../../lib/workspace-cache.ts";
import { logger } from "../../lib/logger.ts";
import { env } from "../../config/env.ts";

export class QuotaExceededError extends ApiError {
  constructor(message: string, public remainingQuota?: number) {
    super(429, "QUOTA_EXCEEDED", message, remainingQuota != null ? { remainingQuota } : undefined);
    this.name = "QuotaExceededError";
  }
}

export class PaymentRequiredError extends ApiError {
  constructor(message = `This workspace has no plan, so actions are not run. Choose a plan at ${billingSettingsUrl()} to run actions.`) {
    super(402, "PAYMENT_REQUIRED", message, { billingUrl: billingSettingsUrl() });
    this.name = "PaymentRequiredError";
  }
}

export class PlanFeatureRequiredError extends ApiError {
  constructor(feature: string, message = `This needs the Team plan. Upgrade at ${billingSettingsUrl()}. Existing settings keep working.`) {
    super(403, "PLAN_FEATURE_REQUIRED", message, { feature, requiredPlan: "growth" });
    this.name = "PlanFeatureRequiredError";
  }
}

export function billingSettingsUrl(): string {
  return `${env.CONSOLE_URL.replace(/\/$/, "")}/settings/billing`;
}

export class FeatureNotAvailableError extends ApiError {
  constructor(message: string, public requiredPlan?: PlanType) {
    super(
      403,
      "FEATURE_NOT_AVAILABLE",
      message,
      requiredPlan ? { requiredPlan } : undefined
    );
    this.name = "FeatureNotAvailableError";
  }
}

type BillingTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function checkSeatLimit(workspaceId: string, tx: BillingTransaction, acceptingInvitationId?: string) {
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
  if (!workspace) throw new NotFoundError("Workspace");
  const cap = getPlanLimits(resourcePlan(workspace), workspace).maxSeats;
  if (cap === "unlimited") return;
  const [{ members }] = await tx.select({ members: count() }).from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  const [{ invitations }] = await tx.select({ invitations: count() }).from(workspaceInvitations).where(and(
    eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.status, "pending"),
    gt(workspaceInvitations.expiresAt, new Date()),
    acceptingInvitationId ? ne(workspaceInvitations.id, acceptingInvitationId) : undefined,
  ));
  if (members + invitations + 1 > cap) {
    throw new QuotaExceededError(`Your plan allows ${cap} seats, including pending invitations. Remove a member or invitation. ${limitAdvice("resource", "seats")}`);
  }
}

export interface UsageStats {
  messagesPublished: number;
  messagesDelivered: number;
  messagesFailed: number;
  totalBandwidth: number;
}

export interface QuotaStatus {
  plan: PlanType;
  limits: {
    messagesPerDay: number | "unlimited";
    messagesPerMonth: number | "unlimited";
    bandwidth: number;
  };
  usage: {
    messagesToday: number;
    messagesThisMonth: number;
    bandwidthThisMonth: number;
  };
  remaining: {
    messagesToday: number | "unlimited";
    messagesThisMonth: number | "unlimited";
    bandwidth: number | "unlimited";
  };
  isWithinLimits: boolean;
}

export async function getWorkspaceUsage(workspaceId: string): Promise<UsageStats> {
  const firstDayOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    .toISOString()
    .split("T")[0];

  const monthlyUsage = await db
    .select()
    .from(usageLogs)
    .where(and(eq(usageLogs.workspaceId, workspaceId), gte(usageLogs.date, firstDayOfMonth)));

  const stats: UsageStats = {
    messagesPublished: 0,
    messagesDelivered: 0,
    messagesFailed: 0,
    totalBandwidth: 0,
  };

  for (const log of monthlyUsage) {
    stats.messagesPublished += Number(log.messagesPublished || 0);
    stats.messagesDelivered += Number(log.messagesDelivered || 0);
    stats.messagesFailed += Number(log.messagesFailed || 0);
  }

  return stats;
}

export async function getQuotaStatus(workspaceId: string): Promise<QuotaStatus> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));

  if (!workspace) {
    throw new NotFoundError("Workspace");
  }

  const plan = workspace.plan as PlanType;
  const limits = getPlanLimits(plan, workspace);

  const durable = await getDurableMessageUsage(workspaceId);
  const currentMonthMessages = durable.messages;
  const currentMonthBandwidth = durable.bandwidth;

  const today = new Date().toISOString().split("T")[0];
  const [todayLog] = await db
    .select()
    .from(usageLogs)
    .where(and(eq(usageLogs.workspaceId, workspaceId), eq(usageLogs.date, today)));

  const messagesToday = Number(todayLog?.messagesPublished || 0);

  const dailyLimit = getNumericLimit(limits.maxMessagesPerDay);
  const monthlyLimit = getNumericLimit(limits.maxMonthlyMessages);
  const bandwidthLimit = limits.maxMonthlyBandwidth;

  const remainingDaily =
    limits.maxMessagesPerDay === "unlimited" ? "unlimited" : Math.max(0, dailyLimit - messagesToday);

  const remainingMonthly =
    limits.maxMonthlyMessages === "unlimited"
      ? "unlimited"
      : Math.max(0, monthlyLimit - currentMonthMessages);

  const remainingBandwidth =
    bandwidthLimit === Number.MAX_SAFE_INTEGER
      ? "unlimited"
      : Math.max(0, bandwidthLimit - currentMonthBandwidth);

  const isWithinLimits =
    (limits.maxMessagesPerDay === "unlimited" || messagesToday < dailyLimit) &&
    (limits.maxMonthlyMessages === "unlimited" || currentMonthMessages < monthlyLimit) &&
    currentMonthBandwidth < bandwidthLimit;

  return {
    plan,
    limits: {
      messagesPerDay: limits.maxMessagesPerDay,
      messagesPerMonth: limits.maxMonthlyMessages,
      bandwidth: limits.maxMonthlyBandwidth,
    },
    usage: {
      messagesToday,
      messagesThisMonth: currentMonthMessages,
      bandwidthThisMonth: currentMonthBandwidth,
    },
    remaining: {
      messagesToday: remainingDaily,
      messagesThisMonth: remainingMonthly,
      bandwidth: remainingBandwidth,
    },
    isWithinLimits,
  };
}

export async function checkMessageQuota(
  workspaceId: string,
  messageCount: number = 1,
  messageSize: number = 0
): Promise<void> {
  const quotaStatus = await getQuotaStatus(workspaceId);
  const limits = getPlanLimits(quotaStatus.plan);

  if (messageSize > limits.maxMessageSize) {
    throw new QuotaExceededError(
      `Message size (${messageSize} bytes) exceeds plan limit (${limits.maxMessageSize} bytes)`,
      0
    );
  }

  if (limits.maxMessagesPerDay !== "unlimited") {
    const remainingDaily =
      quotaStatus.remaining.messagesToday === "unlimited"
        ? Number.MAX_SAFE_INTEGER
        : quotaStatus.remaining.messagesToday;

    if (messageCount > remainingDaily) {
      throw new QuotaExceededError(
        `Daily message limit exceeded. ${remainingDaily} messages remaining today.`,
        remainingDaily
      );
    }
  }

  if (limits.maxMonthlyMessages !== "unlimited") {
    const remainingMonthly =
      quotaStatus.remaining.messagesThisMonth === "unlimited"
        ? Number.MAX_SAFE_INTEGER
        : quotaStatus.remaining.messagesThisMonth;

    if (messageCount > remainingMonthly) {
      throw new QuotaExceededError(
        `Monthly message limit exceeded. ${remainingMonthly} messages remaining this month.`,
        remainingMonthly
      );
    }
  }

  if (messageSize > 0) {
    const totalNewBandwidth = messageSize * messageCount;
    const projectedBandwidth = quotaStatus.usage.bandwidthThisMonth + totalNewBandwidth;

    if (isBandwidthExceeded(quotaStatus.plan, projectedBandwidth)) {
      const remainingBandwidth =
        quotaStatus.remaining.bandwidth === "unlimited"
          ? Number.MAX_SAFE_INTEGER
          : quotaStatus.remaining.bandwidth;

      throw new QuotaExceededError(
        `Monthly bandwidth limit exceeded. ${remainingBandwidth} bytes remaining this month. ${limitAdvice("monthly")}`,
        remainingBandwidth
      );
    }

  }

  logger.debug(
    {
      workspaceId,
      messageCount,
      messageSize,
      plan: quotaStatus.plan,
    },
    "Message quota check passed"
  );
}

export async function checkCustomHeadersQuota(_workspaceId: string): Promise<void> {
}

export async function checkWebhooksQuota(_workspaceId: string): Promise<void> {
}

export async function checkEventPublishQuota(
  workspaceId: string,
  adding: number = 1
): Promise<void> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) {
    throw new NotFoundError("Workspace");
  }

  const limits = getPlanLimits(workspace.plan as PlanType, workspace);
  if (limits.maxMonthlyEventPublishes === "unlimited") return;

  const used = await getMonthlyEventPublishes(workspaceId);
  if (used + adding > limits.maxMonthlyEventPublishes) {
    throw new QuotaExceededError(
      `Free plan allows up to ${limits.maxMonthlyEventPublishes.toLocaleString()} event publishes per month. ` +
        `You have used ${used.toLocaleString()}. ${limitAdvice("monthly")}`,
      0
    );
  }
}

export async function checkActionInvokeQuota(
  workspaceId: string,
  adding: number = 1
): Promise<void> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) {
    throw new NotFoundError("Workspace");
  }

  const policy = getPlanLimits(workspace.plan as PlanType, workspace).usagePolicy.actionInvokes;
  if (policy.kind === "unlimited") return;

  const month = getMonthKey();
  const [period] = await db.select().from(workspaceUsagePeriods).where(and(
    eq(workspaceUsagePeriods.workspaceId, workspaceId), eq(workspaceUsagePeriods.month, month),
  ));
  const used = (period?.actionBilled ?? 0) + (period?.actionReserved ?? 0);
  const { actionCreditUnits, assertActionAdmissible } = await import("./action-allowance.ts");
  assertActionAdmissible(policy, used, await actionCreditUnits(db, workspaceId, month), adding);
}

export async function assertActionsEntitled(workspaceId: string): Promise<void> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new NotFoundError("Workspace");
  if (getPlanLimits(workspace.plan as PlanType, workspace).usagePolicy.actionInvokes.kind === "payment-required") {
    throw new PaymentRequiredError();
  }
}

export async function checkPendingApprovalQuota(workspaceId: string, query: Pick<typeof db, "select"> = db): Promise<void> {
  const [workspace] = await query.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) {
    throw new NotFoundError("Workspace");
  }

  const limits = getPlanLimits(workspace.plan as PlanType, workspace);
  if (limits.maxPendingApprovals === "unlimited") return;

  const [{ pendingCount }] = await query
    .select({ pendingCount: count() })
    .from(approvals)
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "pending")));

  if (pendingCount >= limits.maxPendingApprovals) {
    throw new QuotaExceededError(
      `Free plan allows up to ${limits.maxPendingApprovals} pending approvals. ` +
        `You have ${pendingCount}. Decide some pending approvals to make room.`,
      0
    );
  }
}

export async function checkSecretQuota(workspaceId: string): Promise<void> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) {
    throw new NotFoundError("Workspace");
  }

  const limits = getPlanLimits(workspace.plan as PlanType, workspace);
  if (limits.maxSecrets === "unlimited") return;

  const [{ secretCount }] = await db
    .select({ secretCount: count() })
    .from(workspaceSecrets)
    .where(eq(workspaceSecrets.workspaceId, workspaceId));

  if (secretCount >= limits.maxSecrets) {
    throw new QuotaExceededError(
      `Free plan allows up to ${limits.maxSecrets} secrets. ` +
        `You have ${secretCount}. ${limitAdvice("resource", "secrets")}`,
      0
    );
  }
}

export async function checkActionQuota(workspaceId: string, tx?: BillingTransaction): Promise<void> {
  if (!tx) return db.transaction(transaction => checkActionQuota(workspaceId, transaction));
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
  if (!workspace) {
    throw new NotFoundError("Workspace");
  }

  const limits = getPlanLimits(resourcePlan(workspace), workspace);
  if (limits.maxActions === "unlimited") return;

  const [{ actionCount }] = await tx
    .select({ actionCount: count() })
    .from(actions)
    .where(and(eq(actions.workspaceId, workspaceId), isNull(actions.archivedAt)));

  if (actionCount >= limits.maxActions) {
    throw new QuotaExceededError(
      `Free plan allows up to ${limits.maxActions} actions. ` +
        `You have ${actionCount}. ${limitAdvice("resource", "actions")}`,
      0
    );
  }
}

export async function getMaxRetries(workspaceId: string): Promise<number> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));

  if (!workspace) {
    throw new NotFoundError("Workspace");
  }

  const plan = workspace.plan as PlanType;
  const limits = getPlanLimits(plan, workspace);

  return limits.maxRetries;
}

export async function getMaxHttpTimeout(workspaceId: string): Promise<number> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));

  if (!workspace) {
    throw new NotFoundError("Workspace");
  }

  const plan = workspace.plan as PlanType;
  const limits = getPlanLimits(plan, workspace);

  return limits.maxHttpTimeout;
}

export async function incrementUsage(
  workspaceId: string,
  messageCount: number = 1,
  bandwidth: number = 0
): Promise<void> {
  await db
    .update(workspaces)
    .set({
      currentMonthMessages: sql`${workspaces.currentMonthMessages} + ${messageCount}`,
      currentMonthBandwidth: sql`${workspaces.currentMonthBandwidth} + ${bandwidth}`,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));

  logger.debug(
    {
      workspaceId,
      messageCount,
      bandwidth,
    },
    "Usage incremented atomically"
  );
}

export async function resetMonthlyUsage(workspaceId: string): Promise<void> {
  await db
    .update(workspaces)
    .set({
      currentMonthMessages: 0,
      currentMonthBandwidth: 0,
      usageResetDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));

  logger.info({ workspaceId }, "Monthly usage reset");
}
