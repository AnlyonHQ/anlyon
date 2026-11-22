export const CHART_COLORS = {
  primary: "#6366f1",
  success: "#22c55e",
  danger: "#ef4444",
  warning: "#f59e0b",
  info: "#3b82f6",
  secondary: "#8b5cf6",
  muted: "#94a3b8",
  pending: "#f97316",
};

export const STATUS_COLORS = {
  delivered: CHART_COLORS.success,
  failed: CHART_COLORS.danger,
  pending: CHART_COLORS.pending,
  scheduled: CHART_COLORS.info,
  processing: CHART_COLORS.warning,
  cancelled: CHART_COLORS.muted,
  published: CHART_COLORS.primary,
  warning: CHART_COLORS.warning,
};

export interface PieChartData {
  labels: string[];
  datasets: Array<{
    data: number[];
    backgroundColor: string[];
    borderColor: string[];
    borderWidth: number;
  }>;
}

export interface BarChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    backgroundColor: string | string[];
    borderColor: string | string[];
    borderWidth: number;
  }>;
}

export interface LineChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    borderColor: string;
    backgroundColor: string;
    fill: boolean;
    tension: number;
  }>;
}

export interface ChartDataPoint {
  name: string;
  value: number;
  color: string;
  percentage?: number;
}

export function formatMessageStatusPieChart(stats: {
  delivered: number;
  failed: number;
  pending: number;
}): { pieChart: PieChartData; dataPoints: ChartDataPoint[] } {
  const total = stats.delivered + stats.failed + stats.pending;

  const dataPoints: ChartDataPoint[] = [
    {
      name: "Delivered",
      value: stats.delivered,
      color: STATUS_COLORS.delivered,
      percentage: total > 0 ? Math.round((stats.delivered / total) * 100) : 0,
    },
    {
      name: "Failed",
      value: stats.failed,
      color: STATUS_COLORS.failed,
      percentage: total > 0 ? Math.round((stats.failed / total) * 100) : 0,
    },
    {
      name: "Pending",
      value: stats.pending,
      color: STATUS_COLORS.pending,
      percentage: total > 0 ? Math.round((stats.pending / total) * 100) : 0,
    },
  ].filter(dp => dp.value > 0);

  const pieChart: PieChartData = {
    labels: dataPoints.map(dp => dp.name),
    datasets: [{
      data: dataPoints.map(dp => dp.value),
      backgroundColor: dataPoints.map(dp => dp.color),
      borderColor: dataPoints.map(dp => dp.color),
      borderWidth: 1,
    }],
  };

  return { pieChart, dataPoints };
}

export function formatTimeSeriesLineChart(
  timeSeries: Array<{
    period: string;
    published: number;
    delivered: number;
    failed: number;
  }>
): LineChartData {
  return {
    labels: timeSeries.map(ts => ts.period),
    datasets: [
      {
        label: "Published",
        data: timeSeries.map(ts => ts.published),
        borderColor: STATUS_COLORS.published,
        backgroundColor: `${STATUS_COLORS.published}20`,
        fill: true,
        tension: 0.4,
      },
      {
        label: "Delivered",
        data: timeSeries.map(ts => ts.delivered),
        borderColor: STATUS_COLORS.delivered,
        backgroundColor: `${STATUS_COLORS.delivered}20`,
        fill: true,
        tension: 0.4,
      },
      {
        label: "Failed",
        data: timeSeries.map(ts => ts.failed),
        borderColor: STATUS_COLORS.failed,
        backgroundColor: `${STATUS_COLORS.failed}20`,
        fill: true,
        tension: 0.4,
      },
    ],
  };
}

export function formatTopUrlsBarChart(
  topUrls: Array<{
    url: string;
    messageCount: number;
    successCount: number;
    failureCount: number;
  }>
): BarChartData {
  const truncateUrl = (url: string, maxLength: number = 40) => {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength - 3) + "...";
  };

  return {
    labels: topUrls.map(u => truncateUrl(u.url)),
    datasets: [
      {
        label: "Success",
        data: topUrls.map(u => u.successCount),
        backgroundColor: STATUS_COLORS.delivered,
        borderColor: STATUS_COLORS.delivered,
        borderWidth: 1,
      },
      {
        label: "Failed",
        data: topUrls.map(u => u.failureCount),
        backgroundColor: STATUS_COLORS.failed,
        borderColor: STATUS_COLORS.failed,
        borderWidth: 1,
      },
    ],
  };
}

export function formatUsageHistoryAreaChart(
  usage: Array<{
    date: string;
    messagesPublished: number;
    messagesDelivered: number;
    messagesFailed: number;
  }>
): LineChartData {
  return {
    labels: usage.map(u => u.date),
    datasets: [
      {
        label: "Messages Published",
        data: usage.map(u => u.messagesPublished),
        borderColor: STATUS_COLORS.published,
        backgroundColor: `${STATUS_COLORS.published}30`,
        fill: true,
        tension: 0.4,
      },
      {
        label: "Messages Delivered",
        data: usage.map(u => u.messagesDelivered),
        borderColor: STATUS_COLORS.delivered,
        backgroundColor: `${STATUS_COLORS.delivered}30`,
        fill: true,
        tension: 0.4,
      },
      {
        label: "Messages Failed",
        data: usage.map(u => u.messagesFailed),
        borderColor: STATUS_COLORS.failed,
        backgroundColor: `${STATUS_COLORS.failed}30`,
        fill: true,
        tension: 0.4,
      },
    ],
  };
}

export function formatErrorDistributionBarChart(
  errors: Array<{
    errorMessage: string;
    count: number;
  }>
): BarChartData {
  const truncateMessage = (msg: string, maxLength: number = 50) => {
    if (msg.length <= maxLength) return msg;
    return msg.substring(0, maxLength - 3) + "...";
  };

  const colors = errors.map((_, i) => {
    const ratio = i / Math.max(errors.length - 1, 1);
    return i === 0 ? STATUS_COLORS.failed : `hsl(${15 + ratio * 10}, 90%, ${55 + ratio * 10}%)`;
  });

  return {
    labels: errors.map(e => truncateMessage(e.errorMessage)),
    datasets: [{
      label: "Error Count",
      data: errors.map(e => e.count),
      backgroundColor: colors,
      borderColor: colors,
      borderWidth: 1,
    }],
  };
}

export function formatCurrentUsageStats(usage: {
  date: string;
  messagesPublished: number;
  messagesDelivered: number;
  messagesFailed: number;
}): {
  stats: Array<{
    label: string;
    value: number;
    color: string;
    icon: string;
  }>;
  total: number;
  successRate: number;
} {
  const total = usage.messagesPublished;
  const successRate = total > 0
    ? Math.round((usage.messagesDelivered / total) * 100)
    : 0;

  return {
    stats: [
      {
        label: "Published",
        value: usage.messagesPublished,
        color: STATUS_COLORS.published,
        icon: "send",
      },
      {
        label: "Delivered",
        value: usage.messagesDelivered,
        color: STATUS_COLORS.delivered,
        icon: "check-circle",
      },
      {
        label: "Failed",
        value: usage.messagesFailed,
        color: STATUS_COLORS.failed,
        icon: "x-circle",
      },
    ],
    total,
    successRate,
  };
}

export function generateSparklineData(
  values: number[]
): { data: number[]; min: number; max: number; trend: "up" | "down" | "flat" } {
  const min = Math.min(...values);
  const max = Math.max(...values);

  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const trend = last > first ? "up" : last < first ? "down" : "flat";

  return {
    data: values,
    min,
    max,
    trend,
  };
}
