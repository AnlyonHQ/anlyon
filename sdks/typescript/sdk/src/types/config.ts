/**
 * Configuration types for Anlyon Scheduler SDK
 */

export interface AnlyonClientConfig {
  /** API key for authentication (required) */
  apiKey: string;

  /** Base URL for the API (default: https://api.anlyon.com) */
  baseUrl?: string;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Retry configuration */
  retry?: RetryConfig;

  /** Logging configuration */
  logging?: LoggingConfig;

  /** Custom fetch implementation (for testing or custom environments) */
  fetch?: typeof fetch;

  /** Custom headers to include in all requests */
  defaultHeaders?: Record<string, string>;
}

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;

  /** Initial delay in milliseconds before first retry (default: 100) */
  initialDelay?: number;

  /** Maximum delay in milliseconds between retries (default: 10000) */
  maxDelay?: number;

  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;

  /** Whether to add jitter to delays (default: true) */
  jitter?: boolean;

  /** HTTP status codes that should trigger retry (default: [429, 500, 502, 503, 504]) */
  retryableStatusCodes?: number[];

  /** Custom function to determine if error is retryable */
  isRetryable?: (error: unknown) => boolean;
}

export interface LoggingConfig {
  /** Enable/disable logging (default: false) */
  enabled?: boolean;

  /** Log level (default: 'info') */
  level?: LogLevel;

  /** Custom logger implementation */
  logger?: Logger;

  /** Redact sensitive data from logs (default: true) */
  redactSensitive?: boolean;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface RequestOptions {
  /** Query parameters */
  params?: Record<string, unknown>;
  /** Request body */
  body?: unknown;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Abort signal */
  signal?: AbortSignal;
  /** Request-specific timeout override */
  timeout?: number;
  /** Parse a successful response as JSON (default) or return its raw text. */
  responseType?: 'json' | 'text';
  /**
   * Send `Anlyon-End-User` with this one request. The end-user routes use it to name the end user
   * in the path. A client from `forUser()` refuses any other end user.
   */
  endUserId?: string;
}
