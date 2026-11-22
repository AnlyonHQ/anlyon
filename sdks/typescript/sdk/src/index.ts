/**
 * Anlyon TypeScript SDK
 *
 * Official TypeScript SDK for Anlyon. Your agent invokes a named action, and
 * Anlyon holds the credentials, evaluates policy, waits for approval when the
 * action requires it, and makes the production call.
 *
 * @packageDocumentation
 * @module @anlyonhq/sdk
 *
 * @example
 * ```typescript
 * import { Client } from '@anlyonhq/sdk';
 *
 * const client = new Client({
 *   apiKey: process.env.ANLYON_API_KEY!,
 * });
 *
 * // Invoke a hosted action by name. The agent never holds the credential.
 * const { data } = await client.actions.invoke('refund-customer', { charge: 'ch_1' });
 *
 * // A gated action waits for a person to decide.
 * if (data!.pendingApproval) {
 *   const decided = await client.approvals.waitForDecision(data!.approvalId!);
 *   console.log(decided.status);
 * }
 * ```
 */

export { Client, AnlyonScheduler } from './client';

export {
  Receiver,
  SignatureVerificationError,
  type ReceiverConfig,
  type VerifyRequest,
} from './receiver';

export type {
  AnlyonClientConfig,
  RetryConfig,
  LoggingConfig,
  LogLevel,
  Logger,
  RequestOptions,
} from './types/config';

export type {
  HttpMethod,
  MessageStatus,
  TimeGranularity,
  Message,
  Pagination,
  ApiError,
  ApiResponse,
  IdempotentRequestOptions,
  PaginatedResponse,
  SimpleMessage,
  DLQRetryResult,
  MyNotificationPreferences,
  UpdateMyNotificationPreferencesRequest,
  DLQRetryAllResult,
  DLQClearResult,
  MessageAnalytics,
  TimeSeriesDataPoint,
  TopUrlEntry,
  CurrentUsage,
  UsageHistoryEntry,
  ErrorDistribution,
} from './types/api';

export type {
  EventStatus,
  PublishEventRequest,
  PublishEventResult,
  Event,
  EventDelivery,
  EventWithDeliveries,
  ListEventsParams,
  CreateTopicRequest,
  UpdateTopicRequest,
  Topic,
  CreateSubscriptionRequest,
  UpdateSubscriptionRequest,
  Subscription,
  RotateSecretResult,
} from './types/events';

export type {
  Secret,
  SecretConnection,
  SecretHealth,
  PutSecretRequest,
  SecretExternal,
  SecretStoreType,
  ExternalSecretReference,
  PutExternalSecretRequest,
  ExternalSecretWarning,
  SecretStore,
  AwsSecretStoreConfig,
  VaultSecretStoreConfig,
  AwsSecretStoreCredential,
  VaultSecretStoreCredential,
  CreateSecretStoreRequest,
  UpdateSecretStoreRequest,
  ActionMethod,
  InvocationStatus,
  Action,
  CreateActionRequest,
  CreateAdapterActionRequest,
  UpdateActionRequest,
  Invocation,
  InvokeResult,
  InvocationResolution,
  ResolveInvocationInput,
  ListInvocationsParams,
  ActingFor,
  ApprovalDecider,
  ApprovalKind,
  ApprovalStatus,
  Approval,
  CreateApprovalRequest,
  DecideApprovalRequest,
  DecisionResult,
  ListApprovalsParams,
  InvocationDecision,
  DecisionSource,
  DecisionCode,
  PolicyMatchKind,
  PolicyEffect,
  PolicyScope,
  ApprovalPolicy,
  CreateApprovalPolicyRequest,
  UpdateApprovalPolicyRequest,
  CredentialIdentity,
  WorkspaceRole,
  WaitForDecisionOptions,
  GateOptions,
  BudgetDimension,
  Budget,
  PutBudgetRequest,
  ApprovalPolicyVersionPage,
  ListPolicyVersionsParams,
  ApprovalPolicyVersion,
  PolicyFileChange,
  PolicyFilePlan,
  PolicyFileTestCase,
  PolicyFileTestResult,
  ImportActionsOptions,
  ImportActionsResult,
  ImportedAction,
  ImportOperationChoice,
  ImportRisk,
  ImportSuggestion,
  ProposedVerify,
  SkippedOperation,
} from './types/agent';

export type { ErrorCode, AnlyonErrorOptions, ErrorFix } from './types/errors';
export type {
  SignOffStatus,
  SignOffOperation,
  SignOffChange,
  SignOffRequest,
  SignOffRequiredResponse,
  ListSignOffsParams,
  WaitForSignOffOptions,
} from './types/sign-offs';
export { SIGN_OFF_STATUSES } from './types/sign-offs';
export type {
  AdoptedMcpTool,
  McpAdoptResult,
  McpToolChoice,
  McpToolClass,
  McpToolSnapshot,
  McpUpstream,
  McpUpstreamConnectLink,
  McpUpstreamInspection,
  McpUpstreamOAuth,
  RegisterMcpUpstreamRequest,
} from './types/mcp-upstreams';
export { ERROR_CODES } from './types/errors';

