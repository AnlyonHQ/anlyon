import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { messageQuotaReservations, workspaceUsagePeriods } from "../../db/schema/billing.ts";
import { getPlanLimits } from "../plans/limits.ts";
import { NotFoundError, ValidationError } from "../../utils/errors.ts";
import type { QuotaDecision } from "../../lib/workspace-cache.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const periodWhere = (workspaceId: string, month: string) => and(eq(workspaceUsagePeriods.workspaceId, workspaceId), eq(workspaceUsagePeriods.month, month));

export async function reserveMessageQuota(workspaceId: string, count: number, size: number): Promise<QuotaDecision> {
  if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(count * size)) {
    throw new ValidationError("Invalid message quota quantity");
  }
  return db.transaction(async tx => {
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    if (!workspace) throw new NotFoundError("Workspace");
    const limits = getPlanLimits(workspace.plan, workspace);
    const day = new Date().toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    await tx.insert(workspaceUsagePeriods).values({ workspaceId, month }).onConflictDoNothing();
    const [period] = await tx.select().from(workspaceUsagePeriods).where(periodWhere(workspaceId, month)).for("update");
    const [{ daily }] = await tx.select({ daily: sql<number>`coalesce(sum(${messageQuotaReservations.count}), 0)` })
      .from(messageQuotaReservations).where(and(eq(messageQuotaReservations.workspaceId, workspaceId),
        eq(messageQuotaReservations.day, day), ne(messageQuotaReservations.state, "released")));
    const usage = { dailyUsage: Number(daily), monthlyUsage: period.messagesBilled + period.messagesReserved,
      bandwidthUsage: period.bandwidthBilled + period.bandwidthReserved,
      dailyCap: limits.maxMessagesPerDay === "unlimited" ? null : limits.maxMessagesPerDay,
      monthlyCap: limits.usagePolicy.messages.kind === "hard-cap" ? limits.usagePolicy.messages.capUnits : null,
      bandwidthCap: limits.usagePolicy.bandwidth.kind === "hard-cap" ? limits.usagePolicy.bandwidth.capUnits : null,
      messageSizeCap: limits.maxMessageSize };
    const dimension = size > usage.messageSizeCap ? "message_size"
      : usage.dailyCap !== null && usage.dailyUsage + count > usage.dailyCap ? "messages_daily"
      : usage.monthlyCap !== null && usage.monthlyUsage + count > usage.monthlyCap ? "messages_monthly"
      : usage.bandwidthCap !== null && usage.bandwidthUsage + count * size > usage.bandwidthCap ? "bandwidth" : undefined;
    if (dimension) return { ...usage, allowed: false, rejectedDimension: dimension, reason: `Plan quota exceeded: ${dimension}` };
    const [reservation] = await tx.insert(messageQuotaReservations).values({ workspaceId, month, day, count, bytes: count * size }).returning();
    await tx.update(workspaceUsagePeriods).set({ messagesReserved: period.messagesReserved + count,
      bandwidthReserved: period.bandwidthReserved + count * size }).where(periodWhere(workspaceId, month));
    return { ...usage, allowed: true, reservationId: reservation.id };
  });
}

export async function finishMessageQuota(workspaceId: string, id: string, outcome: "billed" | "released", transaction?: Transaction) {
  const run = async (tx: Transaction) => {
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    const [reservation] = await tx.select().from(messageQuotaReservations).where(and(
      eq(messageQuotaReservations.id, id), eq(messageQuotaReservations.workspaceId, workspaceId))).for("update");
    if (!reservation || reservation.state !== "reserved") return;
    await tx.update(workspaceUsagePeriods).set({
      messagesReserved: sql`${workspaceUsagePeriods.messagesReserved} - ${reservation.count}`,
      bandwidthReserved: sql`${workspaceUsagePeriods.bandwidthReserved} - ${reservation.bytes}`,
      ...(outcome === "billed" ? {
        messagesBilled: sql`${workspaceUsagePeriods.messagesBilled} + ${reservation.count}`,
        bandwidthBilled: sql`${workspaceUsagePeriods.bandwidthBilled} + ${reservation.bytes}`,
      } : {}),
    }).where(periodWhere(workspaceId, reservation.month));
    await tx.update(messageQuotaReservations).set({ state: outcome }).where(eq(messageQuotaReservations.id, id));
  };
  if (transaction) await run(transaction); else await db.transaction(run);
}

export async function getDurableMessageUsage(workspaceId: string, month = new Date().toISOString().slice(0, 7)) {
  const [period] = await db.select().from(workspaceUsagePeriods).where(periodWhere(workspaceId, month));
  return { messages: period?.messagesBilled ?? 0, bandwidth: period?.bandwidthBilled ?? 0,
    messagesReserved: period?.messagesReserved ?? 0, bandwidthReserved: period?.bandwidthReserved ?? 0 };
}

export async function recordBandwidth(workspaceId: string, bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new ValidationError("Invalid bandwidth quantity");
  if (!bytes) return;
  const month = new Date().toISOString().slice(0, 7);
  await db.insert(workspaceUsagePeriods).values({ workspaceId, month, bandwidthBilled: bytes }).onConflictDoUpdate({
    target: [workspaceUsagePeriods.workspaceId, workspaceUsagePeriods.month],
    set: { bandwidthBilled: sql`${workspaceUsagePeriods.bandwidthBilled} + ${bytes}` },
  });
}
