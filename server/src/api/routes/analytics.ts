import { Hono, type Context } from "hono";
import { requireApiKey, requireApiKeyScope } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateQuery } from "../middleware/validation.ts";
import {
  analyticsQuerySchema,
  analyticsLimitQuerySchema,
} from "../../utils/validation.ts";
import {
  getMessageAnalytics,
  getMessageTimeSeries,
  getTopURLs,
  getCurrentUsage,
  getUsageHistory,
  getErrorDistribution,
  getOnboardingStatus,
} from "../../core/analytics/service.ts";
import {
  getAgentAnalytics,
  getDeliveryAnalytics,
  getEffectiveAnalyticsRange,
  getOverviewAnalytics,
  getTrustControlAnalytics,
} from "../../core/analytics/expanded-service.ts";
import type { AnalyticsGranularity } from "../../core/analytics/types.ts";
import { AuthorizationError } from "../../utils/errors.ts";
import {
  formatMessageStatusPieChart,
  formatTimeSeriesLineChart,
  formatTopUrlsBarChart,
  formatUsageHistoryAreaChart,
  formatErrorDistributionBarChart,
  formatCurrentUsageStats,
  generateSparklineData,
  CHART_COLORS,
  STATUS_COLORS,
} from "../../core/analytics/chart-utils.ts";

const analytics = new Hono();

analytics.use("*", requireApiKey);
analytics.use("*", requireApiKeyScope("analytics:read"));
analytics.use("*", rateLimitByWorkspace);

interface ProductAnalyticsQuery {
  startDate?: string;
  endDate?: string;
  granularity: AnalyticsGranularity;
  environmentId?: string;
  limit: number;
}

function resolveAnalyticsEnvironment(
  c: Context,
  requestedEnvironmentId?: string,
): string | undefined {
  const authType = c.get("authType") as string | undefined;
  const boundEnvironmentId = c.get("environmentId") as string | undefined;

  if (authType === "session") {
    return requestedEnvironmentId;
  }

  if (
    requestedEnvironmentId &&
    boundEnvironmentId &&
    requestedEnvironmentId !== boundEnvironmentId
  ) {
    throw new AuthorizationError(
      "This credential cannot access analytics for that environment",
    );
  }

  return boundEnvironmentId;
}

async function resolveAnalyticsRange(
  workspaceId: string,
  query: ProductAnalyticsQuery,
) {
  const requestedEnd = query.endDate ? new Date(query.endDate) : new Date();
  const requestedStart = query.startDate
    ? new Date(query.startDate)
    : new Date(requestedEnd.getTime() - 30 * 86_400_000);
  return getEffectiveAnalyticsRange(workspaceId, requestedStart, requestedEnd);
}

function applyRangeMetadata<T extends { range: {
  startDate: string;
  endDate: string;
  truncated: boolean;
  retentionDays: number | null;
} }>(
  data: T,
  range: Awaited<ReturnType<typeof getEffectiveAnalyticsRange>>,
): T {
  data.range.startDate = range.startDate.toISOString();
  data.range.endDate = range.endDate.toISOString();
  data.range.truncated = range.truncated;
  data.range.retentionDays = range.retentionDays;
  return data;
}

analytics.get(
  "/overview",
  validateQuery(analyticsLimitQuerySchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const query = c.get("validatedQuery") as ProductAnalyticsQuery;
    const environmentId = resolveAnalyticsEnvironment(c, query.environmentId);
    const range = await resolveAnalyticsRange(workspaceId, query);
    const data = await getOverviewAnalytics(
      workspaceId,
      range.startDate,
      range.endDate,
      query.granularity,
      query.limit,
      environmentId,
    );
    return c.json({ success: true, data: applyRangeMetadata(data, range) });
  },
);

analytics.get(
  "/agents",
  validateQuery(analyticsLimitQuerySchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const query = c.get("validatedQuery") as ProductAnalyticsQuery;
    const environmentId = resolveAnalyticsEnvironment(c, query.environmentId);
    const range = await resolveAnalyticsRange(workspaceId, query);
    const data = await getAgentAnalytics(
      workspaceId,
      range.startDate,
      range.endDate,
      query.granularity,
      query.limit,
      environmentId,
    );
    return c.json({ success: true, data: applyRangeMetadata(data, range) });
  },
);

analytics.get(
  "/trust-control",
  validateQuery(analyticsLimitQuerySchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const query = c.get("validatedQuery") as ProductAnalyticsQuery;
    const environmentId = resolveAnalyticsEnvironment(c, query.environmentId);
    const range = await resolveAnalyticsRange(workspaceId, query);
    const data = await getTrustControlAnalytics(
      workspaceId,
      range.startDate,
      range.endDate,
      query.granularity,
      query.limit,
      environmentId,
    );
    return c.json({ success: true, data: applyRangeMetadata(data, range) });
  },
);