export {
  AnlyonError,
  AuthenticationError,
  RateLimitError,
  QuotaExceededError,
  ValidationError,
  NotFoundError,
  FeatureNotAvailableError,
  NetworkError,
  TimeoutError,
  ApprovalDeniedError,
  ApprovalPendingError,
  SignOffRequiredError,
  isSignOffRequiredBody,
  parseErrorFix,
  ScopeCheckError,
  EndUserConnectionRequiredError,
  EndUserNotConnectedError,
  EndUserReconnectRequiredError,
  EndUserRequiredError,
  EndUserMismatchError,
  RedirectUrlRequiredError,
  type EndUserConnectDetails,
  createErrorFromResponse,
} from './core/errors';

export {
  END_USER_HEADER,
  END_USER_ID_PATTERN,
  isValidEndUserId,
  parseConnectRedirect,
  type ConnectRedirect,
  type ConnectRedirectStatus,
} from './core/end-user';
export {
  EndUsersResource,
  EndUserApprovalsResource,
  type EndUserConnection,
  type EndUserConnectionStatus,
  type CreateConnectLinkRequest,
  type EndUserConnectLink,
  type EndUserErasure,
  type ConfirmedEndUserConnection,
  type SetEndUserConnectionRequest,
  type EndUserSummary,
  type ListEndUsersParams,
  type EndUserPage,
  type ListEndUserApprovalsParams,
  type DecideEndUserApprovalRequest,
  type EndUserApprovalDecision,
  type CreateEndUserSessionOptions,
  type EndUserSession,
  type EndUserSessionCapability,
} from './resources/end-users';

export {
  FunctionsResource,
  FunctionRunsResource,
  type FunctionLanguage,
  type FunctionRunMode,
  type FunctionRunStatus,
  type FunctionBudgetName,
  type FunctionBudgets,
  type FunctionStraightThroughPolicy,
  type FunctionVersion,
  type HostedFunction,
  type CreateFunctionRequest,
  type PublishFunctionVersionRequest,
  type FunctionVersionPublished,
  type FunctionSourceFindings,
  type FunctionVersionReview,
  type RunFunctionRequest,
  type FunctionCallKind,
  type FunctionCallState,
  type FunctionRunCall,
  type FunctionRunPlan,
  type FunctionPlanApprovalPayload,
  type FunctionRunReceipt,
  type FunctionRun,
} from './resources/functions';

export { PaginationIterator } from './helpers/pagination';

export {
  verifyWebhookSignature,
  type WebhookVerificationResult,
} from './webhooks';

export { DlqResource, type ListDlqParams, type DlqStats } from './resources/dlq';
export {
  AnalyticsResource,
  type DateRangeParams,
  type TimeSeriesParams,
  type TopUrlsParams,
} from './resources/analytics';
export { EventsResource } from './resources/events';
export { RunsResource } from './resources/runs';
export { SecretsResource } from './resources/secrets';
export { SecretStoresResource } from './resources/secret-stores';
export { ConnectionsResource } from './resources/connections';
export { PacksResource, PackError, validatePackManifest, packShortName, templateHost, planPack, installPack, expandPackRefs,
  expandPackRefsSync, renamePackSecrets, bindPackConnections, packConnectionRefs, filterPackActions, preparePackManifest, packActionKind, PACK_FORMAT, ADAPTER_HOSTS } from './resources/packs';
export type {
  PackManifest,
  PackSecret,
  PackParameter,
  PackAction,
  PackDeclaredAction,
  PackAdapterAction,
  PackPolicy,
  PackLimit,
  PackStep,
  PackStepKind,
  PackCredentialMode,
  PackStepOutcome,
  PackInstallResult,
  PackInstallOptions,
  PackErrorCode,
  PackTransport,
  PackActionRef,
} from './resources/packs';
export type {
  ConnectionIntegration,
  ConnectionIntegrationAuth,
  ConnectionField,
  ConnectWithApiKeyRequest,
  CreateConnectSessionRequest,
  ConnectSession,
  ConnectSessionCompletion,
  ReconnectConnectionRequest,
  ConnectionReconnect,
  IntegrationRoute,
  IntegrationRouteResult,
} from './resources/connections';
export { EnvironmentResource } from './resources/environment';
export { ActionsResource } from './resources/actions';
export { ApprovalsResource } from './resources/approvals';
export { BudgetsResource } from './resources/budgets';
export { ImpactLimitsResource } from './resources/impact-limits';
export { SignOffsResource } from './resources/sign-offs';
export { McpUpstreamsResource } from './resources/mcp-upstreams';
export {
  AuditResource,
  type AuditCategory,
  type AuditEvent,
  type AuditEventFilter,
  type AuditEventPage,
  type AuditExportDocument,
  type AuditSchema,
} from './resources/audit';
export type * from './types/effects';
export { ApprovalPoliciesResource } from './resources/approval-policies';
export { AuthResource } from './resources/auth';
export { BillingResource } from './resources/billing';
export { NotificationsResource, type ListNotificationsParams, type TestWebhookRequest } from './resources/notifications';
export { IntegrationsResource } from './resources/integrations';
export { LogsResource } from './resources/logs';
export * from './types/runs';
export * from './types/stream';
