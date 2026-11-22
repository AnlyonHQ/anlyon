import type { FunctionRunLimitsEntry } from "./plan-comparison";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type MessageStatus =
	| "pending"
	| "scheduled"
	| "processing"
	| "delivered"
	| "failed"
	| "cancelled";

export type Plan =
	| "free"
	| "starter"
	| "production"
	| "growth"
	| "enterprise"
	| "paygo";

export type Role = "admin" | "member" | "approver" | "viewer";

export type AssignableRole = Role;

export type EnvironmentRole = Role;

export interface EnvironmentRoleGrant {
	environmentId: string;
	role: EnvironmentRole;
	grantedBy: string | null;
	createdAt: string;
	updatedAt: string;
}

export type WorkspacePermission =
	| "workspace.read"
	| "workspace.update"
	| "workspace.delete"
	| "members.manage"
	| "billing.manage"
	| "keys.manage"
	| "environments.manage"
	| "environments.delete"
	| "notifications.manage"
	| "assistant.manage"
	| "governance.sign_off"
	| "agents.manage"
	| "identity.manage"
	| "audit.manage"
	| "secret-stores.manage"
	| "environments.halt"
	| "environments.resume"
	| "policies.manage"
	| "actions.manage"
	| "actions.invoke"
	| "actions.resolve"
	| "connections.manage"
	| "oauth-apps.manage"
	| "limits.manage"
	| "integrations.manage"
	| "approvals.request"
	| "approvals.decide"
	| "resources.write";

export interface WorkspacePermissions {
	role: Role;
	emergencyAccess?: boolean;
	permissions: WorkspacePermission[];
	environmentRolesEnabled: boolean;
	environments: Array<{
		environmentId: string;
		role: Role;
		granted: boolean;
		permissions: WorkspacePermission[];
	}>;
}

export type Granularity = "hour" | "day" | "week" | "month";

export interface Message {
	messageId: string;
	contentHash?: string;
	queueId?: string | null;
	eventId?: string | null;
	eventSubscriptionId?: string | null;
	url: string;
	method: HttpMethod;
	headers?: Record<string, string>;
	body?: unknown;
	scheduledFor?: string;
	delay?: number;
	status: MessageStatus;
	attempts: number;
	maxRetries: number;
	responseStatus?: number;
	responseBody?: string;
	errorMessage?: string;
	deliveredAt?: string;
	failedAt?: string;
	callbackUrl?: string;
	failureCallbackUrl?: string;
	createdAt: string;
	updatedAt: string;
}

export interface PaginatedResponse<T> {
	data: T[];
	pagination: {
		page: number;
		limit: number;
		total: number;
		totalPages: number;
		hasMore: boolean;
	};
}

export interface MessageAnalytics {
	published: number;
	total?: number;
	delivered: number;
	failed: number;
	pending: number;
	scheduled?: number;
	processing?: number;
	cancelled?: number;
	successRate: number;
	averageDeliveryTime: number;
}

export interface TimeSeriesData {
	timestamp: string;
	published: number;
	delivered: number;
	failed: number;
	pending: number;
}

export interface TopUrl {
	url: string;
	messageCount: number;
	successCount: number;
	failureCount: number;
}

export interface UsageStats {
	date: string;
	messagesPublished: number;
	messagesDelivered: number;
	messagesFailed: number;
	schedulesExecuted: number;
	bandwidthBytes: number;
	memoryOperations: number;
	embeddingTokens: number;
	llmTokens: number;
	rerankOperations: number;
	memoryStorageBytes: number;
	eventPublishes: number;
	fileStorageBytes: number;
	cacheLookups: number;
	cacheHits: number;
	actionInvokes: number;
}

export interface ErrorDistribution {
	errorMessage: string;
	count: number;
}

export interface AnalyticsQuery {
	workspaceId?: string;
	startDate?: string;
	endDate?: string;
	granularity?: Granularity;
	environmentId?: string;
	limit?: number;
}

export interface AnalyticsMetadata {
	range: {
		startDate: string;
		endDate: string;
		granularity: Granularity;
		truncated: boolean;
		retentionDays: number | null;
	};
	scope: {
		workspaceId: string;
		environmentId: string | null;
	};
}

export interface ProductUsagePoint extends UsageStats {}

