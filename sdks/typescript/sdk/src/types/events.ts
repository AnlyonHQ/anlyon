/**
 * Events primitive types for the Anlyon SDK.
 */

export type EventStatus = 'received' | 'fanned_out' | 'no_subscribers';

export interface PublishEventRequest {
  /** Topic name or public id (top_xxx). */
  topic: string;
  /** Dot-segmented event type (e.g. "order.created"). */
  type: string;
  /** Arbitrary event payload. */
  data?: Record<string, unknown>;
  /** Idempotency key  replay returns the original event with deduplicated: true. */
  idempotencyKey?: string;
  /** Existing Anlyon run that receives event-delivery spans. */
  runId?: string;
  /** Optional parent span within runId. */
  parentSpanId?: string;
}

export interface PublishEventResult {
  /** Public event id (evt_xxx). */
  id: string;
  status: EventStatus | string;
  /** Present when the publish was a no-op due to idempotencyKey. */
  deduplicated?: boolean;
}

export interface Event {
  /** Public event id (evt_xxx). */
  id: string;
  /** Topic name. */
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

export interface EventWithDeliveries extends Event {
  deliveries: EventDelivery[];
}

export interface ListEventsParams {
  topic?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

export interface CreateTopicRequest {
  name: string;
  description?: string;
}

export interface UpdateTopicRequest {
  name?: string;
  description?: string;
}

export interface Topic {
  /** Public topic id (top_xxx). */
  id: string;
  name: string;
  description: string | null;
  isReserved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSubscriptionRequest {
  /** Webhook URL to deliver matching events to. */
  url: string;
  /** Event type patterns ("*", "order.*", or exact types). Defaults to ["*"]. */
  eventTypes?: string[];
  /** Whether the subscription is active (default true). */
  enabled?: boolean;
  /**
   * When true, generates a per-subscription signing secret.
   * The plaintext secret is returned exactly once on create.
   */
  generateSecret?: boolean;
  /** Extra headers to attach on delivery. */
  headers?: Record<string, string>;
}

export interface UpdateSubscriptionRequest {
  url?: string;
  eventTypes?: string[];
  enabled?: boolean;
  /** Pass null to clear custom headers. */
  headers?: Record<string, string> | null;
}

export interface Subscription {
  /** Public subscription id (sub_xxx). */
  id: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  hasCustomSecret: boolean;
  headers: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Plaintext signing secret  present only on create/rotate when a secret
   * was generated. Never stored server-side in plaintext after the response.
   */
  secret?: string;
}

export interface RotateSecretResult {
  id: string;
  secret: string;
}
