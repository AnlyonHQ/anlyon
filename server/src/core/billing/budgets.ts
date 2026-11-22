import { and, eq, desc, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { keyBudgets, budgetPeriods, budgetReservations } from "../../db/schema/billing.ts";
import { apiKeys } from "../../db/schema/workspaces.ts";
import { redis, RedisKeys } from "../../lib/redis.ts";
import { getMonthKey } from "../../lib/workspace-cache.ts";
import { createLogger } from "../../lib/logger.ts";
import { NotFoundError, ValidationError, ConflictError, ApiError } from "../../utils/errors.ts";
import {
  PER_MESSAGE_COST_CENTS,
  PER_EVENT_PUBLISH_COST_CENTS,
  PER_ACTION_INVOKE_COST_CENTS,
} from "./unit-costs.ts";

const logger = createLogger({ module: "budgets" });

export const BUDGET_DIMENSIONS = [
  "messages",
  "eventPublishes",
  "actionInvokes",
] as const;

export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

export const DIMENSION_UNIT_COST_CENTS: Record<BudgetDimension, number> = {
  messages: PER_MESSAGE_COST_CENTS,
  eventPublishes: PER_EVENT_PUBLISH_COST_CENTS,
  actionInvokes: PER_ACTION_INVOKE_COST_CENTS,
};

const COUNTER_TTL_SECONDS = 2678400;
export interface BudgetConfig {
  workspaceId: string;
  apiKeyId: string;
  monthlyCostCentsCap: number | null;
  dimensionCaps: Partial<Record<BudgetDimension, number>>;
  alertThreshold: number;
  enabled: boolean;
}

export interface BudgetView extends BudgetConfig {
  usage: Record<BudgetDimension, number>;
  estimatedCostCents: number;
  alertedAt: Date | null;
  reconciliationRequired: boolean;
}

function knownDimensionCaps(stored: unknown): Partial<Record<BudgetDimension, number>> {
  const caps = (stored as Partial<Record<string, number>> | null) ?? {};
  return Object.fromEntries(
    Object.entries(caps).filter(([dimension]) => (BUDGET_DIMENSIONS as readonly string[]).includes(dimension)),
  ) as Partial<Record<BudgetDimension, number>>;
}

function toConfig(row: typeof keyBudgets.$inferSelect): BudgetConfig {
  return {
    workspaceId: row.workspaceId,
    apiKeyId: row.apiKeyId,
    monthlyCostCentsCap: row.monthlyCostCentsCap,
    dimensionCaps: knownDimensionCaps(row.dimensionCaps),
    alertThreshold: row.alertThreshold,
    enabled: row.enabled,
  };
}

export async function getBudgetConfig(apiKeyId: string): Promise<BudgetConfig | null> {
  const [row] = await db.select().from(keyBudgets).where(eq(keyBudgets.apiKeyId, apiKeyId));
  return row ? toConfig(row) : null;
}

type BudgetUsage = Record<BudgetDimension, number>;
const MICROCENTS_PER_CENT = 1_000_000;
const unitMicrocents = (dimension: BudgetDimension) => {
  const units = DIMENSION_UNIT_COST_CENTS[dimension] * MICROCENTS_PER_CENT;
  if (!Number.isSafeInteger(units)) throw new Error("Budget price cannot be represented in microcents");
  return BigInt(units);
};
const emptyUsage = (): BudgetUsage => ({ messages: 0, eventPublishes: 0, actionInvokes: 0 });
function usageFromPeriod(row?: typeof budgetPeriods.$inferSelect): BudgetUsage {
  const usage = emptyUsage();
  for (const dimension of BUDGET_DIMENSIONS) usage[dimension] = row?.[dimension] ?? 0;
  return usage;
}
function periodWhere(apiKeyId: string, month: string) {
  return and(eq(budgetPeriods.apiKeyId, apiKeyId), eq(budgetPeriods.month, month));
}

async function readBudgetPeriod(apiKeyId: string, month = getMonthKey()) {
  const [row] = await db.select().from(budgetPeriods).where(periodWhere(apiKeyId, month));
  return row;
}

export async function getBudgetUsage(apiKeyId: string): Promise<BudgetUsage> {
  return usageFromPeriod(await readBudgetPeriod(apiKeyId));
}

export function estimateCostCents(usage: BudgetUsage): number {
  return Number(BUDGET_DIMENSIONS.reduce((sum, dimension) =>
    sum + BigInt(usage[dimension]) * unitMicrocents(dimension), 0n)) / MICROCENTS_PER_CENT;
}

export interface BudgetReservationInput {
  workspaceId: string;
  environmentId: string;
  apiKeyId: string;
  dimension: BudgetDimension;
  amount: number;
  effectId: string;
  fingerprint: string;
}
export interface BudgetReservationResult {
  allowed: boolean;
  usageBefore: BudgetUsage;
  month: string;
  config: BudgetConfig | null;
  reservationId?: string;
  replayed: boolean;
}

export async function reserveBudget(input: BudgetReservationInput): Promise<BudgetReservationResult> {
  const { workspaceId, environmentId, apiKeyId, dimension, amount, effectId, fingerprint } = input;
  if (!BUDGET_DIMENSIONS.includes(dimension) || !Number.isSafeInteger(amount) || amount < 0) {
    throw new ValidationError("Budget quantity must be a nonnegative safe integer");
  }
  if (!effectId || effectId.length > 128 || !fingerprint || fingerprint.length > 128) {
    throw new ValidationError("Budget effect identity and fingerprint are required and bounded");
  }
  const month = getMonthKey();
  return db.transaction(async tx => {
    const [key] = await tx.select({ id: apiKeys.id }).from(apiKeys).where(and(
      eq(apiKeys.id, apiKeyId), eq(apiKeys.workspaceId, workspaceId),
      eq(apiKeys.environmentId, environmentId), eq(apiKeys.isActive, "true"),
    )).for("update");
    if (!key) throw new NotFoundError("Active API key in this environment");
    const [budget] = await tx.select().from(keyBudgets).where(eq(keyBudgets.apiKeyId, apiKeyId)).for("update");
    const config = budget ? toConfig(budget) : null;

    const [previous] = await tx.select().from(budgetReservations).where(and(
      eq(budgetReservations.apiKeyId, apiKeyId), eq(budgetReservations.effectId, effectId),
      eq(budgetReservations.dimension, dimension),
    )).orderBy(desc(sql`${budgetReservations.state} <> 'refunded'`), desc(budgetReservations.createdAt), desc(budgetReservations.id)).limit(1);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.amount !== amount || previous.environmentId !== environmentId) {
        throw new ConflictError("Budget effect identity was already used for different work");
      }
      if (previous.state !== "refunded") {
        const [period] = await tx.select().from(budgetPeriods).where(periodWhere(apiKeyId, previous.month));
        return { allowed: true, usageBefore: usageFromPeriod(period), month: previous.month, config,
          reservationId: previous.id, replayed: true };
      }
    }
    if (!config?.enabled) {
      return { allowed: true, usageBefore: emptyUsage(), month, config, replayed: false };
    }

    await tx.insert(budgetPeriods).values({ apiKeyId, month }).onConflictDoNothing();
    const [period] = await tx.select().from(budgetPeriods).where(periodWhere(apiKeyId, month)).for("update");
    if (period.reconciliationRequired) {
      throw new ApiError(503, "BUDGET_RECONCILIATION_REQUIRED",
        "Legacy budget usage is not yet reconciled. Admission is paused until the operator imports a verified usage floor.");
    }
    const usageBefore = usageFromPeriod(period);
    const next = usageBefore[dimension] + amount;
    if (!Number.isSafeInteger(next)) throw new ValidationError("Budget usage exceeds supported integer range");
    const cost = BigInt(amount) * unitMicrocents(dimension);
    const dimensionCap = config.dimensionCaps[dimension];
    const capMicrocents = config.monthlyCostCentsCap === null ? null : BigInt(config.monthlyCostCentsCap) * BigInt(MICROCENTS_PER_CENT);
    if ((dimensionCap !== undefined && next > dimensionCap) ||
      (capMicrocents !== null && period.costMicrocents + cost > capMicrocents)) {
      return { allowed: false, usageBefore, month, config, replayed: false };
    }
    const [reservation] = await tx.insert(budgetReservations).values({
      workspaceId, environmentId, apiKeyId, dimension, amount, effectId, fingerprint, month, costMicrocents: cost,
    }).returning({ id: budgetReservations.id });
    await tx.update(budgetPeriods).set({ ...usageBefore, [dimension]: next, costMicrocents: period.costMicrocents + cost })
      .where(periodWhere(apiKeyId, month));
    return { allowed: true, usageBefore, month, config, reservationId: reservation.id, replayed: false };
  });
}

