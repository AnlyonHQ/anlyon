import { redis, RedisKeys } from "./redis.ts";
import { createLogger } from "./logger.ts";
import { MetricsCollector } from "./metrics.ts";

const logger = createLogger({ module: "circuit-breaker" });

export const circuitBreakerMetrics = new MetricsCollector("circuit_breaker");

interface CircuitState {
  failures: number;
  lastFailure: number;
  lastUpdated: number;
  state: "closed" | "open" | "half-open";
  openUntil: number;
  successCount?: number;
}

interface CacheEntry {
  state: CircuitState;
  cachedAt: number;
}

const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT = 30000;
const SUCCESS_THRESHOLD = 2;
const LOCAL_CACHE_TTL_MS = 1000;

export class CircuitBreaker {
  private static localCache = new Map<string, CacheEntry>();
  private static metricsStarted = false;

  static startMetrics(): void {
    if (!this.metricsStarted) {
      circuitBreakerMetrics.start();
      this.metricsStarted = true;
    }
  }

  static async stopMetrics(): Promise<void> {
    if (this.metricsStarted) {
      await circuitBreakerMetrics.stop();
      this.metricsStarted = false;
    }
  }

  static async canRequest(url: string, scope?: string): Promise<{ allowed: boolean; reason?: string }> {
    const host = this.extractHost(url, scope);
    if (!host) {
      return { allowed: true };
    }

    const state = await this.getState(host);

    if (state.state === "open") {
      if (Date.now() >= state.openUntil) {
        await this.setState(host, { ...state, state: "half-open", successCount: 0 });
        logger.info({ host }, "Circuit breaker transitioning to half-open");
        circuitBreakerMetrics.increment("transitions_to_half_open");
        return { allowed: true };
      }
      circuitBreakerMetrics.increment("requests_blocked");
      return {
        allowed: false,
        reason: `Circuit open for ${host} until ${new Date(state.openUntil).toISOString()}`,
      };
    }

    circuitBreakerMetrics.increment("requests_allowed");
    return { allowed: true };
  }

  static async recordSuccess(url: string, scope?: string): Promise<void> {
    const host = this.extractHost(url, scope);
    if (!host) return;

    const state = await this.getState(host);

    if (state.state === "half-open") {
      const successCount = (state.successCount || 0) + 1;
      if (successCount >= SUCCESS_THRESHOLD) {
        await this.reset(host);
        logger.info({ host }, "Circuit breaker closed after successful requests");
        circuitBreakerMetrics.increment("circuits_closed");
      } else {
        await this.setState(host, { ...state, successCount, lastUpdated: Date.now() });
      }
    } else if (state.failures > 0) {
      await this.reset(host);
    }

    circuitBreakerMetrics.increment("successes_recorded");
  }

  static async recordFailure(url: string, scope?: string): Promise<void> {
    const host = this.extractHost(url, scope);
    if (!host) return;

    const state = await this.getState(host);
    const newFailures = state.failures + 1;

    if (state.state === "half-open") {
      await this.openCircuit(host, newFailures);
      logger.warn({ host }, "Circuit breaker re-opened after failure in half-open state");
      circuitBreakerMetrics.increment("circuits_reopened");
      return;
    }

    if (newFailures >= FAILURE_THRESHOLD) {
      await this.openCircuit(host, newFailures);
      logger.warn({ host, failures: newFailures }, "Circuit breaker opened");
      circuitBreakerMetrics.increment("circuits_opened");
    } else {
      await this.setState(host, {
        failures: newFailures,
        lastFailure: Date.now(),
        lastUpdated: Date.now(),
        state: "closed",
        openUntil: 0,
      });
    }

    circuitBreakerMetrics.increment("failures_recorded");
  }

  private static async getState(host: string): Promise<CircuitState> {
    const now = Date.now();

    const cached = this.localCache.get(host);
    if (cached && now - cached.cachedAt < LOCAL_CACHE_TTL_MS) {
      circuitBreakerMetrics.increment("cache_hits");
      return cached.state;
    }

    circuitBreakerMetrics.increment("cache_misses");

    const key = RedisKeys.circuitBreaker(host);
    const data = await redis.get(key);

    if (data) {
      const state = JSON.parse(data) as CircuitState;
      this.localCache.set(host, { state, cachedAt: now });
      return state;
    }

    const defaultState: CircuitState = {
      failures: 0,
      lastFailure: 0,
      lastUpdated: 0,
      state: "closed",
      openUntil: 0,
    };

    return defaultState;
  }

  private static async setState(host: string, state: CircuitState): Promise<void> {
    const stateWithTimestamp = { ...state, lastUpdated: Date.now() };
    const key = RedisKeys.circuitBreaker(host);
    await redis.set(key, JSON.stringify(stateWithTimestamp), "EX", 3600);

    this.localCache.set(host, { state: stateWithTimestamp, cachedAt: Date.now() });
  }

  private static async openCircuit(host: string, failures: number): Promise<void> {
    await this.setState(host, {
      failures,
      lastFailure: Date.now(),
      lastUpdated: Date.now(),
      state: "open",
      openUntil: Date.now() + RESET_TIMEOUT,
    });
  }

  private static async reset(host: string): Promise<void> {
    const key = RedisKeys.circuitBreaker(host);
    await redis.del(key);
    this.localCache.delete(host);
  }

  private static extractHost(url: string, scope?: string): string | null {
    try {
      const host = new URL(url).host;
      return scope ? `${scope}:${host}` : host;
    } catch {
      return null;
    }
  }

  static isFailureStatus(status: number): boolean {
    return status >= 500 || status === 429 || status === 408;
  }

  static clearLocalCache(): void {
    this.localCache.clear();
    circuitBreakerMetrics.increment("cache_cleared");
  }

  static getCacheStats(): { size: number; hosts: string[] } {
    return {
      size: this.localCache.size,
      hosts: Array.from(this.localCache.keys()),
    };
  }

  static async getOpenCircuits(): Promise<Array<{ host: string; state: CircuitState }>> {
    const results: Array<{ host: string; state: CircuitState }> = [];

    let cursor = "0";
    do {
      const [newCursor, keys] = await redis.scan(cursor, "MATCH", "circuit:*", "COUNT", 100);
      cursor = newCursor;

      for (const key of keys) {
        const data = await redis.get(key);
        if (data) {
          const state = JSON.parse(data) as CircuitState;
          if (state.state === "open") {
            const host = key.replace("circuit:", "");
            results.push({ host, state });
          }
        }
      }
    } while (cursor !== "0");

    return results;
  }

  static getMetrics(): ReturnType<typeof circuitBreakerMetrics.getAll> {
    return circuitBreakerMetrics.getAll();
  }
}
