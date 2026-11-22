/**
 * Dead Letter Queue (DLQ) resource client for Anlyon Scheduler SDK
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type {
  Message,
  ApiResponse,
  PaginatedResponse,
  SimpleMessage,
  DLQRetryResult,
  DLQRetryAllResult,
  DLQClearResult,
} from '../types/api';
import { PaginationIterator } from '../helpers/pagination';

export interface ListDlqParams {
  /** Page number (default: 1) */
  page?: number;
  /** Items per page (default: 20, max: 100) */
  limit?: number;
}

export interface DlqStats {
  total: number;
  byErrorType: Record<string, number>;
  oldestMessageAt?: string;
  newestMessageAt?: string;
}

/**
 * Client for managing failed messages in the Dead Letter Queue
 */
export class DlqResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/dlq');
  }

  /**
   * List failed messages in the DLQ
   *
   * @example
   * ```typescript
   * const result = await client.dlq.list({ limit: 50 });
   *
   * result.data?.forEach(msg => {
   *   console.log(`${msg.messageId}: ${msg.lastError}`);
   * });
   * ```
   */
  async list(params?: ListDlqParams): Promise<PaginatedResponse<Message>> {
    return this._getPaginated<Message>('', params as Record<string, unknown>);
  }

  /**
   * Get an async iterator for paginating through all DLQ messages
   *
   * @example
   * ```typescript
   * for await (const message of client.dlq.listAll()) {
   *   console.log(message.messageId, message.lastError);
   * }
   * ```
   */
  listAll(params?: Omit<ListDlqParams, 'page'>): PaginationIterator<Message> {
    return new PaginationIterator<Message>(
      (page, limit) => this.list({ ...params, page, limit }),
      params?.limit ?? 20
    );
  }

  /**
   * Get DLQ statistics
   *
   * @example
   * ```typescript
   * const result = await client.dlq.getStats();
   *
   * console.log(`Total failed: ${result.data?.total}`);
   * console.log('By error type:', result.data?.byErrorType);
   * ```
   */
  async getStats(): Promise<ApiResponse<DlqStats>> {
    return this._get<DlqStats>('/stats');
  }

  /**
   * Get a specific failed message by ID
   *
   * @example
   * ```typescript
   * const result = await client.dlq.get('msg_1234567890abcdef');
   * ```
   */
  async get(messageId: string): Promise<ApiResponse<Message>> {
    return this._get<Message>(`/${messageId}`);
  }

  /**
   * Retry a failed message
   *
   * @example
   * ```typescript
   * const result = await client.dlq.retry('msg_1234567890abcdef');
   * ```
   */
  async retry(messageId: string): Promise<ApiResponse<DLQRetryResult>> {
    return this._post<DLQRetryResult>(`/${messageId}/retry`);
  }

  /**
   * Retry failed messages in this environment's DLQ, up to 1000 per call.
   *
   * Check `remaining` and call again to continue.
   *
   * @example
   * ```typescript
   * const result = await client.dlq.retryAll();
   * ```
   */
  async retryAll(): Promise<ApiResponse<DLQRetryAllResult>> {
    return this._post<DLQRetryAllResult>('/retry-all');
  }

  /**
   * Delete a message from the DLQ
   *
   * @example
   * ```typescript
   * await client.dlq.delete('msg_1234567890abcdef');
   * ```
   */
  async delete(messageId: string): Promise<ApiResponse<SimpleMessage>> {
    return this._delete<SimpleMessage>(`/${messageId}`);
  }

  /**
   * Permanently delete failed messages in this environment's DLQ, up to 1000
   * per call. Check `remaining` and call again to continue.
   *
   * @example
   * ```typescript
   * await client.dlq.clear();
   * ```
   */
  async clear(): Promise<ApiResponse<DLQClearResult>> {
    return this._delete<DLQClearResult>('');
  }
}