analytics.get(
  "/delivery",
  validateQuery(analyticsLimitQuerySchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const query = c.get("validatedQuery") as ProductAnalyticsQuery;
    const environmentId = resolveAnalyticsEnvironment(c, query.environmentId);
    const range = await resolveAnalyticsRange(workspaceId, query);
    const data = await getDeliveryAnalytics(
      workspaceId,
      range.startDate,
      range.endDate,
      query.granularity,
      query.limit,
      environmentId,
    );
    return c.json({ success: true, data: applyRangeMetadata(data, range) });
  },
);

analytics.get("/messages", validateQuery(analyticsQuerySchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const { startDate, endDate, environmentId: requestedEnvironmentId } = c.get("validatedQuery");
  const environmentId = resolveAnalyticsEnvironment(c, requestedEnvironmentId);

  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  const stats = await getMessageAnalytics(workspaceId, start, end, environmentId);

  const chartData = formatMessageStatusPieChart({
    delivered: stats.delivered,
    failed: stats.failed,
    pending: stats.pending,
  });

  return c.json({
    success: true,
    data: stats,
    charts: {
      statusDistribution: chartData.pieChart,
      dataPoints: chartData.dataPoints,
      colors: STATUS_COLORS,
    },
  });
});

analytics.get("/time-series", validateQuery(analyticsQuerySchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const { startDate, endDate, granularity, environmentId: requestedEnvironmentId } = c.get("validatedQuery");
  const environmentId = resolveAnalyticsEnvironment(c, requestedEnvironmentId);

  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  const timeSeries = await getMessageTimeSeries(workspaceId, start, end, granularity, environmentId);

  const lineChart = formatTimeSeriesLineChart(timeSeries);

  const sparklines = {
    published: generateSparklineData(timeSeries.map(ts => ts.published)),
    delivered: generateSparklineData(timeSeries.map(ts => ts.delivered)),
    failed: generateSparklineData(timeSeries.map(ts => ts.failed)),
  };

  return c.json({
    success: true,
    data: timeSeries,
    charts: {
      lineChart,
      sparklines,
      colors: STATUS_COLORS,
    },
  });
});

analytics.get("/top-urls", validateQuery(analyticsLimitQuerySchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const { startDate, endDate, limit, environmentId: requestedEnvironmentId } = c.get("validatedQuery");
  const environmentId = resolveAnalyticsEnvironment(c, requestedEnvironmentId);

  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  const topUrls = await getTopURLs(workspaceId, start, end, limit, environmentId);

  const barChart = formatTopUrlsBarChart(topUrls);

  return c.json({
    success: true,
    data: topUrls,
    charts: {
      barChart,
      colors: STATUS_COLORS,
    },
  });
});

analytics.get("/usage/current", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const usage = await getCurrentUsage(workspaceId);

  const statsData = formatCurrentUsageStats(usage);

  return c.json({
    success: true,
    data: usage,
    charts: {
      statsCards: statsData.stats,
      summary: {
        total: statsData.total,
        successRate: statsData.successRate,
      },
      colors: STATUS_COLORS,
    },
  });
});

analytics.get("/usage/history", validateQuery(analyticsQuerySchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const { startDate, endDate } = c.get("validatedQuery");

  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  const usage = await getUsageHistory(workspaceId, start, end);

  const areaChart = formatUsageHistoryAreaChart(usage);

  const sparklines = {
    messagesPublished: generateSparklineData(usage.map(u => u.messagesPublished)),
    messagesDelivered: generateSparklineData(usage.map(u => u.messagesDelivered)),
    messagesFailed: generateSparklineData(usage.map(u => u.messagesFailed)),
  };

  return c.json({
    success: true,
    data: usage,
    charts: {
      areaChart,
      sparklines,
      colors: STATUS_COLORS,
    },
  });
});

analytics.get("/errors", validateQuery(analyticsLimitQuerySchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const { startDate, endDate, limit, environmentId: requestedEnvironmentId } = c.get("validatedQuery");
  const environmentId = resolveAnalyticsEnvironment(c, requestedEnvironmentId);

  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  const errors = await getErrorDistribution(workspaceId, start, end, limit, environmentId);

  const barChart = formatErrorDistributionBarChart(errors);

  const totalErrors = errors.reduce((sum, e) => sum + e.count, 0);

  return c.json({
    success: true,
    data: errors,
    charts: {
      barChart,
      summary: {
        totalErrors,
        uniqueErrors: errors.length,
      },
      colors: STATUS_COLORS,
    },
  });
});

analytics.get("/onboarding", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const status = await getOnboardingStatus(workspaceId);

  const progressChart = {
    value: status.completionPercentage,
    max: 100,
    color: status.completionPercentage >= 100
      ? CHART_COLORS.success
      : status.completionPercentage >= 50
        ? CHART_COLORS.warning
        : CHART_COLORS.info,
  };

  const stepsChart = status.steps.map((step, index) => ({
    ...step,
    color: step.completed ? CHART_COLORS.success : CHART_COLORS.muted,
    index: index + 1,
  }));

  return c.json({
    success: true,
    data: status,
    charts: {
      progressRing: progressChart,
      steps: stepsChart,
      colors: CHART_COLORS,
    },
  });
});

export default analytics;
