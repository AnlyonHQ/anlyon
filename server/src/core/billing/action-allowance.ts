import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaceActionCredits, workspaceUsagePeriods } from "../../db/schema/billing.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { getMonthKey } from "../../lib/workspace-cache.ts";
import { NotFoundError } from "../../utils/errors.ts";
import { limitAdvice, nextUsageReset } from "./limit-advice.ts";
import { ACTION_PACK_VALID_MONTHS, actionCapUnits, getPlanLimits, type UsagePolicy } from "../plans/limits.ts";
import { PaymentRequiredError, QuotaExceededError } from "./usage-enforcement.ts";

type Reader = Pick<typeof db, "select">;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function actionPackExpiry(grantedAt: Date): Date {
  const expires = new Date(grantedAt.getTime());
  expires.setUTCMonth(expires.getUTCMonth() + ACTION_PACK_VALID_MONTHS);
  return expires;
}

export function includedActionUnits(policy: UsagePolicy): number | null {
  return policy.kind === "included-with-grace" ? policy.includedUnits
    : policy.kind === "hard-cap" ? policy.capUnits : null;
}

const activeCredits = (workspaceId: string, now: Date) => and(
  eq(workspaceActionCredits.workspaceId, workspaceId),
  isNull(workspaceActionCredits.revokedAt),
  gt(workspaceActionCredits.expiresAt, now),
);

export async function actionCreditUnits(query: Reader, workspaceId: string, month = getMonthKey(), now = new Date()): Promise<number> {
  const [left] = await query.select({ units: sql<string>`coalesce(sum(${workspaceActionCredits.units} - ${workspaceActionCredits.usedUnits}), 0)` })
    .from(workspaceActionCredits).where(activeCredits(workspaceId, now));
  const [period] = await query.select({ drawn: workspaceUsagePeriods.actionCreditsDrawn }).from(workspaceUsagePeriods)
    .where(and(eq(workspaceUsagePeriods.workspaceId, workspaceId), eq(workspaceUsagePeriods.month, month)));
  return Number(left?.units ?? 0) + Number(period?.drawn ?? 0);
}

export interface CreditRow { id: string; units: number; usedUnits: number; expiresAt: Date }
export interface CreditMove { id: string; usedUnits: number }

export function planCreditDraw(input: {
  used: number; adding: number; included: number; drawn: number; credits: CreditRow[];
}): { drawn: number; moves: CreditMove[]; remaining: number } {
  const target = Math.max(0, input.used + input.adding - input.included);
  const credits = input.credits.map((credit) => ({ ...credit }));
  const moves: CreditMove[] = [];
  let drawn = input.drawn;
  if (target > drawn) {
    let need = target - drawn;
    for (const credit of [...credits].sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())) {
      if (need <= 0) break;
      const take = Math.min(need, credit.units - credit.usedUnits);
      if (take <= 0) continue;
      credit.usedUnits += take;
      need -= take;
      drawn += take;
      moves.push({ id: credit.id, usedUnits: credit.usedUnits });
    }
  } else if (target < drawn) {
    let surplus = drawn - target;
    for (const credit of [...credits].sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())) {
      if (surplus <= 0) break;
      const back = Math.min(surplus, credit.usedUnits);
      if (back <= 0) continue;
      credit.usedUnits -= back;
      surplus -= back;
      drawn -= back;
      moves.push({ id: credit.id, usedUnits: credit.usedUnits });
    }
  }
  const remaining = credits.reduce((total, credit) => total + credit.units - credit.usedUnits, 0);
  return { drawn, moves, remaining };
}

export async function drawActionCredits(tx: Transaction, input: {
  workspaceId: string; month: string; policy: UsagePolicy; used: number; adding: number; drawn: number; now?: Date;
}): Promise<number> {
  const included = includedActionUnits(input.policy);
  if (included === null) return 0;
  if (input.used + input.adding <= included && input.drawn === 0) return 0;
  const now = input.now ?? new Date();
  const credits = await tx.select({
    id: workspaceActionCredits.id, units: workspaceActionCredits.units,
    usedUnits: workspaceActionCredits.usedUnits, expiresAt: workspaceActionCredits.expiresAt,
  }).from(workspaceActionCredits).where(activeCredits(input.workspaceId, now))
    .orderBy(asc(workspaceActionCredits.expiresAt), desc(workspaceActionCredits.grantedAt)).for("update");
  const plan = planCreditDraw({ used: input.used, adding: input.adding, included, drawn: input.drawn, credits });
  for (const move of plan.moves) {
    await tx.update(workspaceActionCredits).set({ usedUnits: move.usedUnits }).where(eq(workspaceActionCredits.id, move.id));
  }
  if (plan.drawn !== input.drawn) {
    await tx.update(workspaceUsagePeriods).set({ actionCreditsDrawn: plan.drawn }).where(and(
      eq(workspaceUsagePeriods.workspaceId, input.workspaceId), eq(workspaceUsagePeriods.month, input.month),
    ));
  }
  return plan.drawn + plan.remaining;
}

export function assertActionAdmissible(policy: UsagePolicy, used: number, credits: number, adding = 1): void {
  if (policy.kind === "payment-required") throw new PaymentRequiredError();
  const cap = actionCapUnits(policy, credits);
  if (cap === null || used + adding <= cap) return;
  if (policy.kind === "included-with-grace") {
    throw new QuotaExceededError(
      `Monthly action limit of ${cap.toLocaleString("en-US")} reached: the plan's ${policy.includedUnits.toLocaleString("en-US")} ` +
        `actions, a 10% buffer${credits ? ` and ${credits.toLocaleString("en-US")} from action packs` : ""}. ` +
        `Upgrade the plan or buy an action pack (100,000 actions for $10, valid for 12 months) from Settings > Billing, or wait for the reset on ${nextUsageReset()} (UTC).`,
      0,
    );
  }
  throw new QuotaExceededError(`Monthly action execution limit of ${cap.toLocaleString("en-US")} reached. ${limitAdvice("monthly")}`, 0);
}

export async function getActionAllowance(workspaceId: string, month = getMonthKey()) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new NotFoundError("Workspace");
  const policy = getPlanLimits(workspace.plan, workspace).usagePolicy.actionInvokes;
  const [period] = await db.select().from(workspaceUsagePeriods)
    .where(and(eq(workspaceUsagePeriods.workspaceId, workspaceId), eq(workspaceUsagePeriods.month, month)));
  const credits = await actionCreditUnits(db, workspaceId, month);
  const included = policy.kind === "included-with-grace" ? policy.includedUnits
    : policy.kind === "hard-cap" ? policy.capUnits : policy.kind === "payment-required" ? 0 : null;
  return {
    included,
    credits,
    graceCap: actionCapUnits(policy, credits),
    used: (period?.actionBilled ?? 0) + (period?.actionReserved ?? 0),
    paymentRequired: policy.kind === "payment-required",
  };
}
