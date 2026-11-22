/**
 * Base resource class for Anlyon Scheduler SDK
 */

import type { HttpClient } from '../core/http-client';
import type { ApiResponse, IdempotentRequestOptions, PaginatedResponse } from '../types/api';
import { generateIdempotencyKey } from '../core/idempotency';

export type { IdempotentRequestOptions };

/**
 * Base class that all resource clients inherit from
 */
export abstract class BaseResource {
  protected readonly basePath: string;
  protected readonly http: HttpClient;

  constructor(http: HttpClient, basePath: string) {
    this.http = http;
    this.basePath = basePath;
  }

  /**
   * Build the full path for a request
   */
  protected buildPath(path: string = ''): string {
    if (!path) return this.basePath;
    return `${this.basePath}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /**
   * Make a GET request
   */
  protected async _get<T>(
    path: string = '',
    params?: Record<string, unknown>,
    options?: { timeout?: number; headers?: Record<string, string>; endUserId?: string }
  ): Promise<ApiResponse<T>> {
    return this.http.get<ApiResponse<T>>(this.buildPath(path), { ...options, params });
  }

  /**
   * Make a POST request
   */
  protected async _post<T, B = unknown>(
    path: string = '',
    body?: B,
    options?: { headers?: Record<string, string>; endUserId?: string }
  ): Promise<ApiResponse<T>> {
    return this.http.post<ApiResponse<T>>(this.buildPath(path), body, options);
  }

  /**
   * Make a PUT request
   */
  protected async _put<T, B = unknown>(
    path: string = '',
    body?: B,
    options?: { headers?: Record<string, string>; endUserId?: string }
  ): Promise<ApiResponse<T>> {
    return this.http.put<ApiResponse<T>>(this.buildPath(path), body, options);
  }

  /**
   * Make a PATCH request
   */
  protected async _patch<T, B = unknown>(
    path: string = '',
    body?: B,
    options?: { headers?: Record<string, string>; endUserId?: string }
  ): Promise<ApiResponse<T>> {
    return this.http.patch<ApiResponse<T>>(this.buildPath(path), body, options);
  }

  /**
   * Make a DELETE request
   */
  protected async _delete<T>(
    path: string = '',
    options?: { headers?: Record<string, string>; endUserId?: string }
  ): Promise<ApiResponse<T>> {
    return this.http.delete<ApiResponse<T>>(this.buildPath(path), options);
  }

  /**
   * Translate an idempotency key into the header the API expects.
   */
  protected _idempotent(
    options?: IdempotentRequestOptions
  ): { headers: Record<string, string> } | undefined {
    return options?.idempotencyKey
      ? { headers: { 'Idempotency-Key': options.idempotencyKey } }
      : undefined;
  }

  /**
   * Always send an idempotency key. The caller's key is used as is. Without one, a key is
   * generated here, once per call and before the first attempt. The HTTP client builds its
   * headers once per call, so every transport retry of that call carries the same key and the
   * API answers a resend from the recorded result.
   */
  protected _idempotentAlways(
    options?: IdempotentRequestOptions
  ): { headers: Record<string, string> } {
    return { headers: { 'Idempotency-Key': options?.idempotencyKey || generateIdempotencyKey() } };
  }

  /**
   * Make a GET request for paginated data
   */
  protected async _getPaginated<T>(
    path: string = '',
    params?: Record<string, unknown>
  ): Promise<PaginatedResponse<T>> {
    return this.http.get<PaginatedResponse<T>>(this.buildPath(path), { params });
  }
}
