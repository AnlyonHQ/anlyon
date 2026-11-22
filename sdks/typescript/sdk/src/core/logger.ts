/**
 * Logging implementation for Anlyon Scheduler SDK
 */

import type { Logger, LoggingConfig, LogLevel } from '../types/config';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  meta?: Record<string, unknown>;
}

/**
 * Default logger implementation that logs to console
 */
export class DefaultLogger implements Logger {
  private readonly level: LogLevel;
  private readonly redactSensitive: boolean;
  private readonly sensitiveKeys = [
    'apikey',
    'api_key',
    'authorization',
    'x-api-key',
    'password',
    'secret',
    'token',
    'bearer',
  ];

  constructor(config?: LoggingConfig) {
    this.level = config?.level ?? 'info';
    this.redactSensitive = config?.redactSensitive ?? true;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }

  private log(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>
  ): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) {
      return;
    }

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      meta: meta ? this.redactMeta(meta) : undefined,
    };

    const formattedMeta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';
    const output = `[${entry.timestamp}] [AnlyonSDK] [${level.toUpperCase()}] ${message}${formattedMeta}`;

    switch (level) {
      case 'debug':
        console.debug(output);
        break;
      case 'info':
        console.info(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'error':
        console.error(output);
        break;
    }
  }

  private redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
    if (!this.redactSensitive) {
      return meta;
    }
    return this.redactObject(meta);
  }

  private redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (this.isSensitiveKey(key)) {
        result[key] = '[REDACTED]';
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.redactObject(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          item && typeof item === 'object'
            ? this.redactObject(item as Record<string, unknown>)
            : item
        );
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  private isSensitiveKey(key: string): boolean {
    const lowerKey = key.toLowerCase();
    return this.sensitiveKeys.some((sensitive) =>
      lowerKey.includes(sensitive.toLowerCase())
    );
  }
}

/**
 * No-op logger for when logging is disabled
 */
export class NoopLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

/**
 * Factory to create logger based on config
 */
export function createLogger(config?: LoggingConfig): Logger {
  if (!config?.enabled) {
    return new NoopLogger();
  }

  return config.logger ?? new DefaultLogger(config);
}
