import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockPipeline = {
  incrby: vi.fn().mockReturnThis(),
  expire: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  hset: vi.fn().mockReturnThis(),
  get: vi.fn().mockReturnThis(),
  hgetall: vi.fn().mockReturnThis(),
  exec: vi.fn(),
};

vi.mock("../src/lib/redis.ts", () => ({
  redis: {
    pipeline: vi.fn(() => mockPipeline),
    scan: vi.fn(),
  },
}));

vi.mock("../src/lib/logger.ts", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  MetricsCollector,
  Timer,
  getAggregatedMetrics,
} from "../src/lib/metrics.ts";
import { redis } from "../src/lib/redis.ts";

const mockRedis = redis as unknown as {
  pipeline: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
};

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    collector = new MetricsCollector("test");
    mockPipeline.exec.mockResolvedValue([]);
  });

  afterEach(async () => {
    await collector.stop();
    vi.useRealTimers();
  });

  describe("increment", () => {
    it("should increment counter", () => {
      collector.increment("test_counter");
      collector.increment("test_counter");
      collector.increment("test_counter", 5);

      const metrics = collector.getAll();
      expect(metrics.counters.test_counter).toBe(7);
    });

    it("should handle multiple counters", () => {
      collector.increment("counter_a");
      collector.increment("counter_b", 10);

      const metrics = collector.getAll();
      expect(metrics.counters.counter_a).toBe(1);
      expect(metrics.counters.counter_b).toBe(10);
    });
  });

  describe("setGauge", () => {
    it("should set gauge value", () => {
      collector.setGauge("active_connections", 42);

      const metrics = collector.getAll();
      expect(metrics.gauges.active_connections).toBe(42);
    });

    it("should overwrite previous gauge value", () => {
      collector.setGauge("queue_size", 100);
      collector.setGauge("queue_size", 50);

      const metrics = collector.getAll();
      expect(metrics.gauges.queue_size).toBe(50);
    });
  });

  describe("recordHistogram", () => {
    it("should record histogram values", () => {
      collector.recordHistogram("latency", 10);
      collector.recordHistogram("latency", 20);
      collector.recordHistogram("latency", 30);

      const stats = collector.getHistogramStats("latency");

      expect(stats).not.toBeNull();
      expect(stats?.count).toBe(3);
      expect(stats?.min).toBe(10);
      expect(stats?.max).toBe(30);
      expect(stats?.avg).toBe(20);
    });

    it("should calculate percentiles correctly", () => {
      for (let i = 1; i <= 100; i++) {
        collector.recordHistogram("response_time", i);
      }

      const stats = collector.getHistogramStats("response_time");

      expect(stats?.p50).toBeGreaterThanOrEqual(50);
      expect(stats?.p50).toBeLessThanOrEqual(51);
      expect(stats?.p95).toBeGreaterThanOrEqual(95);
      expect(stats?.p95).toBeLessThanOrEqual(96);
      expect(stats?.p99).toBeGreaterThanOrEqual(99);
      expect(stats?.p99).toBeLessThanOrEqual(100);
    });

    it("should limit histogram size to 1000 values", () => {
      for (let i = 0; i < 1100; i++) {
        collector.recordHistogram("large_histogram", i);
      }

      const stats = collector.getHistogramStats("large_histogram");
      expect(stats?.count).toBe(1000);
    });

    it("should return null for non-existent histogram", () => {
      const stats = collector.getHistogramStats("nonexistent");
      expect(stats).toBeNull();
    });
  });

  describe("getAll", () => {
    it("should return all metrics", () => {
      collector.increment("counter");
      collector.setGauge("gauge", 100);
      collector.recordHistogram("histogram", 50);

      const metrics = collector.getAll();

      expect(metrics.counters.counter).toBe(1);
      expect(metrics.gauges.gauge).toBe(100);
      expect(metrics.histograms.histogram).toBeDefined();
      expect(metrics.timestamp).toBeGreaterThan(0);
    });
  });

  describe("start and syncToRedis", () => {
    it("should sync counters to Redis", async () => {
      collector.increment("test_counter", 5);
      collector.start(100);

      await vi.advanceTimersByTimeAsync(150);

      expect(mockPipeline.incrby).toHaveBeenCalledWith(
        "test:counter:test_counter",
        5
      );
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it("should sync gauges to Redis", async () => {
      collector.setGauge("active", 42);
      collector.start(100);

      await vi.advanceTimersByTimeAsync(150);

      expect(mockPipeline.set).toHaveBeenCalledWith(
        "test:gauge:active",
        "42",
        "EX",
        86400
      );
    });

    it("should sync histograms to Redis", async () => {
      collector.recordHistogram("latency", 100);
      collector.start(100);

      await vi.advanceTimersByTimeAsync(150);

      expect(mockPipeline.hset).toHaveBeenCalledWith(
        "test:histogram:latency",
        expect.objectContaining({
          count: "1",
          min: "100",
          max: "100",
        })
      );
    });

    it("should clear counters after sync", async () => {
      collector.increment("test_counter", 5);
      collector.start(100);

      await vi.advanceTimersByTimeAsync(150);

      const metrics = collector.getAll();
      expect(metrics.counters.test_counter).toBeUndefined();
    });
  });

  describe("stop", () => {
    it("should flush metrics on stop", async () => {
      collector.increment("final_counter", 10);

      await collector.stop();

      expect(mockPipeline.incrby).toHaveBeenCalledWith(
        "test:counter:final_counter",
        10
      );
      expect(mockPipeline.exec).toHaveBeenCalled();
    });
  });
});

