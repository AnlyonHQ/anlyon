/**
 * HTTP client for Anlyon Scheduler SDK
 */

import type { AnlyonClientConfig, RequestOptions, Logger } from '../types/config';
import { RetryHandler } from './retry';
import { createLogger } from './logger';
import {
  AnlyonError,
  createErrorFromResponse,
  isSignOffRequiredBody,
  NetworkError,
  SignOffRequiredError,
  TimeoutError,
} from './errors';
import { ERROR_CODES } from '../types/errors';
import { END_USER_HEADER, assertEndUserId, namesEndUser } from './end-user';

/** Parse one SSE message block (lines separated by \n) into id/event/data. */
function parseSseMessage(chunk: string): { id?: string; event?: string; data: string } | null {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && !event) return null;
  return { id, event, data: dataLines.join('\n') };
}

/**
 * 409 `idempotency_request_in_progress`: the original request is still running. Only a call with
 * the same key reaches it, and a key the SDK generated is otherwise invisible to the caller. Name
 * the key in the message and in `details.idempotencyKey`.
 */
function nameIdempotencyKey(error: AnlyonError, key: string | null): AnlyonError {
  if (!key || error.status !== 409 || (error.code as string) !== 'idempotency_request_in_progress') return error;
  return new AnlyonError({
    code: error.code,
    status: error.status,
    requestId: error.requestId,
    retryAfter: error.retryAfter,
    message:
      `The original request is still running and this call did not start a second one. Its Idempotency-Key is ${key}. ` +
      'Call again with that idempotencyKey to get the result of the original. A call without it is a new request.',
    details: { idempotencyKey: key },
  });
}