export async function settleBudget(reservationId: string): Promise<void> {
  await db.update(budgetReservations).set({ state: "settled", completedAt: new Date() }).where(and(
    eq(budgetReservations.id, reservationId), eq(budgetReservations.state, "reserved"),
  ));
}

type BudgetTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function refundBudget(reservationId: string, transaction?: BudgetTransaction): Promise<void> {
  const refund = async (tx: BudgetTransaction) => {
    const [found] = await tx.select().from(budgetReservations).where(eq(budgetReservations.id, reservationId));
    if (!found) throw new NotFoundError("Budget reservation");
    await tx.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, found.apiKeyId)).for("update");
    const [reservation] = await tx.update(budgetReservations).set({ state: "refunded", completedAt: new Date() }).where(and(
      eq(budgetReservations.id, reservationId), eq(budgetReservations.state, "reserved"),
    )).returning();
    if (!reservation) return;
    const [period] = await tx.select().from(budgetPeriods).where(periodWhere(reservation.apiKeyId, reservation.month)).for("update");
    if (!(BUDGET_DIMENSIONS as readonly string[]).includes(reservation.dimension)) {
      throw new Error("Budget ledger invariant violated; refund aborted");
    }
    if (!period || period[reservation.dimension] < reservation.amount || period.costMicrocents < reservation.costMicrocents) {
      throw new Error("Budget ledger invariant violated; refund aborted");
    }
    await tx.update(budgetPeriods).set({
      [reservation.dimension]: period[reservation.dimension] - reservation.amount,
      costMicrocents: period.costMicrocents - reservation.costMicrocents,
    }).where(periodWhere(reservation.apiKeyId, reservation.month));
  };
  if (transaction) await refund(transaction);
  else await db.transaction(refund);
}

