import { createLogger } from "../lib/logger.ts";

export interface ErrorFix {
  summary: string;
  command?: string;
  url?: string;
  docs?: string;
}

export class ApiError extends Error {
  public fix?: ErrorFix;

  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = "ApiError";
  }

  toJSON() {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        ...(this.fix ? { fix: this.fix } : {}),
      },
    };
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, details?: any) {
    super(400, "VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

export class AuthenticationError extends ApiError {
  constructor(message: string = "Authentication required") {
    super(401, "AUTHENTICATION_ERROR", message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends ApiError {
  constructor(message: string = "Insufficient permissions") {
    super(403, "AUTHORIZATION_ERROR", message);
    this.name = "AuthorizationError";
  }
}

export class SelfApprovalError extends AuthorizationError {
  constructor(message: string) {
    super(message);
    this.code = "SELF_APPROVAL_NOT_ALLOWED";
    this.name = "SelfApprovalError";
  }
}

export class NotFoundError extends ApiError {
  constructor(resource: string = "Resource") {
    super(404, "NOT_FOUND", `${resource} not found`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends ApiError {
  constructor(message: string) {
    super(409, "CONFLICT", message);
    this.name = "ConflictError";
  }
}

export class DeliverySecretUnreadableError extends ApiError {
  constructor(workspaceId: string) {
    super(
      500,
      "DELIVERY_SECRET_UNREADABLE",
      "The workspace delivery secret could not be decrypted. Deliveries are not being signed. " +
        "This usually means DELIVERY_SECRET_MASTER_KEY changed; rotate the delivery secret to recover.",
      { workspaceId }
    );
    this.name = "DeliverySecretUnreadableError";
  }
}

export class RateLimitError extends ApiError {
  constructor(message: string = "Rate limit exceeded") {
    super(429, "RATE_LIMIT_EXCEEDED", message);
    this.name = "RateLimitError";
  }
}

export class QuotaExceededError extends ApiError {
  constructor(message: string = "Quota exceeded") {
    super(402, "QUOTA_EXCEEDED", message);
    this.name = "QuotaExceededError";
  }
}

export class InternalServerError extends ApiError {
  constructor(message: string = "Internal server error") {
    super(500, "INTERNAL_SERVER_ERROR", message);
    this.name = "InternalServerError";
  }
}

export class ServiceUnavailableError extends ApiError {
  constructor(message: string = "Service temporarily unavailable") {
    super(503, "SERVICE_UNAVAILABLE", message);
    this.name = "ServiceUnavailableError";
  }
}

export class EmbeddingProviderError extends ApiError {
  constructor(message: string = "Embedding provider is temporarily unavailable", details?: any) {
    super(503, "EMBEDDING_PROVIDER_UNAVAILABLE", message, details);
    this.name = "EmbeddingProviderError";
  }
}

export class TopicNotFoundError extends ApiError {
  constructor(message: string = "Topic not found") {
    super(404, "TOPIC_NOT_FOUND", message);
    this.name = "TopicNotFoundError";
  }
}

export class EventNotFoundError extends ApiError {
  constructor(message: string = "Event not found") {
    super(404, "EVENT_NOT_FOUND", message);
    this.name = "EventNotFoundError";
  }
}

export class ReservedTopicError extends ApiError {
  constructor(message: string = "This topic is reserved for platform events") {
    super(403, "RESERVED_TOPIC", message);
    this.name = "ReservedTopicError";
  }
}

export class SubscriptionNotFoundError extends ApiError {
  constructor(message: string = "Subscription not found") {
    super(404, "SUBSCRIPTION_NOT_FOUND", message);
    this.name = "SubscriptionNotFoundError";
  }
}

export class SecretNotFoundError extends ApiError {
  constructor(message: string = "Secret not found") {
    super(404, "SECRET_NOT_FOUND", message);
    this.name = "SecretNotFoundError";
  }
}

export class ActionNotFoundError extends ApiError {
  constructor(message: string = "Action not found") {
    super(404, "ACTION_NOT_FOUND", message);
    this.name = "ActionNotFoundError";
  }
}

export class ActionDisabledError extends ApiError {
  constructor(message: string = "This action is disabled") {
    super(409, "ACTION_DISABLED", message);
    this.name = "ActionDisabledError";
  }
}

export class ActionVersionPinUnresolvedError extends ApiError {
  constructor(message: string) {
    super(409, "ACTION_VERSION_PIN_UNRESOLVED", message);
    this.name = "ActionVersionPinUnresolvedError";
  }
}

export class InvocationNotFoundError extends ApiError {
  constructor(message: string = "Invocation not found") {
    super(404, "INVOCATION_NOT_FOUND", message);
    this.name = "InvocationNotFoundError";
  }
}

export class ApprovalNotFoundError extends ApiError {
  constructor(message: string = "Approval not found") {
    super(404, "APPROVAL_NOT_FOUND", message);
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalAlreadyDecidedError extends ApiError {
  constructor(message: string = "This approval has already been decided") {
    super(409, "APPROVAL_ALREADY_DECIDED", message);
    this.name = "ApprovalAlreadyDecidedError";
  }
}

export class EnvironmentHaltedError extends ApiError {
  constructor(message = "Environment is halted: this operation is blocked until it is resumed.") {
    super(409, "ENVIRONMENT_HALTED", message);
    this.name = "EnvironmentHaltedError";
  }
}

export class BudgetExceededError extends ApiError {
  constructor(message: string = "API key budget exceeded") {
    super(429, "BUDGET_EXCEEDED", message);
    this.name = "BudgetExceededError";
  }
}

const errorLogger = createLogger({ module: "error-handler" });

export function handleError(error: unknown) {
  if (error instanceof ApiError) {
    return error.toJSON();
  }

  if (error instanceof Error) {
    errorLogger.error({ 
      error: error.message, 
      stack: error.stack,
      name: error.name 
    }, "Unexpected error");
    
    return new InternalServerError("An unexpected error occurred").toJSON();
  }

  errorLogger.error({ error }, "Unknown error type");
  return new InternalServerError("An unexpected error occurred").toJSON();
}

export class ConnectionsUnavailableError extends ApiError {
  constructor(message: string = "Connected accounts are not available on this deployment.") {
    super(501, "CONNECTIONS_UNAVAILABLE", message);
    this.name = "ConnectionsUnavailableError";
  }
}

export class ConnectionNeedsReauthError extends ApiError {
  constructor(secretName: string) {
    super(
      424,
      "CONNECTION_NEEDS_REAUTH",
      `Secret ${secretName} is a connected account that needs to be reconnected. Nothing was sent. Reconnect it under Connected accounts in the console.`,
      { secret: secretName },
    );
    this.name = "ConnectionNeedsReauthError";
  }
}

export class ConnectionProviderError extends ApiError {
  constructor(message: string = "The connected-account service did not answer. Nothing was sent. Try again shortly.") {
    super(502, "CONNECTION_PROVIDER_ERROR", message);
    this.name = "ConnectionProviderError";
  }
}

export class ConnectionKeyRejectedError extends ApiError {
  constructor(integrationName: string) {
    super(
      422,
      "CONNECTION_KEY_REJECTED",
      `${integrationName} did not accept that key. Nothing was saved. Check that you copied the whole key and that it has the permissions listed, then try again.`,
    );
    this.name = "ConnectionKeyRejectedError";
  }
}

export class ConnectionKeyCheckFailedError extends ApiError {
  constructor(integrationName: string) {
    super(
      502,
      "CONNECTION_KEY_CHECK_FAILED",
      `The key could not be checked with ${integrationName} just now. Nothing was saved. Try again shortly.`,
    );
    this.name = "ConnectionKeyCheckFailedError";
  }
}

export class ConnectionSessionExpiredError extends ApiError {
  constructor(message: string = "This connect session has expired or does not belong to this environment. Start a new one.") {
    super(410, "CONNECTION_SESSION_EXPIRED", message);
    this.name = "ConnectionSessionExpiredError";
  }
}

export class SecretKindMismatchError extends ApiError {
  constructor(name: string, existing: "static" | "connection" | "external") {
    super(
      409,
      "SECRET_KIND_MISMATCH",
      existing === "connection"
        ? `Secret ${name} is a connected account and cannot be given a stored value. Delete it first, then create it again.`
        : existing === "external"
          ? `Secret ${name} is read from a secret store and cannot be changed into another kind. Delete it first, then create it again.`
          : `Secret ${name} holds a stored value and cannot be changed into another kind. Delete it first, then create it again.`,
      { secret: name, kind: existing },
    );
    this.name = "SecretKindMismatchError";
  }
}

export class ConnectionRevokeFailedError extends ApiError {
  constructor(name: string) {
    super(
      502,
      "CONNECTION_REVOKE_FAILED",
      `The connected account behind ${name} could not be revoked, so the secret was kept. Its access may still be live. Try again, or revoke access in the provider's own settings.`,
      { secret: name },
    );
    this.name = "ConnectionRevokeFailedError";
  }
}

export class SecretStoresUnavailableError extends ApiError {
  constructor(message: string = "Secret stores are not part of this edition. Nothing was sent.") {
    super(501, "SECRET_STORES_UNAVAILABLE", message);
    this.name = "SecretStoresUnavailableError";
  }
}

export class SecretStoreNotFoundError extends ApiError {
  constructor(name: string) {
    super(404, "SECRET_STORE_NOT_FOUND", `Secret store not found: ${name}`, { store: name });
    this.name = "SecretStoreNotFoundError";
  }
}

export class SecretStoreInUseError extends ApiError {
  constructor(name: string, secrets: string[]) {
    super(
      409,
      "SECRET_STORE_IN_USE",
      `Secret store ${name} is used by ${secrets.length === 1 ? "secret" : "secrets"} ${secrets.join(", ")}. Delete or repoint ${secrets.length === 1 ? "it" : "them"} first.`,
      { store: name, secrets },
    );
    this.name = "SecretStoreInUseError";
  }
}

type StoreFailureReason = "store_unreachable" | "store_denied" | "reference_not_found";

function storeFailureText(reason: StoreFailureReason): string {
  switch (reason) {
    case "store_denied":
      return "the store refused Anlyon's credential for it. Check the store's credential and its access policy";
    case "reference_not_found":
      return "the store has no secret at that path, version or key";
    default:
      return "the store did not answer. Try again shortly";
  }
}

export class SecretStoreCheckFailedError extends ApiError {
  constructor(store: string, reason: StoreFailureReason, subject = "The store") {
    super(
      reason === "store_unreachable" ? 502 : 422,
      "SECRET_STORE_CHECK_FAILED",
      `${subject} could not be read through secret store ${store}: ${storeFailureText(reason)}. Nothing was saved.`,
      { store, reason },
    );
    this.name = "SecretStoreCheckFailedError";
  }
}

export class ExternalSecretUnavailableError extends ApiError {
  constructor(secretName: string, store: string, reason: StoreFailureReason) {
    super(
      424,
      "EXTERNAL_SECRET_UNAVAILABLE",
      `Secret ${secretName} could not be read from secret store ${store}: ${storeFailureText(reason)}. Nothing was sent.`,
      { secret: secretName, store, reason },
    );
    this.name = "ExternalSecretUnavailableError";
  }
}
