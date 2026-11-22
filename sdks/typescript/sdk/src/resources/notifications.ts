/**
 * Notifications resource client for Anlyon Scheduler SDK
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type {
  ApiResponse,
  MyNotificationPreferences,
  NotificationListResponse,
  NotificationPreferences,
  UpdateMyNotificationPreferencesRequest,
  UpdateNotificationPreferencesRequest,
  SimpleMessage,
} from '../types/api';

export interface ListNotificationsParams {
  /** Filter to only unread notifications */
  unreadOnly?: boolean;
  /** Number of notifications to return (1-100, default: 50) */
  limit?: number;
}

export interface TestWebhookRequest {
  webhookUrl: string;
  webhookSecret?: string;
}

/**
 * Client for managing notifications and preferences
 */
export class NotificationsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/notifications');
  }

  /**
   * List notifications
   *
   * @example
   * ```typescript
   * const result = await client.notifications.list({ unreadOnly: true });
   *
   * console.log(`${result.data?.unreadCount} unread notifications`);
   * result.data?.notifications.forEach(n => {
   *   console.log(`[${n.priority}] ${n.title}: ${n.message}`);
   * });
   * ```
   */
  async list(
    params?: ListNotificationsParams
  ): Promise<ApiResponse<NotificationListResponse>> {
    return this._get<NotificationListResponse>('', params as Record<string, unknown>);
  }

  /**
   * Mark a notification as read
   *
   * @example
   * ```typescript
   * await client.notifications.markAsRead('notification-id');
   * ```
   */
  async markAsRead(notificationId: string): Promise<ApiResponse<SimpleMessage>> {
    return this._patch<SimpleMessage>(`/${notificationId}/read`);
  }

  /**
   * Mark all notifications as read
   *
   * @example
   * ```typescript
   * await client.notifications.markAllAsRead();
   * ```
   */
  async markAllAsRead(): Promise<ApiResponse<SimpleMessage>> {
    return this._patch<SimpleMessage>('/read-all');
  }

  /** Permanently delete a notification from the current workspace. */
  async delete(notificationId: string): Promise<ApiResponse<SimpleMessage>> {
    return this._delete<SimpleMessage>(`/${notificationId}`);
  }

  /**
   * Get your own notification preferences
   *
   * Needs a user, so an OAuth connection. An API key has no user and the call
   * answers `403` `USER_IDENTITY_REQUIRED`. Scope: `notifications:read`.
   *
   * @example
   * ```typescript
   * const result = await client.notifications.getMyPreferences();
   *
   * console.log(result.data?.mutedTypes);
   * ```
   */
  async getMyPreferences(): Promise<ApiResponse<MyNotificationPreferences>> {
    return this._get<MyNotificationPreferences>('/preferences/me');
  }

  /**
   * Update your own notification preferences
   *
   * A muted type is left out of your own list and unread count. It is still
   * raised, still delivered to email, Slack, Discord and the webhook, and
   * still shown to every other member. Needs a user, so an OAuth connection.
   * Scope: `notifications:write`. No role is needed.
   *
   * @example
   * ```typescript
   * await client.notifications.updateMyPreferences({ mutedTypes: ['quota_warning'] });
   * ```
   */
  async updateMyPreferences(
    preferences: UpdateMyNotificationPreferencesRequest
  ): Promise<ApiResponse<MyNotificationPreferences>> {
    return this._patch<MyNotificationPreferences>('/preferences/me', preferences);
  }

  /**
   * Get the workspace's notification preferences
   *
   * @example
   * ```typescript
   * const result = await client.notifications.getPreferences();
   *
   * console.log(`Email notifications: ${result.data?.emailEnabled}`);
   * console.log(`Webhook URL: ${result.data?.webhookUrl || 'Not configured'}`);
   * ```
   */
  async getPreferences(): Promise<ApiResponse<NotificationPreferences>> {
    return this._get<NotificationPreferences>('/preferences');
  }

  /**
   * Update the workspace's notification preferences
   *
   * Scope: `notifications:manage`, which no key receives by default. An OAuth
   * connection also needs the admin role.
   *
   * @example
   * ```typescript
   * await client.notifications.updatePreferences({
   *   emailEnabled: true,
   *   webhookEnabled: true,
   *   webhookUrl: 'https://example.com/notifications',
   *   quotaAlertThresholds: [50, 75, 90, 100],
   * });
   * ```
   */
  async updatePreferences(
    preferences: UpdateNotificationPreferencesRequest
  ): Promise<ApiResponse<NotificationPreferences>> {
    return this._patch<NotificationPreferences>('/preferences', preferences);
  }

  /**
   * Get unread notification count
   *
   * @example
   * ```typescript
   * const result = await client.notifications.getUnreadCount();
   *
   * console.log(`You have ${result.data?.count} unread notifications`);
   * ```
   */
  async getUnreadCount(): Promise<ApiResponse<{ count: number }>> {
    return this._get<{ count: number }>('/unread-count');
  }

  /**
   * Send a test webhook notification
   *
   * Sends a test notification to the configured webhook URL
   * to verify the integration is working correctly.
   * Scope: `notifications:manage`, which no key receives by default.
   *
   * @example
   * ```typescript
   * const result = await client.notifications.testWebhook({
   *   webhookUrl: 'https://example.com/notifications',
   * });
   *
   * if (result.success) {
   *   console.log('Webhook test sent successfully!');
   * }
   * ```
   */
  async testWebhook(request: TestWebhookRequest): Promise<ApiResponse<SimpleMessage>> {
    return this._post<SimpleMessage>('/preferences/test-webhook', request);
  }
}
