import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { actionInvocations, actions } from "../../db/schema/actions.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import { invocationOutcomeRecord } from "../audit/records.ts";
import { workspaceUsagePeriods, budgetReservations } from "../../db/schema/billing.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { getMonthKey } from "../../lib/workspace-cache.ts";
import { getPlanLimits } from "../plans/limits.ts";
import { PaymentRequiredError, QuotaExceededError } from "./usage-enforcement.ts";
import { assertActionAdmissible, drawActionCredits } from "./action-allowance.ts";
import { ConflictError, NotFoundError } from "../../utils/errors.ts";
import { refundBudget } from "./budgets.ts";

const periodWhere = (workspaceId: string, month: string) => and(
  eq(workspaceUsagePeriods.workspaceId, workspaceId), eq(workspaceUsagePeriods.month, month),
);

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function reserveAllowance(tx: Transaction, workspace: typeof workspaces.$inferSelect,
  invocation: typeof actionInvocations.$inferSelect) {
  const workspaceId = workspace.id;
  const month = getMonthKey();
  if (invocation.usageState === "reserved" && invocation.usageMonth === month) return;
  await tx.insert(workspaceUsagePeriods).values({ workspaceId, month }).onConflictDoNothing();
  const [period] = await tx.select().from(workspaceUsagePeriods).where(periodWhere(workspaceId, month)).for("update");
  const policy = getPlanLimits(workspace.plan, workspace).usagePolicy.actionInvokes;
  const used = period.actionReserved + period.actionBilled;
  const credits = policy.kind === "unlimited" || policy.kind === "payment-required" ? 0
    : await drawActionCredits(tx, { workspaceId, month, policy, used, adding: 1, drawn: period.actionCreditsDrawn });
  assertActionAdmissible(policy, used, credits);
  if (invocation.usageState === "reserved" && invocation.usageMonth) {
    await tx.update(workspaceUsagePeriods).set({ actionReserved: sql`${workspaceUsagePeriods.actionReserved} - 1` })
      .where(periodWhere(workspaceId, invocation.usageMonth));
  }
  await tx.update(workspaceUsagePeriods).set({ actionReserved: period.actionReserved + 1 }).where(periodWhere(workspaceId, month));
  await tx.update(actionInvocations).set({ usageMonth: month, usageState: "reserved" }).where(eq(actionInvocations.id, invocation.id));
}

export async function reserveApprovalExecution(tx: Transaction, workspaceId: string, invocationId: string) {
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
  if (!workspace) throw new NotFoundError("Workspace");
  const [invocation] = await tx.select().from(actionInvocations).where(and(
    eq(actionInvocations.id, invocationId), eq(actionInvocations.workspaceId, workspaceId),
  )).for("update");
  if (!invocation) throw new NotFoundError("Invocation");
  if (invocation.dispatchClaimedAt || invocation.status !== "pending_approval") {
    throw new ConflictError("This invocation is no longer awaiting approval");
  }
  await reserveAllowance(tx, workspace, invocation);
}

export async function reserveActionExecution(workspaceId: string, invocationId: string): Promise<boolean> {
  const result = await db.transaction(async tx => {
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    if (!workspace) throw new NotFoundError("Workspace");
    const [invocation] = await tx.select().from(actionInvocations).where(and(
      eq(actionInvocations.id, invocationId), eq(actionInvocations.workspaceId, workspaceId),
    )).for("update");
    if (!invocation) throw new NotFoundError("Invocation");
    if (invocation.dispatchClaimedAt || !["running", "pending_approval"].includes(invocation.status)) return false;
    try {
      await reserveAllowance(tx, workspace, invocation);
    } catch (error) {
      if (!(error instanceof QuotaExceededError || error instanceof PaymentRequiredError)) throw error;
      if (invocation.status === "running") {
        if (invocation.usageState === "reserved" && invocation.usageMonth) {
          await tx.update(workspaceUsagePeriods).set({ actionReserved: sql`${workspaceUsagePeriods.actionReserved} - 1` })
            .where(periodWhere(workspaceId, invocation.usageMonth));
        }
        await tx.update(actionInvocations).set({ status: "failed", usageState: "released",
          errorMessage: error instanceof PaymentRequiredError ? "No plan: the workspace needs a plan to run actions"
            : "Monthly action execution limit reached before dispatch", completedAt: new Date(),
        }).where(eq(actionInvocations.id, invocationId));
        if (invocation.budgetReservationId) await refundBudget(invocation.budgetReservationId, tx);
      }
      return error;
    }
    await tx.update(actionInvocations).set({ dispatchClaimedAt: new Date(), status: "running" })
      .where(eq(actionInvocations.id, invocationId));
    return true;
  });
  if (result instanceof QuotaExceededError || result instanceof PaymentRequiredError) throw result;
  return result;
}

