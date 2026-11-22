import { db } from "../../db/index.ts";
import { messages } from "../../db/schema/messages.ts";
import { usageLogs } from "../../db/schema/billing.ts";
import { apiKeys } from "../../db/schema/workspaces.ts";
import { actionInvocations } from "../../db/schema/actions.ts";
import { eq, and, gte, lte, sql, desc } from "drizzle-orm";
import { redis, RedisKeys } from "../../lib/redis.ts";
import { createLogger } from "../../lib/logger.ts";
import type { MessageAnalytics } from "../../types/api.ts";

const logger = createLogger({ module: "analytics" });

export async function getMessageAnalytics(
  workspaceId: string,
  startDate: Date,
  endDate: Date,
  environmentId?: string,
): Promise<MessageAnalytics> {
  const [statusCounts] = await db
    .select({
      published: sql`count(*) filter (where status != 'cancelled')`,
      delivered: sql`count(*) filter (where status = 'delivered')`,
      failed: sql`count(*) filter (where status = 'failed')`,
      pending: sql`count(*) filter (where status in ('pending', 'scheduled', 'processing'))`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        environmentId ? eq(messages.environmentId, environmentId) : undefined,
        gte(messages.createdAt, startDate),
        lte(messages.createdAt, endDate)
      )
    );

  const published = Number(statusCounts.published || 0);
  const delivered = Number(statusCounts.delivered || 0);
  const failed = Number(statusCounts.failed || 0);
  const pending = Number(statusCounts.pending || 0);

  const successRate = published > 0 ? (delivered / published) * 100 : 0;

  const [avgTime] = await db
    .select({
      avgDeliveryTime: sql`avg(extract(epoch from (delivered_at - created_at))) * 1000`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        environmentId ? eq(messages.environmentId, environmentId) : undefined,
        eq(messages.status, "delivered"),
        gte(messages.createdAt, startDate),
        lte(messages.createdAt, endDate)
      )
    );

  const averageDeliveryTime = Number(avgTime.avgDeliveryTime || 0);

  return {
    published,
    delivered,
    failed,
    pending,
    successRate: Math.round(successRate * 100) / 100,
    averageDeliveryTime: Math.round(averageDeliveryTime),
  };
}

export async function getMessageTimeSeries(
  workspaceId: string,
  startDate: Date,
  endDate: Date,
  granularity: "hour" | "day" | "week" | "month" = "day",
  environmentId?: string,
) {
  const formats = {
    hour: `'YYYY-MM-DD HH24:00:00'`,
    day: `'YYYY-MM-DD'`,
    week: `'IYYY-"W"IW'`,
    month: `'YYYY-MM'`,
  } as const;
  const dateFormatExpr = sql.raw(formats[granularity]);

  const periodExpr = sql<string>`to_char(${messages.createdAt}, ${dateFormatExpr})`;

  const timeSeries = await db
    .select({
      period: periodExpr,
      published: sql`count(*) filter (where status != 'cancelled')`,
      delivered: sql`count(*) filter (where status = 'delivered')`,
      failed: sql`count(*) filter (where status = 'failed')`,
      pending: sql`count(*) filter (where status in ('pending', 'scheduled', 'processing'))`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        environmentId ? eq(messages.environmentId, environmentId) : undefined,
        gte(messages.createdAt, startDate),
        lte(messages.createdAt, endDate)
      )
    )
    .groupBy(periodExpr)
    .orderBy(periodExpr);

  return timeSeries.map((row) => ({
    period: row.period,
    published: Number(row.published),
    delivered: Number(row.delivered),
    failed: Number(row.failed),
    pending: Number(row.pending),
  }));
}

export async function getTopURLs(
  workspaceId: string,
  startDate: Date,
  endDate: Date,
  limit: number = 10,
  environmentId?: string,
) {
  const topUrls = await db
    .select({
      url: messages.url,
      messageCount: sql`count(*)`,
      successCount: sql`count(*) filter (where status = 'delivered')`,
      failureCount: sql`count(*) filter (where status = 'failed')`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        environmentId ? eq(messages.environmentId, environmentId) : undefined,
        gte(messages.createdAt, startDate),
        lte(messages.createdAt, endDate)
      )
    )
    .groupBy(messages.url)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return topUrls.map((row) => ({
    url: row.url,
    messageCount: Number(row.messageCount),
    successCount: Number(row.successCount),
    failureCount: Number(row.failureCount),
    successRate:
      Number(row.messageCount) > 0
        ? Math.round((Number(row.successCount) / Number(row.messageCount)) * 10000) / 100
        : 0,
  }));
}