/**
 * Low-level HTTP client with retry, logging, and error handling
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly fetchFn: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly retryHandler: RetryHandler;
  private readonly logger: Logger;
  private readonly config: AnlyonClientConfig;
  /** The end user every request acts for. Set once, here, and never changed. */
  readonly #endUserId: string | undefined;

  /**
   * @param endUserId - Bind every request to this end user. Use {@link HttpClient.forEndUser}
   *   rather than passing it here.
   */
  constructor(config: AnlyonClientConfig, endUserId?: string) {
    if (namesEndUser(config.defaultHeaders)) {
      throw new AnlyonError({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: `Do not set ${END_USER_HEADER} in defaultHeaders. Use client.forUser(endUserId), which validates the id and binds it for good.`,
      });
    }
    if (endUserId !== undefined) assertEndUserId(endUserId);
    this.config = config;
    this.#endUserId = endUserId;
    this.baseUrl = (config.baseUrl ?? 'https://api.anlyon.com').replace(
      /\/$/,
      ''
    );
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 30000;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.retryHandler = new RetryHandler(config.retry);
    this.logger = createLogger(config.logging);

    this.retryHandler.setOnRetry(({ attempt, maxAttempts, delay, error }) => {
      this.logger.warn(`Retrying request (attempt ${attempt}/${maxAttempts})`, {
        delay,
        errorMessage: error.message,
      });
    });
  }

  /** The end user every request from this client acts for, or undefined for a workspace client. */
  get endUserId(): string | undefined {
    return this.#endUserId;
  }

  /**
   * A new HTTP client with the same configuration whose every request carries `Anlyon-End-User`.
   * This client is unchanged.
   */
  forEndUser(endUserId: string): HttpClient {
    return new HttpClient(this.config, endUserId);
  }

  /**
   * Make an HTTP request
   */
  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = this.buildUrl(path, options.params);
    const isFormData =
      typeof FormData !== 'undefined' && options.body instanceof FormData;
    const headers = this.buildHeaders(options.headers, {
      omitContentType: isFormData,
      endUserId: options.endUserId,
    });

    this.logger.debug('Making request', {
      method,
      url: url.toString(),
    });

    return this.retryHandler.execute(async () => {
      const controller = new AbortController();
      const timeoutMs = options.timeout ?? this.timeout;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        let body: BodyInit | undefined;
        if (options.body !== undefined && options.body !== null) {
          body = isFormData
            ? (options.body as FormData)
            : JSON.stringify(options.body);
        }

        const response = await this.fetchFn(url.toString(), {
          method,
          headers,
          body,
          signal: options.signal ?? controller.signal,
        });

        clearTimeout(timeoutId);

        const requestId = response.headers.get('x-request-id') ?? undefined;
        const retryAfter = response.headers.get('retry-after');
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;

        this.logger.debug('Received response', {
          status: response.status,
          requestId,
        });

        if (!response.ok) {
          const errorBody = await this.parseResponseBody(response);
          const failure = createErrorFromResponse(
            response.status,
            errorBody as { error?: { code: string; message: string; details?: unknown; fix?: unknown } },
            requestId,
            retryAfterSeconds
          );
          throw nameIdempotencyKey(failure, headers.get('Idempotency-Key'));
        }

        const data = options.responseType === 'text'
          ? await response.text()
          : await this.parseResponseBody(response);
        if (response.status === 202 && isSignOffRequiredBody(data)) {
          throw new SignOffRequiredError(data.data, requestId);
        }
        if (requestId) attachRequestId(data, requestId);
        return data as T;
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new TimeoutError(
            `Request timeout after ${timeoutMs}ms`,
            timeoutMs
          );
        }

        if (
          error instanceof TypeError &&
          (error.message.includes('fetch') ||
            error.message.includes('network') ||
            error.message.includes('Failed to fetch'))
        ) {
          throw new NetworkError('Network error occurred', error);
        }

        if (error instanceof AnlyonError) {
          throw error;
        }

        throw new AnlyonError({
          code: ERROR_CODES.UNKNOWN_ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
          cause: error instanceof Error ? error : undefined,
        });
      }
    });
  }

  /**
   * Make a GET request
   */
  async get<T>(path: string, options?: Omit<RequestOptions, 'body'>): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  /**
   * Make a POST request
   */
  async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, { ...options, body });
  }

  /**
   * Make a PUT request
   */
  async put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, { ...options, body });
  }

  /**
   * Make a PATCH request
   */
  async patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, { ...options, body });
  }

  /**
   * Make a DELETE request
   */
  async delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  /**
   * Consume a Server-Sent Events endpoint as an async iterator, reconnecting
   * with Last-Event-ID so a dropped connection resumes without a gap. Stops when
   * `signal` aborts. Yields raw SSE messages; callers map them to typed events.
   */
  async *stream(
    path: string,
    options: { params?: Record<string, unknown>; signal?: AbortSignal; lastEventId?: string } = {}
  ): AsyncGenerator<{ id?: string; event?: string; data: string }> {
    let lastId = options.lastEventId;
    let backoff = 500;

    while (!options.signal?.aborted) {
      const url = this.buildUrl(path, options.params);
      const headers = this.buildHeaders(
        { Accept: 'text/event-stream', ...(lastId ? { 'Last-Event-ID': lastId } : {}) },
        { omitContentType: true }
      );

      let response: Response;
      try {
        response = await this.fetchFn(url.toString(), { method: 'GET', headers, signal: options.signal });
      } catch (error) {
        if (options.signal?.aborted) return;
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 10000);
        continue;
      }

      if (!response.ok || !response.body) {
        if (response.status === 401 || response.status === 403) {
          const body = await this.parseResponseBody(response);
          throw createErrorFromResponse(
            response.status,
            body as { error?: { code: string; message: string; details?: unknown } },
            undefined
          );
        }
        await response.body?.cancel().catch(() => {});
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 10000);
        continue;
      }

      backoff = 500;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const message = parseSseMessage(chunk);
            if (message) {
              if (message.id) lastId = message.id;
              if (message.event !== 'heartbeat' && message.event !== 'ready') yield message;
            }
          }
        }
      } catch (error) {
        if (options.signal?.aborted) return;
      } finally {
        reader.releaseLock();
      }
      if (options.signal?.aborted) return;
      await this.sleep(1000);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private buildUrl(path: string, params?: Record<string, unknown>): URL {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          if (value instanceof Date) {
            url.searchParams.set(key, value.toISOString());
          } else {
            url.searchParams.set(key, String(value));
          }
        }
      }
    }

    return url;
  }

  private buildHeaders(
    customHeaders?: Record<string, string>,
    options?: { omitContentType?: boolean; endUserId?: string }
  ): Headers {
    const headers = new Headers({
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.defaultHeaders,
      ...customHeaders,
    });

    headers.delete(END_USER_HEADER);
    const requested = options?.endUserId;
    if (requested !== undefined) assertEndUserId(requested);
    if (this.#endUserId !== undefined && requested !== undefined && requested !== this.#endUserId) {
      throw new AnlyonError({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'This client acts for a different end user. Use a client from forUser() for that end user.',
      });
    }
    const endUserId = this.#endUserId ?? requested;
    if (endUserId !== undefined) headers.set(END_USER_HEADER, endUserId);

    if (options?.omitContentType) {
      headers.delete('Content-Type');
    } else if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    return headers;
  }

  private async parseResponseBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get('content-type');

    if (contentType?.includes('application/json')) {
      try {
        return await response.json();
      } catch {
        return { success: false, error: { code: 'PARSE_ERROR', message: 'Failed to parse JSON response' } };
      }
    }

    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch {
      return {
        success: false,
        error: { code: 'PARSE_ERROR', message: text || 'Empty response' },
      };
    }
  }
}

/**
 * Give a successful JSON response the request id the API sent in `X-Request-Id`, for support and
 * logs, without changing what the body serializes to or compares equal to: the property is
 * non-enumerable. A body that names its own `requestId` keeps it.
 */
function attachRequestId(data: unknown, requestId: string): void {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.isFrozen(data)) return;
  if (Object.prototype.hasOwnProperty.call(data, 'requestId')) return;
  Object.defineProperty(data, 'requestId', { value: requestId, enumerable: false, configurable: true, writable: true });
}