export interface OverviewAnalytics extends AnalyticsMetadata {
	summary: {
		agentRuns: number;
		agentRunSuccessRate: number;
		actionInvocations: number;
		actionSuccessRate: number;
		pendingApprovals: number;
	};
	usage: {
		counters: Omit<
			ProductUsagePoint,
			"date" | "memoryStorageBytes" | "fileStorageBytes"
		>;
		scope: "workspace";
	};
	series: ProductUsagePoint[];
	attention: Array<{
		product: "agents" | "delivery" | "workflows" | "actions" | "approvals";
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
		running: number;
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
			pending: number;
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
			pending: number;
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

export interface DlqStats {
	totalMessages: number;
	oldestMessage?: string;
	newestMessage?: string;
	avgErrorCode?: string;
}

export interface Workspace {
	id: string;
	name: string;
	slug: string;
	plan: Plan;
	subscriptionStatus: string;
	trialEndsAt?: string;
	monthlyMessageQuota: number;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceWithMembership {
	workspace: Workspace;
	role: Role;
	joinedAt: string;
}

export interface CreateWorkspaceRequest {
	name: string;
	slug?: string;
}

export interface WorkspaceCredentials {
	apiKey: {
		id: string;
		name: string;
		key: string;
		keyPrefix: string;
	} | null;
	signingSecret: {
		id: string;
		secretKey: string;
		secretPrefix: string;
		version: number;
	} | null;
}

export interface WorkspaceWithCredentials extends Workspace {
	credentials: WorkspaceCredentials;
}

export interface UpdateWorkspaceRequest {
	name: string;
}

export type ActingFor = "team" | "users" | "both";

export interface WorkspaceDefaults {
	actingFor: ActingFor | null;
	endUserDecider: ApprovalDecider | null;
	approvalWindowHours: number | null;
	effective: { endUserDecider: ApprovalDecider; approvalWindowHours: number };
	recommended: {
		actingFor: ActingFor;
		endUserDecider: ApprovalDecider;
		approvalWindowHours: number;
	};
	setup: { status: "completed" | "skipped" | null; at: string | null };
	updatedAt: string | null;
}

export interface UpdateWorkspaceDefaultsRequest {
	actingFor?: ActingFor | null;
	endUserDecider?: ApprovalDecider | null;
	approvalWindowHours?: number | null;
	setupStatus?: "completed" | "skipped";
	source?: WorkspaceDefaultsSource;
}

export type WorkspaceDefaultsSource =
	| "setup_journey"
	| "defaults_page"
	| "home_prompt";

export interface WorkspaceMember {
	id: string;
	workspaceId: string;
	userId: string;
	role: Role;
	emergencyAccess?: boolean;
	invitedBy?: string;
	invitedAt?: string;
	joinedAt: string;
	createdAt: string;
	user?: {
		id: string;
		email: string;
		name?: string;
	};
	environmentRoles?: EnvironmentRoleGrant[];
}

export interface AddMemberRequest {
	userId: string;
	role?: AssignableRole;
}

export interface UpdateMemberRequest {
	role: AssignableRole;
}

export interface SetEmergencyAccessRequest {
	enabled: boolean;
}

export interface ApiKey {
	id: string;
	workspaceId: string;
	environmentId: string | null;
	name: string;
	keyHash: string;
	keyPrefix: string;
	isActive: boolean;
	lastUsedAt?: string;
	createdBy: string;
	createdAt: string;
	expiresAt?: string;
	endUserRequired?: boolean;
}

export interface CreateApiKeyRequest {
	name: string;
	expiresAt?: string;
	environmentId?: string;
	scopes?: string[];
	endUserRequired?: boolean;
}

export interface CreateApiKeyResponse {
	apiKey: ApiKey;
	key: string;
}

export interface ApiKeyHistoryEntry {
	id: string;
	apiKeyId: string;
	version: number;
	keyPrefix: string;
	createdAt: string;
	expiredAt?: string;
	rollbackAvailable: boolean;
	rollbackExpiresAt?: string;
}

export interface ApiKeyHistoryResponse {
	currentVersion?: number;
	history: ApiKeyHistoryEntry[];
	rollbackWindowMinutes?: number;
}

export interface ApiKeyHistoryEntryRaw {
	id: string;
	version: number;
	keyPrefix: string;
	rotatedAt: string;
	rollbackExpiresAt?: string;
	canRollback: boolean;
	rotatedBy?: string;
}

export interface RegenerateApiKeyResponse {
	apiKey: ApiKey;
	key: string;
	previousVersion: number;
	rollbackAvailable: boolean;
	rollbackExpiresAt: string;
}

export interface RollbackApiKeyResponse {
	apiKey: ApiKey;
	restoredVersion: number;
	message: string;
}

export interface DeliverySecret {
	id: string;
	workspaceId: string;
	secretPrefix: string;
	version: number;
	isActive: boolean;
	createdAt: string;
	createdBy: string;
	lastUsedAt?: string;
}

export interface CreateDeliverySecretResponse {
	secret: DeliverySecret;
	secretKey: string;
}

export type PlanType = Plan;
export type PublicPlan = Exclude<Plan, "paygo">;
export type PaidPlan = "starter" | "production" | "growth";
export type CatalogPlanId = PaidPlan | "enterprise";
export type BillingInterval = "month" | "year";
export type SubscriptionStatus =
	| "none"
	| "trialing"
	| "active"
	| "past_due"
	| "canceled"
	| "paused";
export type UsagePolicy =
	| { kind: "hard-cap"; capUnits: number }
	| {
			kind: "included-then-overage";
			includedUnits: number;
			overageCentsPerUnit: number;
	  }
	| { kind: "unlimited" }
	| {
			kind: "included-with-grace";
			includedUnits: number;
			graceCapUnits: number;
	  }
	| { kind: "payment-required" };
export type BillableDimension =
	| "actionInvokes"
	| "messages"
	| "storage"
	| "bandwidth";
export interface UsageAllowance {
	includedUnits: number | null;
	usedUnits: number;
	overageUnits: number;
	projectedOverageCents: number;
	reservedUnits?: number;
}
export interface AvailablePlan {
	name: string;
	limits: PlanLimits;
	features: PlanFeatures;
	pricing: PlanPricing;
	usagePolicy: Record<BillableDimension, UsagePolicy>;
	purchasable: boolean;
}

export interface WorkspaceBudget {
	maxOverageCents: number;
	alertThresholds: number[];
	behaviourAtMax: "alert_only";
	enabled: boolean;
}

export interface PlanLimits {
	maxSeats: number | "unlimited";
	maxActions: number | "unlimited";
	maxEnvironments: number | "unlimited";
	traceRetentionDays: number;
	traceArchival: boolean;
	usagePolicy: Record<BillableDimension, UsagePolicy>;
	maxMessagesPerDay: number | "unlimited";
	maxMonthlyMessages: number | "unlimited";
	maxMonthlyBandwidth: number;
	maxRetries: number;
	maxMessageSize: number;
	maxHttpTimeout: number;
	rateLimit: {
		requestsPerMinute: number | "unlimited";
		requestsPerHour: number | "unlimited";
	};
	analyticsRetentionDays: number | "unlimited";
	logRetentionDays: number | "unlimited";
	maxMonthlyAssistantReviews?: number | "unlimited";
	maxDailyAssistantAutoApprovals?: number | "unlimited";
	features: PlanFeatures;
	pricing: PlanPricing;
}

export interface PlanFeatures {
	protectedProduction: boolean;
	controlledPromotion: boolean;
	customHeaders: boolean;
	events: boolean;
	actions: boolean;
	approvals: boolean;
	budgets: boolean;
	webhooks: boolean;
	analytics: boolean;
	prioritySupport: boolean;
	sla: boolean;
	dedicatedSupport: boolean;
}

export type EventStatus = "received" | "fanned_out" | "no_subscribers";

export interface EventTopic {
	id: string;
	name: string;
	description: string | null;
	isReserved: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface EventSubscription {
	id: string;
	url: string;
	eventTypes: string[];
	enabled: boolean;
	hasCustomSecret: boolean;
	headers: Record<string, string> | null;
	createdAt: string;
	updatedAt: string;
	secret?: string;
}

export interface EventRecord {
	id: string;
	topic?: string;
	type: string;
	data: Record<string, unknown>;
	status: EventStatus | string;
	subscriptionCount: number;
	createdAt: string;
}

export interface EventDelivery {
	messageId: string;
	url: string;
	status: string;
	attempts: number;
	responseStatus: number | null;
	deliveredAt: string | null;
	failedAt: string | null;
}

export interface EventWithDeliveries extends EventRecord {
	deliveries: EventDelivery[];
}

export interface CreateTopicRequest {
	name: string;
	description?: string;
}

export interface CreateSubscriptionRequest {
	url: string;
	eventTypes?: string[];
	enabled?: boolean;
	generateSecret?: boolean;
	headers?: Record<string, string>;
}

export interface UpdateSubscriptionRequest {
	url?: string;
	eventTypes?: string[];
	enabled?: boolean;
	headers?: Record<string, string> | null;
}

export interface RotateSubscriptionSecretResult {
	id: string;
	secret: string;
}

export interface PlanPricing {
	monthlyFee: number;
	perMessageCost: number;
	includedMessages: number;
}

export interface BillingAccess {
	mode: "early_beta" | "standard";
	betaAllowancesApply: boolean;
	paidPlansAvailable: boolean;
	betaAllowancesEndAt: string | null;
	usageResetsAt: string;
	overageBilling: false;
	automaticCharges: false;
}

export interface BetaAllowances {
	actionExecutionsPerMonth: number | null;
	durableMessagesPerMonth: number | null;
	actionDefinitions: number | "unlimited";
	seatsIncludingPendingInvitations: number | "unlimited";
	environments: number | "unlimited";
	combinedStorageBytes: number | null;
	egressBytesPerMonth: number | null;
	traceRetentionDays: number;
}

export interface PlanDetails {
	plan: PlanType;
	pendingPlan?: PlanType | null;
	displayName?: string;
	status?: SubscriptionStatus;
	interval?: BillingInterval | null;
	trialEndsAt?: string | null;
	currentPeriodEnd?: string | null;
	cancelAtPeriodEnd?: boolean;
	trialAvailable?: boolean;
	graceEndsAt?: string | null;
	provider?: string | null;
	limits: PlanLimits;
	features: PlanFeatures;
	pricing: PlanPricing;
	access?: BillingAccess;
	betaAllowances?: BetaAllowances;
	subscription?: {
		status: string | null;
		isCustomerConfigured: boolean;
		hasSubscription: boolean;
	};
}

export interface BillingUsage {
	currentMonthMessages: number;
	currentMonthBandwidth: number;
	dailyMessages: number;
	estimatedCost: number;
	billingPeriodStart: string;
	billingPeriodEnd: string;
	usageResetDate: string;
	actionAllowance?: ActionAllowance;
}

export interface ActionAllowance {
	included: number | null;
	credits: number;
	graceCap: number | null;
	used: number;
	paymentRequired?: boolean;
}

export interface FunctionRunUsage {
	used: number;
	running: number;
	limits: FunctionRunLimitsEntry;
	available: boolean;
}

export interface QuotaStatus {
	allowances: Record<BillableDimension, UsageAllowance> & {
		monthlyFeeCents: number;
		projectedOverageCents: number;
	};
	actionAllowance?: ActionAllowance;
	functionRuns?: FunctionRunUsage;
	projectedOverageCents: number;
	plan: PlanType;
	daily: {
		used: number;
		limit: number | "unlimited";
		percentage: number;
	};
	monthly: {
		used: number;
		limit: number | "unlimited";
		percentage: number;
	};
	bandwidth: {
		used: number;
		limit: number;
		percentage: number;
	};
}

export interface CostEstimate {
	estimatedMessages: number;
	estimatedCost: number;
	currentUsage: number;
	projectedMonthlyUsage: number;
	projectedMonthlyCost: number;
}

export type NotificationType =
	| "quota_warning"
	| "quota_exceeded"
	| "payment_failed"
	| "plan_upgraded"
	| "plan_downgraded"
	| "feature_enabled"
	| "system_alert"
	| "security_alert"
	| "delivery_failure_spike"
	| "api_key_expiring"
	| "approval_requested"
	| "budget_alert"
	| "approval_expired"
	| "outcome_unknown"
	| "connection_broken";

export type NotificationPriority = "low" | "medium" | "high" | "critical";

export interface Notification {
	id: string;
	workspaceId: string;
	userId?: string;
	type: NotificationType;
	priority: NotificationPriority;
	title: string;
	message: string;
	actionUrl?: string;
	actionLabel?: string;
	isRead: boolean;
	readAt?: string;
	createdAt: string;
	expiresAt?: string;
	metadata?: Record<string, unknown>;
}

export interface NotificationPreferences {
	workspaceId: string;
	emailEnabled: boolean;
	webhookEnabled: boolean;
	inAppEnabled: boolean;
	slackEnabled: boolean;
	discordEnabled: boolean;
	emailRecipients: string[];
	webhookUrl?: string;
	webhookSecret?: string;
	quotaAlertThresholds: number[];
	enabledTypes: NotificationType[];
	createdAt: string;
	updatedAt: string;
}

export interface MyNotificationPreferences {
	mutedTypes: NotificationType[];
	updatedAt: string | null;
}

export interface UpdateNotificationPreferencesRequest {
	emailEnabled?: boolean;
	webhookEnabled?: boolean;
	inAppEnabled?: boolean;
	slackEnabled?: boolean;
	discordEnabled?: boolean;
	emailRecipients?: string[];
	webhookUrl?: string | null;
	webhookSecret?: string | null;
	quotaAlertThresholds?: number[];
	enabledTypes?: NotificationType[];
}

export interface InviteMemberRequest {
	email: string;
	role?: Role;
}

export type IntegrationType = "slack" | "discord";

export type IntegrationEventType =
	| "quota_warning"
	| "quota_exceeded"
	| "payment_failed"
	| "security_alert"
	| "delivery_failure_spike"
	| "system_alert"
	| "approval_requested"
	| "budget_alert"
	| "approval_expired"
	| "outcome_unknown"
	| "connection_broken";

export interface IntegrationConnection {
	id: string;
	workspaceId: string;
	type: IntegrationType;
	name: string;
	isActive: boolean;
	slackTeamId?: string;
	slackTeamName?: string;
	slackChannelId?: string;
	slackChannelName?: string;
	slackBotUserId?: string;
	discordServerId?: string;
	discordChannelName?: string;
	enabledEventTypes: IntegrationEventType[];
	lastUsedAt?: string;
	lastError?: string;
	errorCount: number;
	createdBy?: string;
	createdAt: string;
	updatedAt: string;
}

export interface SlackChannel {
	id: string;
	name: string;
	isPrivate: boolean;
	isMember: boolean;
}

export interface CreateDiscordIntegrationRequest {
	name: string;
	webhookUrl: string;
	enabledEventTypes?: IntegrationEventType[];
}

export interface UpdateIntegrationRequest {
	name?: string;
	isActive?: boolean;
	slackChannelId?: string;
	enabledEventTypes?: IntegrationEventType[];
}

export interface SlackOAuthStartResponse {
	authUrl: string;
	state: string;
}

export interface TestIntegrationResponse {
	success: boolean;
	message: string;
}

export interface UpdateSlackChannelResponse {
	message: string;
	channelId: string;
	channelName: string;
	autoJoined: boolean;
	isPrivate?: boolean;
	joinError?: string;
}

export type UnifiedLogType = "message" | "all";
export type LogSortBy = "timestamp" | "duration" | "status" | "httpStatus";
export type LogSortOrder = "asc" | "desc";

export interface LogFilters {
	type: UnifiedLogType;
	status: string[];
	httpStatus: number[];
	dateRange: { start?: string; end?: string };
	duration: { min?: number; max?: number };
	url: string;
	messageId: string;
	errorCode: string;
	search: string;
	sortBy: LogSortBy;
	sortOrder: LogSortOrder;
	page: number;
	limit: number;
}

export interface UnifiedLogEntry {
	id: string;
	type: "message";
	entityId: string;
	status: string;
	timestamp: string;
	duration?: number | null;
	attemptNumber?: number | null;
	requestUrl?: string | null;
	requestMethod?: string | null;
	requestHeaders?: unknown;
	requestBody?: unknown;
	responseStatus?: number | null;
	responseHeaders?: unknown;
	responseBody?: string | null;
	errorMessage?: string | null;
	errorCode?: string | null;
}

export interface LogsStats {
	totalSuccess: number;
	totalError: number;
	totalRetry: number;
	avgDuration: number;
	errorRate: number;
}

export interface LogsResponse extends PaginatedResponse<UnifiedLogEntry> {
	stats: LogsStats;
}

export interface DetailedLogsStats {
	byStatus: Record<string, number>;
	byHttpStatus: Record<string, number>;
	byErrorCode: Record<string, number>;
	byHour: { hour: string; count: number; errors: number }[];
	avgDuration: number;
	p50Duration: number;
	p95Duration: number;
	p99Duration: number;
}

export type SecretHealthReason =
	| "key_rejected"
	| "access_revoked"
	| "refresh_failed"
	| SecretStoreFailure;

export type SecretStoreFailure =
	| "store_unreachable"
	| "store_denied"
	| "reference_not_found";

export interface SecretHealth {
	status: "active" | "needs_reauth" | "unreachable";
	checkedAt: string | null;
	reason: SecretHealthReason | null;
}

export type SecretStoreType = "aws_secrets_manager" | "hashicorp_vault";

export interface SecretStoreSettings {
	allowPrivateNetwork: boolean;
	available: boolean;
	effective: boolean;
	updatedAt: string | null;
}

export interface SecretStore {
	id: string;
	name: string;
	type: SecretStoreType;
	description: string | null;
	config: Record<string, unknown>;
	credentialKind: "access_key" | "token" | "approle";
	allowedPaths: string[] | null;
	cacheTtlSeconds: number;
	health: {
		status: "active" | "unreachable";
		checkedAt: string;
		reason: SecretStoreFailure | null;
	} | null;
	createdAt: string;
	updatedAt: string;
}

export type SecretPlacement = "url" | "header" | "body";

export interface Secret {
	id: string;
	name: string;
	description: string | null;
	allowedHosts?: string[] | null;
	allowedPlacements?: SecretPlacement[] | null;
	kind?: "static" | "connection" | "external";
	connection?: {
		integrationId: string;
		status: "active" | "needs_reauth";
	} | null;
	integrationId?: string | null;
	health?: SecretHealth | null;
	external?: {
		store: string;
		storeType: SecretStoreType;
		path: string;
		key: string | null;
		version: string | null;
	} | null;
	lastUsedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export type ActionMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type InvocationStatus =
	| "pending_approval"
	| "running"
	| "succeeded"
	| "failed"
	| "unknown"
	| "denied"
	| "expired";

export interface Action {
	id: string;
	environmentId: string;
	name: string;
	description: string | null;
	method: ActionMethod;
	urlTemplate: string;
	headers: Record<string, unknown>;
	bodyTemplate: Record<string, unknown> | null;
	inputSchema: Record<string, unknown>;
	requiresApproval: boolean;
	enabled: boolean;
	secrets: string[];
	adapter: { type: string; config: Record<string, unknown> } | null;
	governed: boolean;
	impact: ActionImpactDeclaration | null;
	verify: ActionVerifyDeclaration | null;
	createdAt: string;
	updatedAt: string;
}

export interface ActionImpactDeclaration {
	dimension: string;
	unit: string;
	amount: string;
	bound: "exact" | "upper_bound";
}

export type VerifyScalar = string | number | boolean | null;

export interface ActionVerifyDeclaration {
	url: string;
	status: number;
	match: Array<{ path: string; equals: VerifyScalar; absent?: boolean }>;
}

export interface Invocation {
	id: string;
	effectId?: string | null;
	actionName: string;
	status: InvocationStatus;
	responseStatus: number | null;
	body: string | null;
	error: string | null;
	durationMs: number | null;
	approvalId: string | null;
	decision?: InvocationDecision | null;
	retryOf?: string | null;
	retriedBy?: string | null;
	resolution?: InvocationResolution | null;
	endUserId?: string | null;
	createdAt: string;
	completedAt: string | null;
}

export interface InvocationResolution {
	outcome: "succeeded" | "failed";
	evidence: string;
	externalReference: string | null;
	resolvedBy: { type: "api_key" | "user"; id: string };
	resolvedAt: string;
}

export interface InvocationDecision {
	source: "policy" | "human" | "system" | "assistant";
	code:
		| "POLICY_DENIED"
		| "POLICY_APPROVED"
		| "HUMAN_APPROVED"
		| "HUMAN_DENIED"
		| "APPROVAL_EXPIRED"
		| "ASSISTANT_APPROVED";
	effect: "approved" | "denied" | "expired";
	explanation: string;
	policy: { id: string; name: string; version: number } | null;
	decidedAt: string;
}

export type ApprovalKind = "action" | "custom" | "function_plan";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface Approval {
	id: string;
	kind: ApprovalKind;
	status: ApprovalStatus;
	title: string;
	description: string | null;
	payload: Record<string, unknown>;
	decisionNote: string | null;
	decidedBy?: {
		type: "api_key" | "user";
		id: string;
		displayName: string | null;
	} | null;
	votes?: Array<{
		decision: "approve" | "deny";
		decidedBy: {
			type: "api_key" | "user";
			id: string;
			displayName: string | null;
		} | null;
		note: string | null;
		selfApproved?: boolean;
		decidedAt: string;
	}>;
	requiredApprovals: number;
	approvedCount: number;
	matchedPolicyId: string | null;
	matchedPolicyVersion: number | null;
	policyExplanation: string | null;
	decisionOrigin?:
		| "human"
		| "policy"
		| "system"
		| "unknown"
		| "assistant"
		| null;
	expiresAt: string;
	decidedAt: string | null;
	createdAt: string;
	advice?: AssistantAdvice;
	endUserId?: string | null;
	decider?: ApprovalDecider;
}

export type ApprovalDecider = "team" | "end_user";

export type AssistantRiskLevel =
	| "routine"
	| "low"
	| "moderate"
	| "high"
	| "critical";

export interface AssistantAdvice {
	status: "pending" | "ready" | "failed" | "skipped";
	statusReason: string | null;
	model: string | null;
	recommendation: "approve" | "deny" | "review" | null;
	risk: number | null;
	riskLevel: AssistantRiskLevel | null;
	confidence: number | null;
	reasons: string[];
	flags: {
		injectionSuspected: number | null;
		consistentWithHistory: number | null;
		amountUnusual: number | null;
	} | null;
	history: {
		approved: number;
		denied: number;
		maxAmount: number | null;
		medianAmount: number | null;
	} | null;
	auditRequested: boolean;
	auditVerdict: "agree" | "disagree" | null;
	createdAt: string;
	completedAt: string | null;
}

export interface AssistantAutoApprove {
	enabled: boolean;
	actions: string[];
	environments?: string[];
	maxAmount?: number | null;
	minConfidence: number;
	maxRisk: number;
	minHistory: number;
}

export interface AssistantUsageCounter {
	used: number;
	cap: number | "unlimited";
	period: string;
}

export interface AssistantSettings {
	available: boolean;
	enabled: boolean;
	consentVersion: string | null;
	currentConsentVersion: string;
	consentedAt: string | null;
	excludedFields: string[];
	autoApprove: AssistantAutoApprove;
	auditSampleRate: number;
	model: string;
	usage: {
		reviews: AssistantUsageCounter;
		autoApprovals: AssistantUsageCounter;
	};
}

export interface AssistantSettingsPatch {
	enabled?: boolean;
	consentVersion?: string;
	excludedFields?: string[];
	autoApprove?: Partial<Omit<AssistantAutoApprove, "environments">> & {
		environments?: string[];
	};
	auditSampleRate?: number;
}

export interface SuggestedPolicy {
	name: string;
	priority: number;
	matchKind: "action";
	matchActionName: string;
	matchAgentId: string | null;
	minAmount: number | null;
	effect: "auto_approve" | "require_approval";
}

export interface PolicySuggestion {
	key: string;
	environmentId: string;
	actionName: string;
	agentId: string | null;
	approved: number;
	maxAmount: number | null;
	averageRisk: number | null;
	policies: SuggestedPolicy[];
	preview: {
		wouldAutoApprove: number;
		wouldStillReview: number;
		wouldApproveDenied: number;
	};
}

export interface ApprovalDecision {
	approval: Approval;
	invocation?: Invocation;
	selfApproved?: boolean;
}

export type BudgetDimension =
	| "messages"
	| "eventPublishes"
	| "cacheLookups"
	| "memoryOps"
	| "actionInvokes";

export interface Budget {
	workspaceId: string;
	apiKeyId: string;
	monthlyCostCentsCap: number | null;
	dimensionCaps: Partial<Record<BudgetDimension, number>>;
	alertThreshold: number;
	enabled: boolean;
	usage: Record<BudgetDimension, number>;
	estimatedCostCents: number;
	alertedAt: string | null;
}

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export type SpanType =
	| "model_call"
	| "context_assembly"
	| "session_read"
	| "session_write"
	| "memory_recall"
	| "memory_write"
	| "tool_call"
	| "action_call"
	| "approval_wait"
	| "approval_decision"
	| "workflow_step"
	| "queue_delivery"
	| "event_delivery"
	| "custom";

export interface Run {
	id: string;
	agentId: string | null;
	agentVersion: string | null;
	environmentId: string;
	name: string | null;
	status: RunStatus;
	userId: string | null;
	application: string | null;
	input: unknown;
	output: unknown;
	error: Record<string, unknown> | null;
	tokens: number | null;
	cost: number | null;
	tags: string[] | null;
	metadata: Record<string, unknown> | null;
	startedAt: string;
	endedAt: string | null;
	durationMs: number | null;
}

export interface SpanNode {
	id: string;
	parentId: string | null;
	name: string;
	type: SpanType;
	status: "running" | "succeeded" | "failed";
	startedAt: string;
	endedAt: string | null;
	durationMs: number | null;
	model: string | null;
	provider: string | null;
	tokens: Record<string, number> | null;
	cost: number | null;
	input: unknown;
	output: unknown;
	error: Record<string, unknown> | null;
	attributes: Record<string, unknown> | null;
	children: SpanNode[];
}

export interface RunWithSpans extends Run {
	spans: SpanNode[];
}

export interface Environment {
	kind: "development" | "staging" | "production";
	id: string;
	name: string;
	slug: string;
	isDefault: boolean;
	isProtected: boolean;
	halted: boolean;
	haltedAt: string | null;
	haltedReason: string | null;
	allowedRedirectUrls?: string[];
	defaultRedirectUrl?: string | null;
	connectConfirmation?: ConnectConfirmation;
	createdAt: string;
	updatedAt: string;
}

export type ConnectConfirmation = "required" | "off";

export interface AgentVersion {
	id: string;
	version: number;
	config: Record<string, unknown>;
	createdAt: string;
}

export interface Agent {
	id: string;
	environmentId: string;
	name: string;
	description: string | null;
	currentVersion: number | null;
	archived: boolean;
	createdAt: string;
	updatedAt: string;
}

export type ApprovalPolicyEffect =
	| "require_approval"
	| "auto_approve"
	| "auto_deny";

export interface ApprovalPolicy {
	id: string;
	environmentId: string;
	name: string;
	priority: number;
	enabled: boolean;
	scope: "specific_action" | "all_actions" | "custom_requests" | "all_requests";
	needsScopeReview: boolean;
	match: {
		kind: "any" | "action" | "custom";
		actionName: string | null;
		agentId: string | null;
		userId: string | null;
		tags: string[] | null;
		minAmount: number | null;
		conditions: Record<string, unknown> | null;
		condition?: string | null;
	};
	effect: ApprovalPolicyEffect;
	requiredApprovals: number;
	decidedBy?: ApprovalDecider;
	version: number;
	scopeReviewedAt: string | null;
	createdAt: string;
	updatedAt: string;
	managedBy?: { file: string; key: string } | null;
}

export interface ConditionAssist {
	check: { valid: true } | { valid: false; message: string } | null;
	sample: { result: boolean } | { error: string } | null;
	inputFields: {
		path: string;
		type: string;
		optional: boolean;
		description: string | null;
	}[];
	facts: { name: string; type: string; description: string }[];
	legacyCondition: string | null;
}

export interface ApprovalPolicyVersion {
	policyId: string;
	version: number;
	operation: "created" | "updated" | "deleted" | "baseline";
	snapshot: Record<string, unknown>;
	contentHash: string;
	actor: { type: "api_key" | "user" | "unknown"; id: string } | null;
	changeNote: string | null;
	createdAt: string;
}

export type EffectStage =
	| "awaiting_approval"
	| "ready"
	| "dispatching"
	| "reconciling"
	| "settled"
	| "rejected";
export type EffectOutcome =
	| "not_dispatched"
	| "pending"
	| "succeeded"
	| "failed"
	| "unknown";
export type PartialEffect = "none" | "possible" | "confirmed";
export type EffectVerification =
	| "provider"
	| "manual"
	| "unverified"
	| "not_dispatched";

export type EffectGrade =
	| "confirmed"
	| "acknowledged"
	| "unknown"
	| "failed"
	| "refused"
	| "denied"
	| "pending";

export interface ImpactQuantity {
	dimension: string;
	currency?: string;
	amount: number;
	bound: "exact" | "upper_bound";
}

export type PreviewBlock =
	| {
			type: "fields";
			title: string;
			fields: Array<{ label: string; value: string }>;
	  }
	| {
			type: "text_diff";
			title: string;
			path: string;
			before: string;
			after: string;
			truncated: boolean;
	  }
	| { type: "impact"; title: string; quantities: ImpactQuantity[] }
	| {
			type: "limitations";
			title: string;
			items: Array<{
				kind: "guarantee" | "freshness" | "unsupported" | "irreversible";
				text: string;
			}>;
	  };

export interface ActionPreview {
	id: string;
	action: { id: string; name: string; versionId: string };
	adapter: { type: string; version: string };
	environment: { id: string; name: string; kind: string };
	target: Record<string, unknown>;
	request: Record<string, unknown>;
	impact: ImpactQuantity[];
	blocks: PreviewBlock[];
	preconditions: Record<string, unknown>;
	allowances: Array<Record<string, unknown>>;
	evidenceObservedAt: string;
	expiresAt: string;
	expired: boolean;
	bindingDigest: string;
	supersedes: string | null;
	effectId: string | null;
	createdAt: string;
}

export interface Effect {
	id: string;
	invocationId: string;
	operationKey: string;
	environmentId: string;
	action: { name: string; versionId: string };
	adapter: { type: string; version: string };
	stage: EffectStage;
	outcome: EffectOutcome;
	partialEffect: PartialEffect;
	grade: EffectGrade;
	verification: EffectVerification;
	providerReference: string | null;
	target: Record<string, unknown>;
	impact: ImpactQuantity[];
	previewId: string | null;
	approvalId: string | null;
	bindingDigest: string | null;
	dependsOn: Array<{ effectId: string; outcome: string }>;
	compensates: string | null;
	rejectionReason: string | null;
	unresolvedExposure: boolean;
	reconciliation: {
		attempts: number;
		nextAt: string | null;
		exhausted: boolean;
	};
	endUserId?: string | null;
	createdAt: string;
	firstDispatchedAt: string | null;
	outcomeAt: string | null;
	updatedAt: string;
}

export interface EffectEvidence {
	id: string;
	source:
		| "preview"
		| "provider_response"
		| "provider_lookup"
		| "system"
		| "operator_note"
		| "manual_resolution";
	observedAt: string;
	impliedOutcome: string | null;
	providerIds: Record<string, string>;
	summary: string;
	details: Record<string, unknown>;
	actor: { type: string; id: string | null };
	recordedAt: string;
}

export interface EffectDetail extends Effect {
	request: Record<string, unknown>;
	capabilities: Record<string, unknown>;
	attempts: Array<{
		number: number;
		kind: "dispatch" | "replay" | "reconcile";
		status: "started" | "completed" | "abandoned";
		observedOutcome: string | null;
		error: string | null;
		startedAt: string;
		finishedAt: string | null;
	}>;
	evidence: EffectEvidence[];
	reservations: Array<{
		limitId: string;
		name: string;
		dimension: string;
		currency: string | null;
		period: string;
		amount: number;
		state: "reserved" | "settled" | "released";
		exposure: string | null;
		settled: number;
		released: number;
	}>;
	preview: ActionPreview | null;
}

export interface ImpactLimit {
	id: string;
	name: string;
	dimension: string;
	currency: string | null;
	unit: string;
	scope: {
		environmentId: string;
		actionName: string | null;
		resourcePrefix: string | null;
		kind?: ImpactLimitSubject;
	};
	period: "day" | "month" | "total";
	limit: number;
	currentPeriod: string;
	consumed: number;
	reserved: number;
	unknownExposure: number;
	available: number;
	archived: boolean;
	createdAt: string;
	updatedAt: string;
}

export type ImpactLimitSubject = "environment" | "end_user";

export interface ConnectionKeyAuth {
	instructions: string;
	instructionsUrl: string;
	fields?: ConnectionField[];
}

export type ConnectionIntegrationAuth =
	| { kind: "oauth"; apiKey?: ConnectionKeyAuth }
	| ({ kind: "api_key" } & ConnectionKeyAuth);

export function connectionKeyAuth(
	integration: { auth?: ConnectionIntegrationAuth } | null | undefined,
): ConnectionKeyAuth | null {
	const auth = integration?.auth;
	if (!auth) return null;
	return auth.kind === "api_key" ? auth : (auth.apiKey ?? null);
}

export interface ConnectionField {
	name: string;
	label: string;
	secret: boolean;
	kind: "account" | "credential";
	hint?: string;
}

export interface ConnectionIntegration {
	id: string;
	name: string;
	auth?: ConnectionIntegrationAuth;
	hosts: string[] | null;
	hostsFromAccount: boolean;
	hostTemplate?: string;
	scopes: string[];
	operationsPack: string | null;
	workflowPacks: string[];
}

export interface ConnectSession {
	sessionId: string;
	sessionToken: string;
	expiresAt: string;
	connectUrl: string;
	integration: ConnectionIntegration;
}

export type ConnectSessionCompletion =
	| { status: "pending"; secret: null }
	| { status: "completed"; secret: Secret };

export type ConnectionReconnect =
	| { status: "completed"; secret: Secret; session: null }
	| { status: "pending"; secret: null; session: ConnectSession };

export type EndUserConnectionStatus = "active" | "needs_reconnect" | "revoked";

export interface EndUser {
	endUserId: string;
	connections: number;
	invocations: number;
	pendingApprovals: number;
}

export interface EndUserConnection {
	integration: string;
	kind?: "oauth" | "api_key";
	status: EndUserConnectionStatus;
	scopes: string[];
	connectedAt: string;
	updatedAt: string;
	lastUsedAt?: string | null;
}

export type SignInApp = "own" | "anlyon" | "own_required" | "unavailable";

export interface IntegrationRoute {
	kind: "integration" | "mcp" | "openapi" | "mcp_address" | "custom_action";
	why: string;
	next: { summary: string; command?: string; url?: string; docs?: string };
	integration?: { id: string; connect: "sign_in" | "api_key" };
	mcp?: {
		registryName: string;
		url: string;
		host: string;
		publisher: { verifiedBy: "domain" | "github"; namespace: string };
		report: string;
	};
}

export interface IntegrationRouteResult {
	query: string;
	name: string;
	route: IntegrationRoute;
	alternatives: IntegrationRoute[];
	tellUs: string;
}

export interface IntegrationOverview extends ConnectionIntegration {
	connectable: boolean;
	signIn: { app: SignInApp; redirectUri: string } | null;
	workspace: { connected: number; needsAttention: number };
	endUsers: { connected: number; needsReconnect: number };
}

export interface EndUserConnectLink {
	url: string;
	expiresAt: string;
	integration: string;
}

export interface EndUserPage {
	data: EndUser[];
	pagination: { nextCursor: string | null };
}

export interface EnvironmentOAuthApp {
	integration: string;
	configured: boolean;
	clientId: string | null;
	redirectUri: string;
	updatedAt: string | null;
}

export type FunctionLanguage = "javascript" | "python";

export interface FunctionBudgets {
	maxActionCalls: number;
	maxCpuMs: number;
	maxSubrequests: number;
	timeoutMs: number;
}

export type FunctionBudgetName = keyof FunctionBudgets;

export interface FunctionStraightThroughPolicy {
	actions: string[];
	maxWrites: number;
}

export interface FunctionSourceFindings {
	language: FunctionLanguage;
	parsed: boolean;
	parseError: string | null;
	calls: Array<{ kind: "invoke" | "read"; action: string; line: number }>;
	proposedAllowedActions: string[];
	computedActionNames: Array<{ kind: "invoke" | "read"; line: number }>;
	risky: Array<{
		api: string;
		category: "network" | "file" | "process" | "environment" | "eval";
		line: number;
	}>;
	writesInLoop: Array<{ action: string | null; line: number }>;
}

export type FunctionRiskTier =
	| "routine"
	| "low"
	| "moderate"
	| "high"
	| "critical";

export interface FunctionAiReview {
	status: "reviewed" | "skipped" | "failed";
	reason: string | null;
	model: string | null;
	summary: string | null;
	purpose:
		| "refunds"
		| "payments"
		| "messages"
		| "records"
		| "accounts"
		| "lookups"
		| "other"
		| null;
	riskyPatterns: Array<{
		pattern:
			| "writes_in_loop"
			| "money_per_item"
			| "amount_from_input"
			| "unchecked_write";
		description: string;
		probability: number;
	}>;
	suggestedRiskTier: FunctionRiskTier | null;
	confidence: number | null;
	truncated: boolean;
	reviewedAt: string;
}

export interface FunctionVersionReview {
	ast: FunctionSourceFindings;
	ai: FunctionAiReview | null;
}

export interface FunctionVersion {
	id: string;
	version: number;
	language: FunctionLanguage;
	digest: string;
	allowedActions: string[];
	inputSchema: Record<string, unknown>;
	budgets: FunctionBudgets;
	straightThrough: FunctionStraightThroughPolicy | null;
	review: FunctionVersionReview | null;
	createdAt: string;
}

export interface FunctionVersionListItem extends FunctionVersion {
	current: boolean;
}

export interface FunctionVersionDetail extends FunctionVersionListItem {
	source: string;
}

export interface HostedFunction {
	id: string;
	name: string;
	description: string | null;
	environmentId: string;
	currentVersion: FunctionVersion | null;
	createdAt: string;
	updatedAt: string;
}

export type FunctionRunMode = "straight_through" | "plan" | "apply";

export type FunctionRunStatus =
	| "running"
	| "succeeded"
	| "failed"
	| "budget_exceeded"
	| "planned"
	| "awaiting_approval"
	| "diverged";

export type FunctionCallState = "intent" | "dispatched" | "refused" | "failed";

export interface FunctionRunCall {
	sequence: number;
	action: string;
	kind: "read" | "write";
	state: FunctionCallState;
	invocationId: string | null;
	refusal: string | null;
	plannedSequence: number | null;
	createdAt?: string;
}

export interface FunctionRunPlan {
	digest: string;
	writes: Array<{ sequence: number; action: string; input: unknown }>;
	approval: {
		id: string;
		status: ApprovalStatus;
		decider: "team" | "end_user";
	} | null;
	appliedByRunId: string | null;
}

export interface FunctionRunReceipt {
	functionId: string;
	functionVersionId: string;
	digest: string;
	inputDigest: string;
	mode: FunctionRunMode;
	planDigest: string | null;
	approvalId: string | null;
	planRunId: string | null;
	calls: FunctionRunCall[];
	outcome: Exclude<FunctionRunStatus, "running">;
	budget: FunctionBudgetName | null;
	finishedAt: string;
}

export interface FunctionRunListItem {
	id: string;
	functionVersionId: string;
	version: number;
	mode: FunctionRunMode;
	status: FunctionRunStatus;
	endUserId: string | null;
	actionCalls: number;
	budget: FunctionBudgetName | null;
	error: { code: string; message: string } | null;
	approvalId: string | null;
	durationMs: number | null;
	createdAt: string;
	finishedAt: string | null;
}

export interface FunctionRun {
	id: string;
	functionId: string;
	functionName: string;
	functionVersionId: string;
	mode: FunctionRunMode;
	status: FunctionRunStatus;
	endUserId: string | null;
	input: Record<string, unknown>;
	inputDigest: string;
	output: unknown;
	error: { code: string; message: string } | null;
	logs: string[];
	budget: FunctionBudgetName | null;
	actionCalls: number;
	calls: FunctionRunCall[];
	plan: FunctionRunPlan | null;
	planRunId: string | null;
	planDigest: string | null;
	approvalId: string | null;
	receipt: FunctionRunReceipt | null;
	durationMs: number | null;
	createdAt: string;
	finishedAt: string | null;
}