describe("Timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("elapsed", () => {
    it("should measure elapsed time", () => {
      const timer = new Timer();

      vi.advanceTimersByTime(100);

      const elapsed = timer.elapsed();
      expect(elapsed).toBeGreaterThanOrEqual(100);
    });
  });

  describe("recordTo", () => {
    it("should record elapsed time to histogram", () => {
      const collector = new MetricsCollector("test");
      const timer = new Timer();

      vi.advanceTimersByTime(50);

      const elapsed = timer.recordTo(collector, "operation_duration");

      expect(elapsed).toBeGreaterThanOrEqual(50);

      const stats = collector.getHistogramStats("operation_duration");
      expect(stats?.count).toBe(1);
    });
  });
});

describe("getAggregatedMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipeline.exec.mockResolvedValue([]);
  });

  it("should use SCAN instead of KEYS", async () => {
    mockRedis.scan
      .mockResolvedValueOnce(["0", []])
      .mockResolvedValueOnce(["0", []])
      .mockResolvedValueOnce(["0", []]);

    await getAggregatedMetrics("test");

    expect(mockRedis.scan).toHaveBeenCalledTimes(3);
    expect(mockRedis.scan).toHaveBeenCalledWith(
      "0",
      "MATCH",
      "test:counter:*",
      "COUNT",
      100
    );
    expect(mockRedis.scan).toHaveBeenCalledWith(
      "0",
      "MATCH",
      "test:gauge:*",
      "COUNT",
      100
    );
    expect(mockRedis.scan).toHaveBeenCalledWith(
      "0",
      "MATCH",
      "test:histogram:*",
      "COUNT",
      100
    );
  });

  it("should handle pagination in SCAN", async () => {
    mockRedis.scan
      .mockResolvedValueOnce(["100", ["test:counter:a"]])
      .mockResolvedValueOnce(["0", []])
      .mockResolvedValueOnce(["0", []])
      .mockResolvedValueOnce(["0", ["test:counter:b"]]);

    mockPipeline.exec.mockResolvedValueOnce([
      [null, "10"],
      [null, "20"],
    ]);

    const result = await getAggregatedMetrics("test");

    expect(result["counter:a"]).toBe("10");
    expect(result["counter:b"]).toBe("20");
  });

  it("should fetch all metric types with pipeline", async () => {
    mockRedis.scan
      .mockResolvedValueOnce(["0", ["test:counter:requests"]])
      .mockResolvedValueOnce(["0", ["test:gauge:connections"]])
      .mockResolvedValueOnce(["0", ["test:histogram:latency"]]);

    mockPipeline.exec.mockResolvedValueOnce([
      [null, "1000"],
      [null, "42"],
      [null, { count: "100", min: "10", max: "500", avg: "150" }],
    ]);

    const result = await getAggregatedMetrics("test");

    expect(result["counter:requests"]).toBe("1000");
    expect(result["gauge:connections"]).toBe("42");
    expect(result["histogram:latency"]).toEqual({
      count: "100",
      min: "10",
      max: "500",
      avg: "150",
    });
  });

  it("should handle empty results", async () => {
    mockRedis.scan
      .mockResolvedValueOnce(["0", []])
      .mockResolvedValueOnce(["0", []])
      .mockResolvedValueOnce(["0", []]);

    mockPipeline.exec.mockResolvedValueOnce(null);

    const result = await getAggregatedMetrics("test");

    expect(result).toEqual({});
  });

  it("should skip errored results", async () => {
    mockRedis.scan
      .mockResolvedValueOnce(["0", ["test:counter:a", "test:counter:b"]])
      .mockResolvedValueOnce(["0", []])
      .mockResolvedValueOnce(["0", []]);

    mockPipeline.exec.mockResolvedValueOnce([
      [new Error("Redis error"), null],
      [null, "20"],
    ]);

    const result = await getAggregatedMetrics("test");

    expect(result["counter:a"]).toBeUndefined();
    expect(result["counter:b"]).toBe("20");
  });
});
