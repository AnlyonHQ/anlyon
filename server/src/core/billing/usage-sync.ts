import { checkAndSendUsageAlerts } from "../notifications/usage-alerts.ts";

import { db } from "../../db/index.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { usageLogs } from "../../db/schema/billing.ts";
import { messages } from "../../db/schema/messages.ts";
import { redis, RedisKeys } from "../../lib/redis.ts";
import {
  invalidateWorkspaceCache,
  getMonthKey,
  getTodayKey,
} from "../../lib/workspace-cache.ts";
import { eq, and, sql, gte, inArray } from "drizzle-orm";
import { createLogger } from "../../lib/logger.ts";

import { getActionUsage } from "./action-accounting.ts";
import { getDurableMessageUsage } from "./message-accounting.ts";

const logger = createLogger({ module: "usage-sync" });

export async function syncWorkspaceUsage(workspaceId: string): Promise<void> {
  const today = getTodayKey();
  const month = getMonthKey();

  try {
    const [dailyMessages, eventPubs] = await redis.mget(
      RedisKeys.quotaDaily(workspaceId, today),
      RedisKeys.quotaEventPublishes(workspaceId, month)
    );

    const messagesPublished = parseInt(dailyMessages || "0");
    const durable = await getDurableMessageUsage(workspaceId, month);
    const bandwidthBytes = durable.bandwidth;
    const eventPublishes = parseInt(eventPubs || "0");
    const actionInvokes = (await getActionUsage(workspaceId, month)).billed;

    if (
      messagesPublished === 0 &&
      eventPublishes === 0 &&
      actionInvokes === 0
    ) {
      return;
    }

    await db.transaction(async (tx) => {
        await tx
          .insert(usageLogs)
          .values({
            workspaceId,
            date: today,
            messagesPublished,
            messagesDelivered: 0,
            messagesFailed: 0,
            bandwidthBytes,
            eventPublishes,
            actionInvokes,
          })
          .onConflictDoUpdate({
            target: [usageLogs.workspaceId, usageLogs.date],
            set: {
              messagesPublished,
              bandwidthBytes,
              eventPublishes,
              actionInvokes,
              updatedAt: new Date(),
            },
          });

      await tx
        .update(workspaces)
        .set({
          currentMonthMessages: durable.messages,
          currentMonthBandwidth: bandwidthBytes,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspaceId));
    });

    logger.debug({ workspaceId, messagesPublished }, "Usage synced to database");
  } catch (error) {
    logger.error({ workspaceId, error }, "Failed to sync workspace usage");
    throw error;
  }
}

export async function syncAllWorkspaceUsage(): Promise<void> {
  logger.info("Starting usage sync for all workspaces");

  try {
    const activeWorkspaces = await db
      .select({ id: workspaces.id })
      .from(workspaces);

    let syncedCount = 0;
    let errorCount = 0;

    for (const workspace of activeWorkspaces) {
      try {
        await syncWorkspaceUsage(workspace.id);
        await checkAndSendUsageAlerts(workspace.id);
        syncedCount++;
      } catch (error) {
        errorCount++;
        logger.error({ workspaceId: workspace.id, error }, "Failed to sync workspace");
      }
    }

    logger.info({ syncedCount, errorCount, total: activeWorkspaces.length }, "Usage sync completed");
  } catch (error) {
    logger.error({ error }, "Failed to sync all workspace usage");
    throw error;
  }
}

export async function resetMonthlyUsage(): Promise<void> {
  logger.info("Starting monthly usage reset for all workspaces");

  try {
    await db
      .update(workspaces)
      .set({
        currentMonthMessages: 0,
        currentMonthBandwidth: 0,
        usageResetDate: new Date(),
        updatedAt: new Date(),
      });

    logger.info("Monthly usage reset completed");
  } catch (error) {
    logger.error({ error }, "Failed to reset monthly usage");
    throw error;
  }
}

export async function handlePlanChange(workspaceId: string, newPlan: string): Promise<void> {
  logger.info({ workspaceId, newPlan }, "Handling plan change");

  try {
    await invalidateWorkspaceCache(workspaceId);

    logger.info({ workspaceId, newPlan }, "Plan change handled successfully");
  } catch (error) {
    logger.error({ workspaceId, newPlan, error }, "Failed to handle plan change");
    throw error;
  }
}

export async function reconcileWorkspaceUsage(
  workspaceId: string,
  driftThreshold: number = 0.01
): Promise<{ reconciled: boolean; drift: number; actual: number; redisValue: number }> {
  const month = getMonthKey();
  const actual = (await getDurableMessageUsage(workspaceId, month)).messages;
  const redisValueRaw = await redis.get(RedisKeys.quotaMonthly(workspaceId, month));
  const redisValue = parseInt(redisValueRaw || "0") || 0;

  const drift = Math.abs(actual - redisValue);
  const ratio = actual > 0 ? drift / actual : drift > 0 ? 1 : 0;

  if (ratio <= driftThreshold) {
    return { reconciled: false, drift, actual, redisValue };
  }

  logger.warn(
    { workspaceId, actual, redisValue, drift, ratio },
    "Usage counter drift detected, reconciling"
  );

  const ttl = await redis.ttl(RedisKeys.quotaMonthly(workspaceId, month));
  if (ttl > 0) {
    await redis.set(RedisKeys.quotaMonthly(workspaceId, month), actual.toString(), "EX", ttl);
  } else {
    await redis.set(RedisKeys.quotaMonthly(workspaceId, month), actual.toString(), "EX", 2764800);
  }

  await db
    .update(workspaces)
    .set({ currentMonthMessages: actual, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));

  return { reconciled: true, drift, actual, redisValue };
}

export async function reconcileAllWorkspaceUsage(): Promise<void> {
  logger.info("Starting usage counter reconciliation for all workspaces");

  const activeWorkspaces = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(sql`${workspaces.currentMonthMessages} > 0 OR ${workspaces.plan} != 'free'`);

  let reconciledCount = 0;
  let errorCount = 0;

  for (const workspace of activeWorkspaces) {
    try {
      const result = await reconcileWorkspaceUsage(workspace.id);
      if (result.reconciled) reconciledCount++;
    } catch (error) {
      errorCount++;
      logger.error({ workspaceId: workspace.id, error }, "Failed to reconcile workspace");
    }
  }

  logger.info(
    { reconciledCount, errorCount, total: activeWorkspaces.length },
    "Usage reconciliation completed"
  );
}

export async function updateDeliveryMetrics(
  workspaceId: string,
  delivered: number = 0,
  failed: number = 0
): Promise<void> {
  const today = getTodayKey();

  try {
    await db
      .update(usageLogs)
      .set({
        messagesDelivered: sql`${usageLogs.messagesDelivered} + ${delivered}`,
        messagesFailed: sql`${usageLogs.messagesFailed} + ${failed}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(usageLogs.workspaceId, workspaceId),
          eq(usageLogs.date, today)
        )
      );
  } catch (error) {
    logger.error({ workspaceId, delivered, failed, error }, "Failed to update delivery metrics");
  }
}

