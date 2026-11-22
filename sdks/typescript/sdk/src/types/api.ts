/**
 * Core API types for Anlyon Scheduler SDK
 * These types are derived from the OpenAPI specification
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type MessageStatus =
  | 'pending'
  | 'scheduled'
  | 'processing'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export type TimeGranularity = 'hour' | 'day' | 'week' | 'month';

export type PlanType = 'free' | 'production' | 'growth' | 'paygo' | 'enterprise';

export type NotificationType =
  | 'quota_warning'
  | 'quota_exceeded'
  | 'payment_failed'
  | 'plan_upgraded'
  | 'plan_downgraded'
  | 'feature_enabled'
  | 'system_alert'
  | 'security_alert'
  | 'delivery_failure_spike'
  | 'api_key_expiring'
  | 'approval_requested'
  | 'budget_alert';

export type NotificationPriority = 'low' | 'medium' | 'high' | 'critical';

export interface UpdateNotificationPreferencesRequest {
  emailEnabled?: boolean;
  webhookEnabled?: boolean;
  inAppEnabled?: boolean;
  emailRecipients?: string[];
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  quotaAlertThresholds?: number[];
  enabledTypes?: NotificationType[];
}

/** A failed delivery, as the DLQ returns it (`client.dlq`). Event-webhook deliveries are messages. */
export interface Message {
  messageId: string;
  url: string;
  method: HttpMethod;
  headers: Record<string, string> | null;
  body: unknown | null;
  scheduledFor: string | null;
  status: MessageStatus;
  attempts: number | null;
  maxRetries: number | null;
  responseStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  callbackUrl: string | null;
  failureCallbackUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  type: NotificationType;
  priority: NotificationPriority;
  title: string;
  message: string;
  metadata: Record<string, unknown> | null;
  actionUrl: string | null;
  actionLabel: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

/** Your own notification preferences in one workspace. */
export interface MyNotificationPreferences {
  /** Types left out of your own notification list and unread count. */
  mutedTypes: NotificationType[];
  /** Null until you save your preferences for the first time. */
  updatedAt: string | null;
}

export interface UpdateMyNotificationPreferencesRequest {
  /** Replaces the muted list. Send an empty array to mute nothing. At most 12. */
  mutedTypes: NotificationType[];
}

export interface NotificationPreferences {
  emailEnabled: boolean;
  webhookEnabled: boolean;
  inAppEnabled: boolean;
  slackEnabled: boolean;
  discordEnabled: boolean;
  emailRecipients: string[];
  webhookUrl: string | null;
  hasWebhookSecret: boolean;
  quotaAlertThresholds: number[];
  enabledTypes: NotificationType[];
  createdAt: string;
  updatedAt: string;
}

/** How a workspace is served right now. Server-controlled; shared by enforcement, the console and public pricing. */
export interface BillingAccess {
  /** `early_beta` while Early Beta Access allowances apply, `standard` otherwise. */
  mode: 'early_beta' | 'standard';
  betaAllowancesApply: boolean;
  /** Whether a paid plan can be bought right now. Upgrade calls return `PAID_PLANS_UNAVAILABLE` when false. */
  paidPlansAvailable: boolean;
  /** Set only once normal pricing is open, and only while this workspace still has beta allowances. */
  betaAllowancesEndAt: string | null;
  /** The next UTC month boundary, when monthly allowances reset. */
  usageResetsAt: string;
  /** Early Beta Access never bills overage. */
  overageBilling: false;
  /** Nothing is charged or upgraded automatically. */
  automaticCharges: false;
}

/** The published Early Beta Access allowances, derived from the limits the API enforces. */
export interface BetaAllowances {
  actionExecutionsPerMonth: number | null;
  durableMessagesPerMonth: number | null;
  actionDefinitions: number | 'unlimited';
  seatsIncludingPendingInvitations: number | 'unlimited';
  /** Total environments a workspace may hold, of any kind. */
  environments: number | 'unlimited';
  /** Capacity in bytes; does not reset monthly. */
  combinedStorageBytes: number | null;
  egressBytesPerMonth: number | null;
  traceRetentionDays: number;
}

export interface PlanDetails {
  access?: BillingAccess;
  betaAllowances?: BetaAllowances;
  plan: PlanType;
  pendingPlan?: PlanType | null;
  limits: BillingPlanLimits;
  features: BillingPublicFeatures;
  pricing: BillingDisplayPricing;
  subscription: BillingSubscriptionSummary;
}

export interface Plan {
  id: PlanType;
  name: string;
  description: string;
  pricing: {
    monthlyFee: number;
    perMessageCost: number;
  };
  limits: Record<string, unknown>;
  features: Record<string, unknown>;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Options accepted by every mutation the API marks as idempotency-supported.
 */
export interface IdempotentRequestOptions {
  /**
   * Retry-safe key. Replaying a request with the same key returns the original
   * result instead of repeating the side effect. Reusing a key with a different
   * payload is a conflict.
   */
  idempotencyKey?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
  /**
   * The id the API gave this request (`X-Request-Id`). Quote it to support. Non-enumerable, so it
   * is left out of `JSON.stringify` and equality checks. Absent when the server sent none.
   */
  requestId?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data?: T[];
  pagination?: Pagination;
  error?: ApiError;
  /** The id the API gave this request (`X-Request-Id`). Non-enumerable; see `ApiResponse.requestId`. */
  requestId?: string;
}

export interface MessageAnalytics {
  published: number;
  delivered: number;
  failed: number;
  pending: number;
  successRate: number;
  averageDeliveryTime: number;
}

export interface TimeSeriesDataPoint {
  period: string;
  published: number;
  delivered: number;
  failed: number;
}

export interface TopUrlEntry {
  url: string;
  messageCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
}

export interface CurrentUsage {
  date: string;
  messagesPublished: number;
  messagesDelivered: number;
  messagesFailed: number;
  bandwidthBytes: number;
  eventPublishes: number;
  actionInvokes: number;
}

export interface UsageHistoryEntry extends CurrentUsage {}

export interface AnalyticsMetadata {
  range: {
    startDate: string;
    endDate: string;
    granularity: TimeGranularity;
    truncated: boolean;
    retentionDays: number | null;
  };
  scope: {
    workspaceId: string;
    environmentId: string | null;
  };
}

export interface AnalyticsOverview extends AnalyticsMetadata {
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
    counters: Omit<CurrentUsage, 'date'>;
    scope: 'workspace';
  };
  series: UsageHistoryEntry[];
  attention: Array<{
    product: 'agents' | 'delivery' | 'actions' | 'approvals';
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
  series: Array<{
    period: string;
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
  }>;
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
    series: Array<{
      period: string;
      total: number;
      succeeded: number;
      failed: number;
      denied: number;
    }>;
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
    series: Array<{
      period: string;
      total: number;
      approved: number;
      denied: number;
      expired: number;
    }>;
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
  messages: MessageAnalytics;
  messageSeries: TimeSeriesDataPoint[];
  bandwidthBytes: number;
  topUrls: TopUrlEntry[];
  errors: ErrorDistribution[];
}

export interface BillingUsage {
  currentMonthMessages: number;
  currentMonthBandwidth: number;
  dailyMessages: number;
  estimatedCost: number;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  usageResetDate: string;
}

export interface NotificationListResponse {
  notifications: Notification[];
  unreadCount: number;
  total: number;
}

export interface SimpleMessage {
  message: string;
}

/** Result of `dlq.retry()`: the message is back on its delivery stream. */
export interface DLQRetryResult extends SimpleMessage {
  messageId: string;
}

/** Result of a bounded DLQ bulk pass; `remaining` is what is left to do. */
export interface DLQRetryAllResult extends SimpleMessage {
  retriedCount: number;
  remaining: number;
}

/** Result of a bounded DLQ clear; `remaining` is what is left to delete. */
export interface DLQClearResult extends SimpleMessage {
  deletedCount: number;
  remaining: number;
}

export interface ErrorDistribution {
  errorMessage: string;
  count: number;
}

export interface OnboardingStep {
  id: 'api_key' | 'first_invocation';
  completed: boolean;
  label: string;
}

export interface OnboardingStatus {
  isOnboarded: boolean;
  hasApiKey: boolean;
  hasInvocations: boolean;
  totalInvocations: number;
  steps: OnboardingStep[];
  completedSteps: number;
  totalSteps: number;
  completionPercentage: number;
}

export interface BillingPublicFeatures {
  customHeaders: boolean; webhooks: boolean; events: boolean;
  actions: boolean; approvals: boolean;
  budgets: boolean; analytics: boolean; prioritySupport: boolean; sla: boolean;
  dedicatedSupport: boolean;
  protectedProduction: boolean; controlledPromotion: boolean;
}

export interface BillingRawPricing {
  monthlyFee: number; perMessageCost: number; includedMessages: number;
  bandwidthOverageCost: number; perEventPublishCost: number; perActionInvokeCost: number;
}

export interface BillingPlanLimits {
  maxSeats: number | 'unlimited';
  maxActions: number | 'unlimited';
  /** Total environments the plan allows, of any kind. */
  maxEnvironments: number | 'unlimited';
  maxMonthlyActionInvokes: number | 'unlimited';
  traceRetentionDays: number;
  traceArchival: boolean;
  usagePolicy: BillingUsagePolicies;
  maxMessagesPerDay: number | 'unlimited';
  maxMonthlyMessages: number | 'unlimited';
  maxMonthlyBandwidth: number; maxRetries: number; maxMessageSize: number; maxHttpTimeout: number;
  rateLimit: { requestsPerMinute: number | 'unlimited'; requestsPerHour: number | 'unlimited' };
  maxBatchSize: number; maxConcurrentDeliveries: number | 'unlimited';
  analyticsRetentionDays: number | 'unlimited';
  logRetentionDays: number | 'unlimited';
  /** Anlyon Vigil reviews per UTC month; a hard cap. */
  maxMonthlyAssistantReviews?: number | 'unlimited';
  /** Anlyon Vigil approvals per UTC day; a hard cap. */
  maxDailyAssistantAutoApprovals?: number | 'unlimited';
  features: BillingPublicFeatures; pricing: BillingRawPricing;
}

export interface BillingDisplayPricing {
  monthlyFee: number; perMessageCost: number; includedMessages: number;
  bandwidthOverageCost: number; includedBandwidth: string;
}

export interface BillingSubscriptionSummary {
  status: string | null; isCustomerConfigured: boolean; hasSubscription: boolean; trialEndsAt: string | null;
}

export interface BillingPlanComparison {
  name: string;
  features: Record<string, boolean | string | number>;
  limits: BillingPlanLimits;
  pricing: BillingRawPricing;
  usagePolicy: BillingUsagePolicies;
  purchasable: boolean;
}

export interface BillingPlanList {
  access?: { mode: 'early_beta' | 'standard'; paidPlansAvailable: boolean };
  betaAllowances?: BetaAllowances;
  plans: Record<Exclude<PlanType, 'paygo'>, BillingPlanComparison>;
  currentPlan: PlanType | null;
}

export interface BillingUsageDay extends UsageHistoryEntry {}
export interface BillingUsageHistory {
  period: { days: number; startDate: string; endDate: string };
  history: BillingUsageDay[];
  totals: Omit<BillingUsageDay, 'date'>;
}

export interface BillingQuotaDimension {
  used: number; limit: number | 'unlimited'; percentage: number;
}
export interface BillingQuota {
  plan: PlanType; daily: BillingQuotaDimension; monthly: BillingQuotaDimension; bandwidth: BillingQuotaDimension;
  allowances: BillingAllowances;
  actionInvokes: BillingUsageAllowance & { reservedUnits: number };
  projectedOverageCents: number;
}

export interface WorkspaceBillingBudget {
  workspaceId: string;
  maxOverageCents: number;
  alertThresholds: number[];
  behaviourAtMax: 'alert_only';
  enabled: boolean;
}

export type BillingUsagePolicy =
  | { kind: 'hard-cap'; capUnits: number }
  | { kind: 'included-then-overage'; includedUnits: number; overageCentsPerUnit: number }
  | { kind: 'unlimited' };

export type BillingUsagePolicies = Record<'actionInvokes' | 'messages' | 'storage' | 'bandwidth', BillingUsagePolicy>;

export interface BillingUsageAllowance {
  includedUnits: number | null;
  usedUnits: number;
  overageUnits: number;
  projectedOverageCents: number;
}

export interface BillingAllowances {
  actionInvokes: BillingUsageAllowance & { reservedUnits: number };
  messages: BillingUsageAllowance;
  storage: BillingUsageAllowance;
  bandwidth: BillingUsageAllowance;
  projectedOverageCents: number;
  monthlyFeeCents: number;
}

export interface CostEstimate {
  plan: PlanType;
  currentMonth: { messagesUsed: number; bandwidthUsed: string; estimatedCost: number; currency: 'USD' };
  breakdown: { baseFee: number; messageCost: number; bandwidthCost: number; perMessageRate: number; perGBRate: number };
}

export interface Invoice {
  id: string;
  stripeInvoiceId: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  period: { start: string; end: string };
  urls: { invoice: string | null; pdf: string | null };
  paidAt: string | null;
  createdAt: string;
}

export interface BillingInvoiceList { invoices: Invoice[]; total: number }
