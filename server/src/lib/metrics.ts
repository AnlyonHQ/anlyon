import { redis } from "./redis.ts";
import { createLogger } from "./logger.ts";

const logger = createLogger({ module: "metrics" });

export class MetricsCollector {
  private counters: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();
  private gauges: Map<string, number> = new Map();
  private syncInterval: NodeJS.Timeout | null = null;
  private readonly prefix: string;

  constructor(prefix: string = "metrics") {
    this.prefix = prefix;
  }

  start(intervalMs: number = 10000): void {
    if (this.syncInterval) return;

    this.syncInterval = setInterval(() => {
      this.syncToRedis().catch((error) => {
        logger.error({ error }, "Failed to sync metrics to Redis");
      });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    await this.syncToRedis();
  }

  increment(name: string, value: number = 1): void {
    const current = this.counters.get(name) || 0;
    this.counters.set(name, current + value);
  }

  recordHistogram(name: string, value: number): void {
    let values = this.histograms.get(name);
    if (!values) {
      values = [];
      this.histograms.set(name, values);
    }
    values.push(value);

    if (values.length > 1000) {
      values.shift();
    }
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  getHistogramStats(name: string): HistogramStats | null {
    const values = this.histograms.get(name);
    if (!values || values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      count: sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sum / sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }

  getAll(): MetricsSnapshot {
    const histogramStats: Record<string, HistogramStats> = {};
    for (const [name, _values] of this.histograms) {
      const stats = this.getHistogramStats(name);
      if (stats) histogramStats[name] = stats;
    }

    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: histogramStats,
      timestamp: Date.now(),
    };
  }

  private async syncToRedis(): Promise<void> {
    const pipeline = redis.pipeline();
    const timestamp = Date.now();
    const expiry = 86400;

    for (const [name, value] of this.counters) {
      if (value > 0) {
        const key = `${this.prefix}:counter:${name}`;
        pipeline.incrby(key, value);
        pipeline.expire(key, expiry);
      }
    }
    this.counters.clear();

    for (const [name, value] of this.gauges) {
      const key = `${this.prefix}:gauge:${name}`;
      pipeline.set(key, value.toString(), "EX", expiry);
    }

    for (const [name, _values] of this.histograms) {
      const stats = this.getHistogramStats(name);
      if (stats) {
        const key = `${this.prefix}:histogram:${name}`;
        pipeline.hset(key, {
          count: stats.count.toString(),
          min: stats.min.toString(),
          max: stats.max.toString(),
          avg: stats.avg.toString(),
          p50: stats.p50.toString(),
          p95: stats.p95.toString(),
          p99: stats.p99.toString(),
          timestamp: timestamp.toString(),
        });
        pipeline.expire(key, expiry);
      }
    }

    await pipeline.exec();
  }
}

export interface HistogramStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramStats>;
  timestamp: number;
}

export class Timer {
  private startTime: number;

  constructor() {
    this.startTime = performance.now();
  }

  elapsed(): number {
    return performance.now() - this.startTime;
  }

  recordTo(metrics: MetricsCollector, histogramName: string): number {
    const elapsed = this.elapsed();
    metrics.recordHistogram(histogramName, elapsed);
    return elapsed;
  }
}

export const Metrics = MetricsCollector;

export const consumerMetrics = new MetricsCollector("consumer");
export const schedulerMetrics = new MetricsCollector("scheduler");
export const retryMetrics = new MetricsCollector("retry");

async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, foundKeys] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100
    );
    cursor = nextCursor;
    keys.push(...foundKeys);
  } while (cursor !== "0");

  return keys;
}

export async function getAggregatedMetrics(
  prefix: string
): Promise<Record<string, string | Record<string, string>>> {
  const result: Record<string, string | Record<string, string>> = {};

  const [counterKeys, gaugeKeys, histogramKeys] = await Promise.all([
    scanKeys(`${prefix}:counter:*`),
    scanKeys(`${prefix}:gauge:*`),
    scanKeys(`${prefix}:histogram:*`),
  ]);

  const pipeline = redis.pipeline();
  const keyMappings: { key: string; type: "counter" | "gauge" | "histogram"; name: string }[] = [];

  for (const key of counterKeys) {
    const name = key.replace(`${prefix}:counter:`, "");
    pipeline.get(key);
    keyMappings.push({ key, type: "counter", name });
  }

  for (const key of gaugeKeys) {
    const name = key.replace(`${prefix}:gauge:`, "");
    pipeline.get(key);
    keyMappings.push({ key, type: "gauge", name });
  }

  for (const key of histogramKeys) {
    const name = key.replace(`${prefix}:histogram:`, "");
    pipeline.hgetall(key);
    keyMappings.push({ key, type: "histogram", name });
  }

  const results = await pipeline.exec();
  if (!results) return result;

  for (let i = 0; i < keyMappings.length; i++) {
    const mapping = keyMappings[i];
    const [err, value] = results[i];

    if (err || !value) continue;

    if (mapping.type === "histogram") {
      const hashValue = value as Record<string, string>;
      if (Object.keys(hashValue).length > 0) {
        result[`histogram:${mapping.name}`] = hashValue;
      }
    } else {
      result[`${mapping.type}:${mapping.name}`] = value as string;
    }
  }

  return result;
}
