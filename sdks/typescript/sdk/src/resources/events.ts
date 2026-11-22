/**
 * Events resource client for the Anlyon SDK.
 *
 * Pub/sub topics, webhook subscriptions, and event publish/read.
 * Follows the same response envelope convention as other resources
 * (returns ApiResponse<T> / PaginatedResponse<T>).
 */

import { BaseResource } from './base';
import type { IdempotentRequestOptions } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse, PaginatedResponse } from '../types/api';
import type {
  PublishEventRequest,
  PublishEventResult,
  Event,
  EventWithDeliveries,
  ListEventsParams,
  CreateTopicRequest,
  UpdateTopicRequest,
  Topic,
  CreateSubscriptionRequest,
  UpdateSubscriptionRequest,
  Subscription,
  RotateSecretResult,
} from '../types/events';

/**
 * Client for the Events primitive.
 */
export class EventsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/events');
  }

  /**
   * Publish an event to a topic. Fan-out is asynchronous (202).
   * Replays with the same idempotencyKey return the original event (200).
   *
   * @example
   * ```typescript
   * const { data } = await client.events.publish({
   *   topic: 'orders',
   *   type: 'order.created',
   *   data: { orderId: '123' },
   *   idempotencyKey: 'order-123-created',
   * });
   * ```
   */
  async publish(
    request: PublishEventRequest,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<PublishEventResult>> {
    return this._post<PublishEventResult>('', request, this._idempotent(options));
  }

  /**
   * List published events with optional topic/type filters.
   */
  async list(params?: ListEventsParams): Promise<PaginatedResponse<Event>> {
    return this._getPaginated<Event>('', params as Record<string, unknown>);
  }

  /**
   * Get a single event with per-subscription delivery statuses.
   */
  async get(eventId: string): Promise<ApiResponse<EventWithDeliveries>> {
    return this._get<EventWithDeliveries>(`/${eventId}`);
  }

  /**
   * Create a topic.
   */
  async createTopic(
    request: CreateTopicRequest,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<Topic>> {
    return this._post<Topic>('/topics', request, this._idempotent(options));
  }

  /**
   * List topics for the workspace.
   */
  async listTopics(): Promise<ApiResponse<Topic[]>> {
    return this._get<Topic[]>('/topics');
  }

  /**
   * Get a topic by public id (top_xxx) or name.
   */
  async getTopic(ref: string): Promise<ApiResponse<Topic>> {
    return this._get<Topic>(`/topics/${encodeURIComponent(ref)}`);
  }

  /**
   * Update a topic (name and/or description).
   * Reserved topics only allow description updates.
   */
  async updateTopic(
    ref: string,
    request: UpdateTopicRequest,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<Topic>> {
    return this._patch<Topic>(`/topics/${encodeURIComponent(ref)}`, request, this._idempotent(options));
  }

  /**
   * Delete a topic (cascades subscriptions + events). Reserved topics are blocked.
   */
  async deleteTopic(
    ref: string,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<{ deleted: boolean }>> {
    return this._delete<{ deleted: boolean }>(`/topics/${encodeURIComponent(ref)}`, this._idempotent(options));
  }

  /**
   * Create a webhook subscription on a topic.
   * When generateSecret is true, the plaintext secret is returned exactly once.
   *
   * @example
   * ```typescript
   * const { data } = await client.events.createSubscription('orders', {
   *   url: 'https://example.com/hooks/orders',
   *   eventTypes: ['order.*'],
   *   generateSecret: true,
   * });
   * console.log(data!.secret); // save immediately  not shown again
   * ```
   */
  async createSubscription(
    topicRef: string,
    request: CreateSubscriptionRequest,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<Subscription>> {
    return this._post<Subscription>(
      `/topics/${encodeURIComponent(topicRef)}/subscriptions`,
      request,
      this._idempotent(options)
    );
  }

  /**
   * List subscriptions for a topic.
   */
  async listSubscriptions(topicRef: string): Promise<ApiResponse<Subscription[]>> {
    return this._get<Subscription[]>(
      `/topics/${encodeURIComponent(topicRef)}/subscriptions`
    );
  }

  /**
   * Update a subscription.
   */
  async updateSubscription(
    subscriptionId: string,
    request: UpdateSubscriptionRequest,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<Subscription>> {
    return this._patch<Subscription>(`/subscriptions/${subscriptionId}`, request, this._idempotent(options));
  }

  /**
   * Delete a subscription.
   */
  async deleteSubscription(
    subscriptionId: string,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<{ deleted: boolean }>> {
    return this._delete<{ deleted: boolean }>(`/subscriptions/${subscriptionId}`, this._idempotent(options));
  }

  /**
   * Rotate a subscription's signing secret.
   * The new plaintext secret is returned exactly once.
   */
  async rotateSecret(
    subscriptionId: string,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<RotateSecretResult>> {
    return this._post<RotateSecretResult>(
      `/subscriptions/${subscriptionId}/rotate-secret`,
      undefined,
      this._idempotent(options)
    );
  }
}