type InvocationInsert = typeof actionInvocations.$inferInsert;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type InvocationPatch = { [K in keyof InvocationInsert]?: InvocationInsert[K] | SQL };

export async function recordInvocationOutcome(
  workspaceId: string, invocationId: string,
  patch: InvocationPatch,
  outcome: "billed" | "released" | "unknown",
) {
  return db.transaction(tx => recordInvocationOutcomeIn(tx, workspaceId, invocationId, patch, outcome));
}

export async function recordInvocationOutcomeIn(
  tx: Tx,
  workspaceId: string, invocationId: string,
  patch: InvocationPatch,
  outcome: "billed" | "released" | "unknown",
) {
  {
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    const [invocation] = await tx.select().from(actionInvocations).where(and(
      eq(actionInvocations.id, invocationId), eq(actionInvocations.workspaceId, workspaceId),
    )).for("update");
    if (!invocation) throw new NotFoundError("Invocation");
    if (invocation.usageState === "billed" || invocation.usageState === "released") return invocation;
    if (outcome !== "unknown" && invocation.usageState === "reserved" && invocation.usageMonth) {
      await tx.update(workspaceUsagePeriods).set({
        actionReserved: sql`${workspaceUsagePeriods.actionReserved} - 1`,
        actionBilled: outcome === "billed" ? sql`${workspaceUsagePeriods.actionBilled} + 1` : workspaceUsagePeriods.actionBilled,
      }).where(periodWhere(workspaceId, invocation.usageMonth));
    }
    if (outcome === "billed" && invocation.budgetReservationId) {
      await tx.update(budgetReservations).set({ state: "settled", completedAt: new Date() }).where(and(
        eq(budgetReservations.id, invocation.budgetReservationId), eq(budgetReservations.state, "reserved"),
      ));
    }
    if (outcome === "released" && invocation.budgetReservationId) {
      await refundBudget(invocation.budgetReservationId, tx);
    }
    const [row] = await tx.update(actionInvocations).set({ ...patch,
      ...(outcome !== "unknown" ? { usageState: outcome } : {}),
    }).where(eq(actionInvocations.id, invocationId)).returning();
    if (patch.status !== undefined) {
      const [action] = await tx.select({ actionId: actions.actionId, name: actions.name }).from(actions)
        .where(eq(actions.id, row.actionId));
      const record = invocationOutcomeRecord(row, action ?? { actionId: "", name: "" });
      if (record) await writeAuditEvents(tx, [record]);
    }
    return row;
  }
}

export async function getActionUsage(workspaceId: string, month = getMonthKey()) {
  const [period] = await db.select().from(workspaceUsagePeriods).where(periodWhere(workspaceId, month));
  return { billed: period?.actionBilled ?? 0, reserved: period?.actionReserved ?? 0 };
}

export async function releaseUndispatchedActionBudget(workspaceId: string, reservationId: string) {
  await db.transaction(async tx => {
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    const invocations = await tx.select().from(actionInvocations).where(and(
      eq(actionInvocations.workspaceId, workspaceId), eq(actionInvocations.budgetReservationId, reservationId),
    )).for("update");
    if (invocations.some(invocation => invocation.dispatchClaimedAt ||
      (invocation.status === "pending_approval" && invocation.approvalId))) return;
    for (const invocation of invocations) {
      if (invocation.usageState === "billed" || invocation.usageState === "reserved") return;
    }
    for (const invocation of invocations) {
      await tx.update(actionInvocations).set({ status: "failed", usageState: "released",
        completedAt: new Date(), errorMessage: "Action admission failed before dispatch" }).where(eq(actionInvocations.id, invocation.id));
    }
    await refundBudget(reservationId, tx);
  });
}
