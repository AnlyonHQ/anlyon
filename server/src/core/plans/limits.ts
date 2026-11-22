export const PLAN_IDS = ["free", "paygo", "enterprise", "production", "growth", "starter"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export type PlanType = PlanId;

export type EnvironmentKind = "development" | "staging" | "production";

export const USAGE_DIMENSIONS = ["actionInvokes", "messages", "storage", "bandwidth"] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

export type UsagePolicy =
  | { kind: "hard-cap"; capUnits: number }
  | { kind: "included-with-grace"; includedUnits: number; graceCapUnits: number }
  | { kind: "payment-required" }
  | { kind: "unlimited" };

export const ACTION_ALERT_THRESHOLDS = [80, 100] as const;
export const ACTION_PACK_VALID_MONTHS = 12;

export const AUDIT_RETENTION_GRACE_DAYS = 30;

export interface FunctionRunLimits {
  runsPerMonth: number | "unlimited";
  concurrentRuns: number | "unlimited";
  runStartsPerMinute: number | "unlimited";
}

export interface PlanLimits {
  maxSeats: number | "unlimited";
  functionRuns: FunctionRunLimits;
  maxEnvironments: number | "unlimited";
  usagePolicy: Record<UsageDimension, UsagePolicy>;
  maxMessagesPerDay: number | "unlimited";
  maxMonthlyMessages: number | "unlimited";
  maxMonthlyBandwidth: number;
  includedBandwidth: number;
  maxRetries: number;
  maxMessageSize: number;
  maxHttpTimeout: number;
  rateLimit: {
    requestsPerMinute: number | "unlimited";
    requestsPerHour: number | "unlimited";
  };
  maxConcurrentDeliveries: number | "unlimited";
  maxBatchSize: number;
  maxTopics: number | "unlimited";
  maxSubscriptionsPerTopic: number | "unlimited";
  maxMonthlyEventPublishes: number | "unlimited";
  maxSecrets: number | "unlimited";
  maxActions: number | "unlimited";
  maxMonthlyActionInvokes: number | "unlimited";
  maxPendingApprovals: number | "unlimited";
  maxMonthlyAssistantReviews: number | "unlimited";
  maxDailyAssistantAutoApprovals: number | "unlimited";
  maxApprovalPoliciesPerEnvironment: number | "unlimited";
  maxMonthlyConditionDrafts: number;
  maxMonthlyNotificationEmails: number | "unlimited";
  auditRetentionMonths: number | "unlimited";
  traceRetentionDays: number;
  traceArchival: boolean;
  analyticsRetentionDays: number | "unlimited";
  logRetentionDays: number | "unlimited";
  features: {
    customHeaders: boolean;
    webhooks: boolean;
    events: boolean;
    actions: boolean;
    approvals: boolean;
    budgets: boolean;
    analytics: boolean;
    prioritySupport: boolean;
    sla: boolean;
    dedicatedSupport: boolean;
    protectedProduction: boolean;
    controlledPromotion: boolean;
    teamFeatures: boolean;
  };
  pricing: {
    monthlyFee: number;
    yearlyFee: number;
    perMessageCost: number;
    includedMessages: number;
    bandwidthOverageCost: number;
    perEventPublishCost: number;
    perActionInvokeCost: number;
  };
}

const UNLIMITED = "unlimited" as const;

export const SELF_HOSTED_LIMITS: PlanLimits = {
  maxSeats: UNLIMITED,
  functionRuns: { runsPerMonth: UNLIMITED, concurrentRuns: UNLIMITED, runStartsPerMinute: UNLIMITED },
  maxEnvironments: UNLIMITED,
  usagePolicy: {
    actionInvokes: { kind: "unlimited" },
    messages: { kind: "unlimited" },
    storage: { kind: "unlimited" },
    bandwidth: { kind: "unlimited" },
  },
  maxMessagesPerDay: UNLIMITED,
  maxMonthlyMessages: UNLIMITED,
  maxMonthlyBandwidth: Number.MAX_SAFE_INTEGER,
  includedBandwidth: Number.MAX_SAFE_INTEGER,
  maxRetries: 10,
  maxMessageSize: 100 * 1024 * 1024,
  maxHttpTimeout: 24 * 60 * 60 * 1000,
  rateLimit: { requestsPerMinute: UNLIMITED, requestsPerHour: UNLIMITED },
  maxConcurrentDeliveries: UNLIMITED,
  maxBatchSize: 10_000,
  maxTopics: UNLIMITED,
  maxSubscriptionsPerTopic: UNLIMITED,
  maxMonthlyEventPublishes: UNLIMITED,
  maxSecrets: UNLIMITED,
  maxActions: UNLIMITED,
  maxMonthlyActionInvokes: UNLIMITED,
  maxPendingApprovals: UNLIMITED,
  maxMonthlyAssistantReviews: UNLIMITED,
  maxDailyAssistantAutoApprovals: UNLIMITED,
  maxApprovalPoliciesPerEnvironment: UNLIMITED,
  maxMonthlyConditionDrafts: 5_000,
  maxMonthlyNotificationEmails: UNLIMITED,
  auditRetentionMonths: UNLIMITED,
  traceRetentionDays: 365,
  traceArchival: true,
  analyticsRetentionDays: UNLIMITED,
  logRetentionDays: UNLIMITED,
  features: {
    customHeaders: true,
    webhooks: true,
    events: true,
    actions: true,
    approvals: true,
    budgets: true,
    analytics: true,
    prioritySupport: true,
    sla: false,
    dedicatedSupport: true,
    protectedProduction: true,
    controlledPromotion: true,
    teamFeatures: true,
  },
  pricing: {
    monthlyFee: 0,
    yearlyFee: 0,
    perMessageCost: 0,
    includedMessages: Number.MAX_SAFE_INTEGER,
    bandwidthOverageCost: 0,
    perEventPublishCost: 0,
    perActionInvokeCost: 0,
  },
};

export interface WorkspaceAge {
  createdAt?: Date | string | null;
}

export interface PlanProvider {
  limits(plan: PlanId, workspace?: WorkspaceAge | null): PlanLimits;
  purchasable(): boolean;
  epoch(): number;
}

let provider: PlanProvider | null = null;

export function setPlanProvider(next: PlanProvider): void {
  if (provider && provider !== next) throw new Error("A plan provider is already registered");
  provider = next;
}

export function resetPlanProvider(): void {
  provider = null;
}

export function hasPlanProvider(): boolean {
  return provider !== null;
}

const reportedUnknownPlans = new Set<string>();

export function normalizePlan(plan: string | null | undefined): PlanId {
  if (typeof plan === "string" && (PLAN_IDS as readonly string[]).includes(plan)) return plan as PlanId;
  const value = String(plan);
  if (!reportedUnknownPlans.has(value)) {
    reportedUnknownPlans.add(value);
    console.warn("Unknown workspace plan; using Free limits", { plan: value });
  }
  return "free";
}

export function getPlanLimits(plan: string | null | undefined, workspace?: WorkspaceAge | null): PlanLimits {
  if (!provider) return SELF_HOSTED_LIMITS;
  return provider.limits(normalizePlan(plan), workspace);
}

export function upgradesPurchasable(): boolean {
  return provider?.purchasable() ?? false;
}

export function planLimitsEpoch(): number {
  return provider?.epoch() ?? 0;
}

export function isFeatureAvailable(plan: string, feature: keyof PlanLimits["features"], workspace?: WorkspaceAge | null): boolean {
  return getPlanLimits(plan, workspace).features[feature];
}

export function getNumericLimit(value: number | "unlimited"): number {
  return value === "unlimited" ? Number.MAX_SAFE_INTEGER : value;
}

export function actionCapUnits(policy: UsagePolicy, creditUnits = 0): number | null {
  switch (policy.kind) {
    case "hard-cap": return policy.capUnits + creditUnits;
    case "included-with-grace": return policy.graceCapUnits + creditUnits;
    case "payment-required": return 0;
    case "unlimited": return null;
  }
}

export function usageAllowance(policy: UsagePolicy, usedUnits: number) {
  const includedUnits = policy.kind === "hard-cap" ? policy.capUnits
    : policy.kind === "included-with-grace" ? policy.includedUnits
      : policy.kind === "payment-required" ? 0 : null;
  const graceCapUnits = policy.kind === "included-with-grace" ? policy.graceCapUnits : includedUnits;
  return { includedUnits, graceCapUnits, usedUnits, overageUnits: 0, projectedOverageCents: 0 };
}

export function isBandwidthExceeded(plan: string, currentBandwidth: number): boolean {
  const policy = getPlanLimits(plan).usagePolicy.bandwidth;
  return policy.kind === "hard-cap" && currentBandwidth >= policy.capUnits;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  if (bytes === Number.MAX_SAFE_INTEGER) return "Unlimited";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
