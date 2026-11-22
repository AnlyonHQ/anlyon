import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { workspaces } from "../db/schema/workspaces.ts";
import { NotFoundError } from "../utils/errors.ts";
import { getQuotaStatus } from "../core/billing/usage-enforcement.ts";
import { getAvailableFeatures } from "../core/billing/feature-gates.ts";
import { getActionAllowance } from "../core/billing/action-allowance.ts";
import { getUsageAllowances } from "../core/billing/allowances.ts";
import { getFunctionRunUsage } from "../core/functions/admission.ts";
import { hostedFunctionsAvailable } from "../core/functions/availability.ts";
import { formatBytes, getPlanLimits, type PlanType } from "../core/plans/limits.ts";

type WorkspaceRow = typeof workspaces.$inferSelect;

export function planLimitsView(limits: ReturnType<typeof getPlanLimits>) {
  return {
    maxSeats: limits.maxSeats,
    maxEnvironments: limits.maxEnvironments,
    maxActions: limits.maxActions,
    maxMonthlyActionInvokes: limits.maxMonthlyActionInvokes,
    auditRetentionMonths: limits.auditRetentionMonths,
    traceRetentionDays: limits.traceRetentionDays,
    traceArchival: limits.traceArchival,
    usagePolicy: limits.usagePolicy,
    maxMessagesPerDay: limits.maxMessagesPerDay,
    maxMonthlyMessages: limits.maxMonthlyMessages,
    maxMonthlyBandwidth: limits.maxMonthlyBandwidth,
    maxRetries: limits.maxRetries,
    maxMessageSize: limits.maxMessageSize,
    maxHttpTimeout: limits.maxHttpTimeout,
    rateLimit: limits.rateLimit,
    maxBatchSize: limits.maxBatchSize,
    maxConcurrentDeliveries: limits.maxConcurrentDeliveries,
    analyticsRetentionDays: limits.analyticsRetentionDays,
    logRetentionDays: limits.logRetentionDays,
    maxMonthlyAssistantReviews: limits.maxMonthlyAssistantReviews,
    maxDailyAssistantAutoApprovals: limits.maxDailyAssistantAutoApprovals,
    maxApprovalPoliciesPerEnvironment: limits.maxApprovalPoliciesPerEnvironment,
    maxMonthlyConditionDrafts: limits.maxMonthlyConditionDrafts,
    functionRuns: limits.functionRuns,
    features: limits.features,
    pricing: limits.pricing,
  };
}

export async function viewWorkspace(workspaceId: string): Promise<WorkspaceRow> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new NotFoundError("Workspace");
  return workspace;
}

export async function planLimitsSection(workspace: WorkspaceRow) {
  const limits = getPlanLimits(workspace.plan as PlanType, workspace);
  const features = await getAvailableFeatures(workspace.id);
  return {
    limits: planLimitsView(limits),
    features,
    pricing: {
      monthlyFee: limits.pricing.monthlyFee / 100,
      perMessageCost: limits.pricing.perMessageCost,
      includedMessages: limits.pricing.includedMessages,
      bandwidthOverageCost: limits.pricing.bandwidthOverageCost / 100,
      includedBandwidth: formatBytes(limits.includedBandwidth),
    },
  };
}

export async function getPlanView(c: Context) {
  const workspace = await viewWorkspace(c.get("workspaceId"));
  const section = await planLimitsSection(workspace);
  return c.json({
    success: true,
    data: {
      plan: workspace.plan as PlanType,
      interval: workspace.billingInterval ?? null,
      trialEndsAt: workspace.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: workspace.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: workspace.cancelAtPeriodEnd,
      pendingPlan: workspace.pendingPlan,
      ...section,
    },
  });
}

async function functionRunsView(workspaceId: string) {
  return { ...(await getFunctionRunUsage(workspaceId)), available: hostedFunctionsAvailable() };
}

export async function getCurrentUsageView(c: Context) {
  const workspaceId = c.get("workspaceId");
  const workspace = await viewWorkspace(workspaceId);

  const quotaStatus = await getQuotaStatus(workspaceId);
  const allowances = await getUsageAllowances(workspaceId);
  const estimatedCost = (allowances.monthlyFeeCents + allowances.projectedOverageCents) / 100;

  const now = new Date();
  const billingPeriodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const billingPeriodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1).toISOString();
  const usageResetDate = workspace.usageResetDate?.toISOString()
    ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

  return c.json({
    success: true,
    data: {
      currentMonthMessages: quotaStatus.usage.messagesThisMonth,
      currentMonthBandwidth: quotaStatus.usage.bandwidthThisMonth,
      dailyMessages: quotaStatus.usage.messagesToday,
      estimatedCost,
      billingPeriodStart,
      billingPeriodEnd,
      usageResetDate,
      actionAllowance: await getActionAllowance(workspaceId),
      functionRuns: await functionRunsView(workspaceId),
    },
  });
}

export async function getQuotaView(c: Context) {
  const workspaceId = c.get("workspaceId");

  const quotaStatus = await getQuotaStatus(workspaceId);
  const [quotaWorkspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const limits = getPlanLimits(quotaStatus.plan, quotaWorkspace);

  const allowances = await getUsageAllowances(workspaceId);

  const dailyPercentage = quotaStatus.limits.messagesPerDay === "unlimited"
    ? 0
    : Math.round((quotaStatus.usage.messagesToday / (quotaStatus.limits.messagesPerDay as number)) * 100);

  const monthlyPercentage = quotaStatus.limits.messagesPerMonth === "unlimited" || !quotaStatus.limits.messagesPerMonth
    ? 0
    : Math.round((quotaStatus.usage.messagesThisMonth / (quotaStatus.limits.messagesPerMonth as number)) * 100);

  const bandwidthPercentage = limits.maxMonthlyBandwidth === Number.MAX_SAFE_INTEGER
    ? 0
    : Math.round((quotaStatus.usage.bandwidthThisMonth / limits.maxMonthlyBandwidth) * 100);

  return c.json({
    success: true,
    data: {
      plan: quotaStatus.plan,
      allowances,
      actionInvokes: allowances.actionInvokes,
      actionAllowance: await getActionAllowance(workspaceId),
      functionRuns: await functionRunsView(workspaceId),
      projectedOverageCents: allowances.projectedOverageCents,
      daily: {
        used: quotaStatus.usage.messagesToday,
        limit: quotaStatus.limits.messagesPerDay,
        percentage: dailyPercentage,
      },
      monthly: {
        ...allowances.messages,
        used: quotaStatus.usage.messagesThisMonth,
        limit: quotaStatus.limits.messagesPerMonth,
        percentage: monthlyPercentage,
      },
      bandwidth: {
        ...allowances.bandwidth,
        used: quotaStatus.usage.bandwidthThisMonth,
        limit: limits.maxMonthlyBandwidth,
        percentage: bandwidthPercentage,
      },
    },
  });
}