export async function getCurrentUsage(workspaceId: string) {
  const today = new Date().toISOString().split("T")[0];
  const month = today.slice(0, 7);
  const [
    messagesPublished, messagesDelivered, messagesFailed,
    bandwidthBytes, eventPublishes, actionInvokes,
  ] = await redis.mget(
    RedisKeys.usageCounter(workspaceId, today, "messages_published"),
    RedisKeys.usageCounter(workspaceId, today, "messages_delivered"),
    RedisKeys.usageCounter(workspaceId, today, "messages_failed"),
    RedisKeys.quotaBandwidth(workspaceId, month),
    RedisKeys.quotaEventPublishes(workspaceId, month),
    RedisKeys.quotaActionInvokes(workspaceId, month),
  );

  return {
    date: today,
    messagesPublished: parseInt(messagesPublished || "0"),
    messagesDelivered: parseInt(messagesDelivered || "0"),
    messagesFailed: parseInt(messagesFailed || "0"),
    bandwidthBytes: parseInt(bandwidthBytes || "0"),
    eventPublishes: parseInt(eventPublishes || "0"),
    actionInvokes: parseInt(actionInvokes || "0"),
  };
}

export async function getUsageHistory(
  workspaceId: string,
  startDate: Date,
  endDate: Date
) {
  const usage = await db
    .select()
    .from(usageLogs)
    .where(
      and(
        eq(usageLogs.workspaceId, workspaceId),
        gte(sql`${usageLogs.date}::date`, startDate),
        lte(sql`${usageLogs.date}::date`, endDate)
      )
    )
    .orderBy(usageLogs.date);

  return usage.map((log) => ({
    date: log.date,
    messagesPublished: Number(log.messagesPublished),
    messagesDelivered: Number(log.messagesDelivered),
    messagesFailed: Number(log.messagesFailed),
    bandwidthBytes: Number(log.bandwidthBytes),
    eventPublishes: Number(log.eventPublishes),
    actionInvokes: Number(log.actionInvokes),
  }));
}

export async function getErrorDistribution(
  workspaceId: string,
  startDate: Date,
  endDate: Date,
  limit: number = 10,
  environmentId?: string,
) {
  const errors = await db
    .select({
      errorMessage: messages.errorMessage,
      count: sql`count(*)`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        environmentId ? eq(messages.environmentId, environmentId) : undefined,
        eq(messages.status, "failed"),
        gte(messages.createdAt, startDate),
        lte(messages.createdAt, endDate)
      )
    )
    .groupBy(messages.errorMessage)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return errors.map((row) => ({
    errorMessage: row.errorMessage || "Unknown error",
    count: Number(row.count),
  }));
}

export async function getOnboardingStatus(workspaceId: string) {
  const [apiKeyCount] = await db
    .select({
      count: sql`count(*)`,
    })
    .from(apiKeys)
    .where(eq(apiKeys.workspaceId, workspaceId));

  const [invocationCount] = await db
    .select({
      count: sql`count(*)`,
    })
    .from(actionInvocations)
    .where(eq(actionInvocations.workspaceId, workspaceId));

  const hasApiKey = Number(apiKeyCount.count) > 0;
  const totalInvocations = Number(invocationCount.count);
  const hasInvocations = totalInvocations > 0;

  const steps = [
    { id: "api_key", completed: hasApiKey, label: "Create an API key" },
    { id: "first_invocation", completed: hasInvocations, label: "Invoke your first action" },
  ];

  const completedSteps = steps.filter(s => s.completed).length;
  const completionPercentage = Math.round((completedSteps / steps.length) * 100);

  return {
    isOnboarded: hasInvocations,
    hasApiKey,
    hasInvocations,
    totalInvocations,
    steps,
    completedSteps,
    totalSteps: steps.length,
    completionPercentage,
  };
}
