import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import { createLogger } from "../../lib/logger.ts";
import { ApiError, BudgetExceededError } from "../../utils/errors.ts";
import { emitEvent } from "../../core/events/emitter.ts";
import { createAndSendNotification } from "../../core/notifications/notification-service.ts";
import {
  claimAlertSlot,
  estimateCostCents,
  markAlerted,
  settleBudget,
  reserveBudget,
  DIMENSION_UNIT_COST_CENTS,
  type BudgetDimension,
} from "../../core/billing/budgets.ts";
import { recordBudgetDecision, type BudgetTraceContext } from "../../core/billing/budget-tracing.ts";
import { oauthBudgetKey } from "../../core/billing/oauth-budget.ts";
import { releaseUndispatchedActionBudget } from "../../core/billing/action-accounting.ts";

const logger = createLogger({ module: "budget-guard" });

export type BudgetQuantity = (c: Context) => number;

export function budgetGuard(dimension: BudgetDimension, quantity: BudgetQuantity = () => 1) {
  return async function budgetMiddleware(c: Context, next: Next) {
    if (!["apiKey", "oauth"].includes(c.get("authType"))) {
      await next();
      return;
    }

    const apiKeyId = c.get("authType") === "oauth"
      ? await oauthBudgetKey(c.get("userId"), c.get("oauthClientId"), c.get("workspaceId"), c.get("environmentId"))
      : c.get("apiKeyId") as string | undefined;
    if (c.get("authType") === "oauth") c.set("apiKeyId", apiKeyId);
    if (!apiKeyId) {
      await next();
      return;
    }

    const startedAt = new Date();
    const trace = await getTraceContext(c);
    const workspaceId = c.get("workspaceId") as string;
    const requestId = c.get("requestId") as string;
    const units = quantity(c);
    const reservation = await reserveBudget({
      apiKeyId, workspaceId, environmentId: c.get("environmentId") as string,
      dimension, amount: units,
      effectId: (c.get("budgetEffectId") as string | undefined) ?? randomUUID(),
      fingerprint: (c.get("budgetFingerprint") as string | undefined) ?? randomUUID(),
    });
    if (reservation.replayed) {
      throw new ApiError(409, "BUDGET_EFFECT_ALREADY_RESERVED",
        "This request already has a durable budget reservation. Its original result is unavailable; reconcile the original outcome before retrying.",
        { reservationId: reservation.reservationId, month: reservation.month, dimension, units });
    }
    const config = reservation.config;
    c.set("budgetReservationId", reservation.reservationId);
    if (!config?.enabled) {
      try {
        await next();
      } finally {
        if (dimension === "actionInvokes" && reservation.reservationId && (c.error || c.res.status >= 400)) {
          await releaseUndispatchedActionBudget(workspaceId, reservation.reservationId);
        }
      }
      return;
    }
    const dimensionCap = config.dimensionCaps[dimension];

    const usageBefore = reservation.usageBefore[dimension];
    const spendBeforeCents = estimateCostCents(reservation.usageBefore);
    const requestCostCents = units * DIMENSION_UNIT_COST_CENTS[dimension];
    const projected = spendBeforeCents + requestCostCents;

    const recordDecision = (allowed: boolean, dimensionCap?: number) =>
      recordBudgetDecision(workspaceId, trace, {
        id: `budget_${dimension}_${requestId}`,
        dimension,
        allowed,
        startedAt,
        units,
        reservationId: reservation.reservationId,
        month: reservation.month,
        usageBefore,
        usageAfter: usageBefore + (allowed ? units : 0),
        dimensionCap,
        spendBeforeCents,
        projectedSpendCents: projected,
        monthlyCapCents: config.monthlyCostCentsCap,
      });

    if (!reservation.allowed) {
      await recordDecision(false, dimensionCap);

      const request = units === 1 ? "this request" : `this request (${units} ${dimension})`;
      if (dimensionCap !== undefined && usageBefore + units > dimensionCap) {
        throw new BudgetExceededError(
          `Budget exceeded for this API key: ${request} would exceed the ${dimension} cap of ${dimensionCap.toLocaleString()} for this month (${usageBefore.toLocaleString()} used).`
        );
      }
      throw new BudgetExceededError(
        `Budget exceeded for this API key: ${request} would exceed the ${formatCents(config.monthlyCostCentsCap ?? 0)} monthly cap (${formatCents(spendBeforeCents)} used).`
      );
    }

    if (
      config.monthlyCostCentsCap !== null &&
      config.monthlyCostCentsCap > 0 &&
      projected / config.monthlyCostCentsCap >= config.alertThreshold
    ) {
      void alertOnce(config.workspaceId, c.get("environmentId") as string | undefined, apiKeyId, projected, config.monthlyCostCentsCap);
    }

    let handlerReturned = false;
    try {
      await next();
      handlerReturned = true;

      if (dimension !== "actionInvokes" && c.res.status >= 200 && c.res.status < 300 && reservation.reservationId) {
        await settleBudget(reservation.reservationId);
      }
    } finally {
      if (dimension === "actionInvokes" && reservation.reservationId && (!handlerReturned || c.error || c.res.status >= 400)) {
        await releaseUndispatchedActionBudget(workspaceId, reservation.reservationId);
      }
      await recordDecision(true, dimensionCap);
    }
  };
}

async function getTraceContext(c: Context): Promise<BudgetTraceContext | undefined> {
  let body = c.get("validatedBody") as { runId?: string; parentSpanId?: string } | undefined;
  if (!body && c.req.method !== "GET") {
    try {
      body = await c.req.raw.clone().json() as { runId?: string; parentSpanId?: string };
    } catch {
    }
  }
  const runId = body?.runId;
  const environmentId = c.get("environmentId") as string | undefined;
  if (!runId || !environmentId) return undefined;
  return { runId, environmentId, parentSpanId: body?.parentSpanId };
}

async function alertOnce(
  workspaceId: string,
  environmentId: string | undefined,
  apiKeyId: string,
  spentCents: number,
  capCents: number
): Promise<void> {
  try {
    const claimed = await claimAlertSlot(apiKeyId);
    if (!claimed) return;

    const percent = Math.round((spentCents / capCents) * 100);

    emitEvent(workspaceId, "budget.alert", {
      environmentId,
      apiKeyId,
      spentCents,
      capCents,
      percent,
    });

    await createAndSendNotification({
      workspaceId,
      type: "budget_alert",
      priority: "high",
      title: `API key budget ${percent}% consumed`,
      message: `An API key has used ${formatCents(spentCents)} of its ${formatCents(capCents)} monthly budget. Requests are rejected with BUDGET_EXCEEDED once the cap is reached.`,
      metadata: { apiKeyId, spentCents, capCents, percent },
      actionUrl: "/settings/api-keys",
      actionLabel: "Review budgets",
    });

    await markAlerted(apiKeyId);
    logger.info({ workspaceId, apiKeyId, percent }, "Budget alert fired");
  } catch (error) {
    logger.warn({ workspaceId, apiKeyId, error }, "Failed to fire budget alert");
  }
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
