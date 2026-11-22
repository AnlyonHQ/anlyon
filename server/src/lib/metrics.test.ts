import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MetricsCollector, Timer } from './metrics';

vi.mock('./redis', () => ({
  redis: {
    pipeline: vi.fn(() => ({
      incrby: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      hset: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
    keys: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    hgetall: vi.fn().mockResolvedValue({}),
  },
}));

describe('MetricsCollector', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector('test');
  });

  afterEach(async () => {
    await metrics.stop();
  });

  describe('counters', () => {
    it('should increment counter by default value of 1', () => {
      metrics.increment('test_counter');
      metrics.increment('test_counter');

      const snapshot = metrics.getAll();
      expect(snapshot.counters['test_counter']).toBe(2);
    });

    it('should increment counter by specified value', () => {
      metrics.increment('test_counter', 5);
      metrics.increment('test_counter', 3);

      const snapshot = metrics.getAll();
      expect(snapshot.counters['test_counter']).toBe(8);
    });

    it('should handle multiple counters independently', () => {
      metrics.increment('counter_a', 10);
      metrics.increment('counter_b', 20);

      const snapshot = metrics.getAll();
      expect(snapshot.counters['counter_a']).toBe(10);
      expect(snapshot.counters['counter_b']).toBe(20);
    });
  });

  describe('gauges', () => {
    it('should set gauge value', () => {
      metrics.setGauge('queue_depth', 100);

      const snapshot = metrics.getAll();
      expect(snapshot.gauges['queue_depth']).toBe(100);
    });

    it('should overwrite gauge value', () => {
      metrics.setGauge('queue_depth', 100);
      metrics.setGauge('queue_depth', 50);

      const snapshot = metrics.getAll();
      expect(snapshot.gauges['queue_depth']).toBe(50);
    });
  });

  describe('histograms', () => {
    it('should record histogram values', () => {
      metrics.recordHistogram('latency_ms', 10);
      metrics.recordHistogram('latency_ms', 20);
      metrics.recordHistogram('latency_ms', 30);

      const stats = metrics.getHistogramStats('latency_ms');
      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(3);
      expect(stats!.min).toBe(10);
      expect(stats!.max).toBe(30);
      expect(stats!.avg).toBe(20);
    });

    it('should calculate percentiles correctly', () => {
      for (let i = 1; i <= 100; i++) {
        metrics.recordHistogram('latency_ms', i);
      }

      const stats = metrics.getHistogramStats('latency_ms');
      expect(stats).not.toBeNull();
      expect(stats!.p50).toBeGreaterThanOrEqual(50);
      expect(stats!.p50).toBeLessThanOrEqual(51);
      expect(stats!.p95).toBeGreaterThanOrEqual(95);
      expect(stats!.p95).toBeLessThanOrEqual(96);
      expect(stats!.p99).toBeGreaterThanOrEqual(99);
      expect(stats!.p99).toBeLessThanOrEqual(100);
    });

    it('should limit histogram size to 1000 values', () => {
      for (let i = 1; i <= 1500; i++) {
        metrics.recordHistogram('latency_ms', i);
      }

      const stats = metrics.getHistogramStats('latency_ms');
      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(1000);
      expect(stats!.min).toBe(501);
    });

    it('should return null for non-existent histogram', () => {
      const stats = metrics.getHistogramStats('non_existent');
      expect(stats).toBeNull();
    });
  });

  describe('getAll', () => {
    it('should return complete metrics snapshot', () => {
      metrics.increment('counter', 5);
      metrics.setGauge('gauge', 100);
      metrics.recordHistogram('histogram', 50);

      const snapshot = metrics.getAll();

      expect(snapshot.counters).toHaveProperty('counter', 5);
      expect(snapshot.gauges).toHaveProperty('gauge', 100);
      expect(snapshot.histograms).toHaveProperty('histogram');
      expect(snapshot.timestamp).toBeGreaterThan(0);
    });
  });
});

describe('Timer', () => {
  it('should measure elapsed time', async () => {
    const timer = new Timer();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const elapsed = timer.elapsed();
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(200);
  });

  it('should record elapsed time to metrics', async () => {
    const metrics = new MetricsCollector('test');
    const timer = new Timer();

    await new Promise((resolve) => setTimeout(resolve, 10));

    const elapsed = timer.recordTo(metrics, 'operation_ms');

    expect(elapsed).toBeGreaterThan(0);

    const stats = metrics.getHistogramStats('operation_ms');
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(1);

    await metrics.stop();
  });
});
