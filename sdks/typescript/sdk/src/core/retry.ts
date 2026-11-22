/**
 * Retry logic with exponential backoff for Anlyon Scheduler SDK
 */

import type { RetryConfig } from '../types/config';
import { AnlyonError, RateLimitError } from './errors';
import { ERROR_CODES } from '../types/errors';

const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxAttempts: 3,
  initialDelay: 100,
  maxDelay: 10000,
  backoffMultiplier: 2,
  jitter: true,
  retryableStatusCodes: [429, 500, 502, 503, 504],
  isRetryable: () => true,
};

export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  delay: number;
  error: Error;
}

export type RetryCallback = (context: RetryContext) => void;

/**
 * Handler for retry logic with exponential backoff
 */
export class RetryHandler {
  private readonly config: Required<RetryConfig>;
  private onRetry?: RetryCallback;

  constructor(config?: RetryConfig) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * Set callback to be called before each retry
   */
  setOnRetry(callback: RetryCallback): void {
    this.onRetry = callback;
  }

  /**
   * Execute a function with retry logic
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    let delay = this.config.initialDelay;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.shouldRetry(error, attempt)) {
          throw lastError;
        }

        const retryAfterMs = this.getRetryAfterMs(error);
        const actualDelay = retryAfterMs ?? this.calculateDelay(delay);

        this.onRetry?.({
          attempt,
          maxAttempts: this.config.maxAttempts,
          delay: actualDelay,
          error: lastError,
        });

        await this.sleep(actualDelay);

        if (!retryAfterMs) {
          delay = Math.min(
            delay * this.config.backoffMultiplier,
            this.config.maxDelay
          );
        }
      }
    }

    throw lastError ?? new Error('Retry failed with no error');
  }

  private shouldRetry(error: unknown, attempt: number): boolean {
    if (attempt >= this.config.maxAttempts) {
      return false;
    }

    if (!this.config.isRetryable(error)) {
      return false;
    }

    if (error instanceof AnlyonError) {
      if (
        error.status &&
        this.config.retryableStatusCodes.includes(error.status)
      ) {
        return true;
      }

      if (
        error.code === ERROR_CODES.NETWORK_ERROR ||
        error.code === ERROR_CODES.TIMEOUT_ERROR
      ) {
        return true;
      }

      return false;
    }

    if (error instanceof TypeError && error.message.includes('fetch')) {
      return true;
    }

    return false;
  }

  private getRetryAfterMs(error: unknown): number | undefined {
    if (error instanceof RateLimitError && error.retryAfter) {
      return error.retryAfter * 1000;
    }
    return undefined;
  }

  private calculateDelay(baseDelay: number): number {
    if (!this.config.jitter) {
      return baseDelay;
    }

    return Math.floor(Math.random() * baseDelay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Convenience function for one-off retry operations
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: RetryConfig
): Promise<T> {
  const handler = new RetryHandler(config);
  return handler.execute(fn);
}
