export type AnalyticsGranularity = "hour" | "day" | "week" | "month";

export interface AnalyticsMetadata {
  range: {
    startDate: string;
    endDate: string;
    granularity: AnalyticsGranularity;
    truncated: boolean;
    retentionDays: number | null;
  };
  scope: {
    workspaceId: string;
    environmentId: string | null;
  };
}

export interface ProductUsagePoint {
  date: string;
  messagesPublished: number;
  messagesDelivered: number;
  messagesFailed: number;
  bandwidthBytes: number;
  eventPublishes: number;
  actionInvokes: number;
}

export interface OverviewAnalytics extends AnalyticsMetadata {
  summary: {
    agentRuns: number;
    agentRunSuccessRate: number;
    messagesDelivered: number;
    messageSuccessRate: number;
    actionInvocations: number;
    actionSuccessRate: number;
    pendingApprovals: number;
  };
  usage: {
    counters: Omit<ProductUsagePoint, "date">;
    scope: "workspace";
  };
  series: ProductUsagePoint[];
  deliverySeries: Array<{ period: string; published: number; delivered: number; failed: number; pending: number }>;
  attention: Array<{
    product: "agents" | "delivery" | "actions" | "approvals";
    label: string;
    count: number;
    href: string;
  }>;
}

export interface AgentAnalytics extends AnalyticsMetadata {
  summary: {
    totalRuns: number;
    runningRuns: number;
    succeededRuns: number;
    failedRuns: number;
    cancelledRuns: number;
    successRate: number;
    p50DurationMs: number;
    p95DurationMs: number;
    totalTokens: number;
    totalCost: number;
  };
  series: Array<{ period: string; total: number; running: number; succeeded: number; failed: number; cancelled: number }>;
  topAgents: Array<{
    agentId: string | null;
    name: string;
    totalRuns: number;
    failedRuns: number;
    successRate: number;
    totalTokens: number;
    totalCost: number;
  }>;
  topVersions: Array<{
    agentVersionId: string;
    totalRuns: number;
    failedRuns: number;
    successRate: number;
  }>;
}

export interface TrustControlAnalytics extends AnalyticsMetadata {
  actions: {
    summary: {
      totalInvocations: number;
      succeededInvocations: number;
      failedInvocations: number;
      deniedInvocations: number;
      pendingInvocations: number;
      successRate: number;
      p50DurationMs: number;
      p95DurationMs: number;
      approvalGatedRate: number;
    };
    series: Array<{ period: string; total: number; pending: number; succeeded: number; failed: number; denied: number }>;
    topActions: Array<{
      actionId: string;
      name: string;
      totalInvocations: number;
      failedInvocations: number;
      successRate: number;
      p95DurationMs: number;
    }>;
  };
  approvals: {
    summary: {
      totalRequests: number;
      pendingRequests: number;
      approvedRequests: number;
      deniedRequests: number;
      expiredRequests: number;
      approvalRate: number;
      p50DecisionMs: number;
      p95DecisionMs: number;
      oldestPendingMs: number;
    };
    series: Array<{ period: string; total: number; pending: number; approved: number; denied: number; expired: number }>;
    topPolicies: Array<{
      policyId: string | null;
      name: string;
      totalRequests: number;
      approvedRequests: number;
      deniedRequests: number;
      expiredRequests: number;
    }>;
  };
}

export interface DeliveryAnalytics extends AnalyticsMetadata {
  messages: {
    published: number;
    delivered: number;
    failed: number;
    pending: number;
    successRate: number;
    averageDeliveryTime: number;
  };
  messageSeries: Array<{ period: string; published: number; delivered: number; failed: number; pending: number }>;
  bandwidthBytes: number;
  topUrls: Array<{
    url: string;
    messageCount: number;
    successCount: number;
    failureCount: number;
    successRate: number;
  }>;
  errors: Array<{ errorMessage: string; count: number }>;
}