export async function reconcileBudgetPeriod(apiKeyId: string, month: string, floor: BudgetUsage, note: string): Promise<void> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !note.trim() || note.length > 2000) {
    throw new ValidationError("Reconciliation requires a valid period and a bounded evidence note");
  }
  for (const dimension of BUDGET_DIMENSIONS) {
    if (!Number.isSafeInteger(floor[dimension]) || floor[dimension] < 0) {
      throw new ValidationError(`A verified nonnegative floor is required for ${dimension}`);
    }
  }
  await db.transaction(async tx => {
    const [key] = await tx.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, apiKeyId)).for("update");
    if (!key) throw new NotFoundError("API key");
    await tx.insert(budgetPeriods).values({ apiKeyId, month }).onConflictDoNothing();
    const [period] = await tx.select().from(budgetPeriods).where(periodWhere(apiKeyId, month)).for("update");
    const usage = usageFromPeriod(period);
    let cost = period.costMicrocents;
    for (const dimension of BUDGET_DIMENSIONS) {
      const increase = Math.max(0, floor[dimension] - usage[dimension]);
      usage[dimension] += increase;
      cost += BigInt(increase) * unitMicrocents(dimension);
    }
    await tx.update(budgetPeriods).set({ ...usage, costMicrocents: cost, reconciliationRequired: false,
      reconciliationNote: note, reconciledAt: new Date() }).where(periodWhere(apiKeyId, month));
  });
}

export async function claimAlertSlot(apiKeyId: string): Promise<boolean> {
  const key = RedisKeys.keyBudgetAlerted(apiKeyId, getMonthKey());
  const result = await redis.set(key, "1", "EX", COUNTER_TTL_SECONDS, "NX");
  return result === "OK";
}

async function requireKey(
  workspaceId: string,
  apiKeyId: string,
  environmentId?: string,
): Promise<void> {
  const [key] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.id, apiKeyId),
        eq(apiKeys.workspaceId, workspaceId),
        environmentId ? eq(apiKeys.environmentId, environmentId) : undefined,
      ),
    );

  if (!key) throw new NotFoundError("API key");
}

