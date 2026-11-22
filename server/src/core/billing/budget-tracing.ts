import { getRunWithTree, ingestSpans } from "../runs/service.ts";
import type { BudgetDimension } from "./budgets.ts";

export type BudgetTraceContext = {
  runId: string;
  environmentId: string;
  parentSpanId?: string;
};

export type PlanQuotaDecision = {
  id: string;
  allowed: boolean;
  startedAt: Date;
  messageCount: number;
  messageSize: number;
  dailyUsage: number;
  monthlyUsage: number;
  bandwidthUsage: number;
  dailyCap: number | null;
  monthlyCap: number | null;
  bandwidthCap: number | null;
  messageSizeCap: number;
  rejectedDimension?: "message_size" | "messages_daily" | "messages_monthly" | "bandwidth";
};

export async function recordBudgetDecision(
  workspaceId: string,
  trace: BudgetTraceContext | undefined,
  input: {
    id: string;
    dimension: BudgetDimension;
    allowed: boolean;
    startedAt: Date;
    units: number;
    reservationId?: string;
    month?: string;
    usageBefore: number;
    usageAfter: number;
    dimensionCap?: number;
    spendBeforeCents: number;
    projectedSpendCents: number;
    monthlyCapCents?: number | null;
  }
): Promise<void> {
  if (!trace) return;
  try {
    const scope = { workspaceId, environmentId: trace.environmentId };
    await getRunWithTree(scope, trace.runId);
    await ingestSpans(scope, trace.runId, [{
      id: input.id,
      ...(trace.parentSpanId ? { parentId: trace.parentSpanId } : {}),
      name: "Enforce API key budget",
      type: "budget_check",
      status: input.allowed ? "succeeded" : "failed",
      startedAt: input.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      ...(input.allowed ? {} : { error: { code: "BUDGET_EXCEEDED" } }),
      attributes: {
        dimension: input.dimension,
        decision: input.allowed ? "allowed" : "rejected",
        units: input.units,
        reservationId: input.reservationId ?? null,
        month: input.month ?? null,
        usageBefore: input.usageBefore,
        usageAfter: input.usageAfter,
        dimensionCap: input.dimensionCap ?? null,
        spendBeforeCents: input.spendBeforeCents,
        projectedSpendCents: input.projectedSpendCents,
        monthlyCapCents: input.monthlyCapCents ?? null,
      },
    }]);
  } catch {
  }
}

export async function recordPlanQuotaDecision(
  workspaceId: string,
  trace: BudgetTraceContext | undefined,
  input: PlanQuotaDecision
): Promise<void> {
  if (!trace) return;
  try {
    const scope = { workspaceId, environmentId: trace.environmentId };
    await getRunWithTree(scope, trace.runId);
    await ingestSpans(scope, trace.runId, [{
      id: input.id,
      ...(trace.parentSpanId ? { parentId: trace.parentSpanId } : {}),
      name: "Enforce workspace plan quota",
      type: "budget_check",
      status: input.allowed ? "succeeded" : "failed",
      startedAt: input.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      ...(input.allowed ? {} : { error: { code: "QUOTA_EXCEEDED" } }),
      attributes: {
        scope: "workspace_plan",
        dimension: input.rejectedDimension ?? "message_publish",
        decision: input.allowed ? "allowed" : "rejected",
        messageCount: input.messageCount,
        messageSize: input.messageSize,
        dailyUsage: input.dailyUsage,
        monthlyUsage: input.monthlyUsage,
        bandwidthUsage: input.bandwidthUsage,
        dailyCap: input.dailyCap,
        monthlyCap: input.monthlyCap,
        bandwidthCap: input.bandwidthCap,
        messageSizeCap: input.messageSizeCap,
      },
    }]);
  } catch {
  }
}
