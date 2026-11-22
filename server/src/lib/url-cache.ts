import { createLogger } from "./logger.ts";

const logger = createLogger({ module: "url-cache" });

interface CachedValidation {
  valid: boolean;
  error?: string;
  resolvedIp?: string;
  expiresAt: number;
}

interface CachedParsedData {
  headers: Record<string, string>;
  body: any;
  expiresAt: number;
}

export class UrlValidationCache {
  private cache: Map<string, CachedValidation> = new Map();
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxSize: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    positiveTtlMs: number = 5000,
    negativeTtlMs: number = 60000,
    maxSize: number = 10000
  ) {
    this.positiveTtlMs = positiveTtlMs;
    this.negativeTtlMs = negativeTtlMs;
    this.maxSize = maxSize;
  }

  start(): void {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
  }

  get(url: string): CachedValidation | null {
    const cached = this.cache.get(url);
    if (!cached) return null;

    if (Date.now() > cached.expiresAt) {
      this.cache.delete(url);
      return null;
    }

    return cached;
  }

  set(url: string, valid: boolean, error?: string, resolvedIp?: string): void {
    if (valid) {
      this.cache.delete(url);
      return;
    }

    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(url, {
      valid,
      error,
      resolvedIp,
      expiresAt: Date.now() + this.negativeTtlMs,
    });
  }

  invalidate(url: string): void {
    this.cache.delete(url);
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [url, cached] of this.cache) {
      if (now > cached.expiresAt) {
        this.cache.delete(url);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned }, "URL cache cleanup completed");
    }
  }

  getStats(): { size: number; maxSize: number } {
    return { size: this.cache.size, maxSize: this.maxSize };
  }
}

export class MessageDataCache {
  private cache: Map<string, CachedParsedData> = new Map();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs: number = 300000, maxSize: number = 5000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  get(messageId: string): CachedParsedData | null {
    const cached = this.cache.get(messageId);
    if (!cached) return null;

    if (Date.now() > cached.expiresAt) {
      this.cache.delete(messageId);
      return null;
    }

    return cached;
  }

  set(messageId: string, headers: Record<string, string>, body: any): void {
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(messageId, {
      headers,
      body,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  remove(messageId: string): void {
    this.cache.delete(messageId);
  }

  clear(): void {
    this.cache.clear();
  }
}

export const urlValidationCache = new UrlValidationCache();
export const messageDataCache = new MessageDataCache();