export async function budgetKeyEnvironment(workspaceId: string, apiKeyId: string): Promise<string | null> {
  const [key] = await db
    .select({ environmentId: apiKeys.environmentId })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.workspaceId, workspaceId)));
  return key?.environmentId ?? null;
}

async function toView(row: typeof keyBudgets.$inferSelect): Promise<BudgetView> {
  const period = await readBudgetPeriod(row.apiKeyId);
  const usage = usageFromPeriod(period);
  return {
    ...toConfig(row),
    usage,
    estimatedCostCents: Number(period?.costMicrocents ?? 0n) / MICROCENTS_PER_CENT,
    reconciliationRequired: period?.reconciliationRequired ?? false,
    alertedAt: row.alertedAt,
  };
}

export async function listBudgets(
  workspaceId: string,
  environmentId?: string,
): Promise<BudgetView[]> {
  const rows = await db
    .select({ budget: keyBudgets })
    .from(keyBudgets)
    .innerJoin(apiKeys, eq(apiKeys.id, keyBudgets.apiKeyId))
    .where(
      and(
        eq(keyBudgets.workspaceId, workspaceId),
        environmentId ? eq(apiKeys.environmentId, environmentId) : undefined,
      ),
    );

  return Promise.all(rows.map((row) => toView(row.budget)));
}

export async function getBudget(
  workspaceId: string,
  apiKeyId: string,
  environmentId?: string,
): Promise<BudgetView> {
  await requireKey(workspaceId, apiKeyId, environmentId);

  const [row] = await db
    .select()
    .from(keyBudgets)
    .where(and(eq(keyBudgets.workspaceId, workspaceId), eq(keyBudgets.apiKeyId, apiKeyId)));

  if (!row) throw new NotFoundError("Budget");
  return toView(row);
}

export interface PutBudgetInput {
  monthlyCostCentsCap?: number | null;
  dimensionCaps?: Partial<Record<BudgetDimension, number>>;
  alertThreshold?: number;
  enabled?: boolean;
}

export async function putBudget(
  workspaceId: string,
  apiKeyId: string,
  input: PutBudgetInput,
  environmentId?: string,
): Promise<BudgetView> {
  await requireKey(workspaceId, apiKeyId, environmentId);

  const [existing] = await db
    .select()
    .from(keyBudgets)
    .where(eq(keyBudgets.apiKeyId, apiKeyId));

  let row: typeof keyBudgets.$inferSelect;

  if (existing) {
    [row] = await db
      .update(keyBudgets)
      .set({
        ...(input.monthlyCostCentsCap !== undefined
          ? { monthlyCostCentsCap: input.monthlyCostCentsCap }
          : {}),
        ...(input.dimensionCaps !== undefined ? { dimensionCaps: input.dimensionCaps } : {}),
        ...(input.alertThreshold !== undefined ? { alertThreshold: input.alertThreshold } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(keyBudgets.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(keyBudgets)
      .values({
        workspaceId,
        apiKeyId,
        monthlyCostCentsCap: input.monthlyCostCentsCap ?? null,
        dimensionCaps: input.dimensionCaps ?? {},
        alertThreshold: input.alertThreshold ?? 0.8,
        enabled: input.enabled ?? true,
      })
      .returning();
  }

  logger.info({ workspaceId, apiKeyId }, "Budget saved");
  return toView(row);
}

export async function deleteBudget(
  workspaceId: string,
  apiKeyId: string,
  environmentId?: string,
): Promise<void> {
  await requireKey(workspaceId, apiKeyId, environmentId);

  await db
    .delete(keyBudgets)
    .where(and(eq(keyBudgets.workspaceId, workspaceId), eq(keyBudgets.apiKeyId, apiKeyId)));

  logger.info({ workspaceId, apiKeyId }, "Budget removed");
}

export async function markAlerted(apiKeyId: string): Promise<void> {
  await db
    .update(keyBudgets)
    .set({ alertedAt: new Date() })
    .where(eq(keyBudgets.apiKeyId, apiKeyId));
}
