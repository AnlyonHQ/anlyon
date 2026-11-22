import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/redis.ts", () => ({
  redis: {
    xack: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
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

vi.mock("../src/lib/metrics.ts", () => ({
  MetricsCollector: class MockMetricsCollector {
    start = vi.fn();
    stop = vi.fn().mockResolvedValue(undefined);
    increment = vi.fn();
    setGauge = vi.fn();
    recordHistogram = vi.fn();
    getAll = vi.fn().mockReturnValue({
      counters: {},
      gauges: {},
      histograms: {},
      timestamp: Date.now(),
    });
  },
}));

import { BatchAckCollector } from "../src/lib/batch-ack.ts";
import { redis } from "../src/lib/redis.ts";

const mockRedis = redis as unknown as {
  xack: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
};

describe("BatchAckCollector", () => {
  let collector: BatchAckCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    collector = new BatchAckCollector(5, 100, 500);
  });

  afterEach(async () => {
    await collector.stop();
    vi.useRealTimers();
  });

  describe("add", () => {
    it("should add acknowledgment to pending queue", async () => {
      await collector.add("stream:ws1", "consumers", "msg-1");

      expect(collector.getPendingCount()).toBe(1);
    });

    it("should flush when batch size is reached", async () => {
      mockRedis.xack.mockResolvedValue(5);

      for (let i = 0; i < 5; i++) {
        await collector.add("stream:ws1", "consumers", `msg-${i}`);
      }

      expect(mockRedis.xack).toHaveBeenCalledTimes(1);
      expect(mockRedis.xack).toHaveBeenCalledWith(
        "stream:ws1",
        "consumers",
        "msg-0",
        "msg-1",
        "msg-2",
        "msg-3",
        "msg-4"
      );
      expect(collector.getPendingCount()).toBe(0);
    });

    it("should batch by stream key and consumer group", async () => {
      mockRedis.xack.mockResolvedValue(5);

      await collector.add("stream:ws1", "consumers", "msg-1");
      await collector.add("stream:ws2", "consumers", "msg-2");

      expect(collector.getPendingCount()).toBe(2);
    });
  });

  describe("flushAll", () => {
    it("should flush all pending acks when max age reached", async () => {
      mockRedis.xack.mockResolvedValue(2);

      await collector.add("stream:ws1", "consumers", "msg-1");
      await collector.add("stream:ws1", "consumers", "msg-2");

      vi.advanceTimersByTime(600);

      await collector.flushAll();

      expect(mockRedis.xack).toHaveBeenCalledWith(
        "stream:ws1",
        "consumers",
        "msg-1",
        "msg-2"
      );
      expect(collector.getPendingCount()).toBe(0);
    });

    it("should flush multiple stream keys in parallel", async () => {
      mockRedis.xack.mockResolvedValue(1);

      await collector.add("stream:ws1", "consumers", "msg-1");
      await collector.add("stream:ws2", "consumers", "msg-2");

      vi.advanceTimersByTime(600);

      await collector.flushAll();

      expect(mockRedis.xack).toHaveBeenCalledTimes(2);
    });

    it("should handle empty queue gracefully", async () => {
      await collector.flushAll();

      expect(mockRedis.xack).not.toHaveBeenCalled();
    });
  });

  describe("start/stop", () => {
    it("should start periodic flushing when max age reached", async () => {
      mockRedis.xack.mockResolvedValue(1);
      collector.start();

      await collector.add("stream:ws1", "consumers", "msg-1");

      await vi.advanceTimersByTimeAsync(600);

      expect(mockRedis.xack).toHaveBeenCalled();
    });

    it("should flush remaining acks on stop (with max age)", async () => {
      mockRedis.xack.mockResolvedValue(2);

      await collector.add("stream:ws1", "consumers", "msg-1");
      await collector.add("stream:ws1", "consumers", "msg-2");

      vi.advanceTimersByTime(600);

      await collector.stop();

      expect(mockRedis.xack).toHaveBeenCalledWith(
        "stream:ws1",
        "consumers",
        "msg-1",
        "msg-2"
      );
    });
  });

  describe("error handling", () => {
    it("should re-add acks on flush failure", async () => {
      mockRedis.xack.mockRejectedValueOnce(new Error("Redis error"));

      await collector.add("stream:ws1", "consumers", "msg-1");
      await collector.add("stream:ws1", "consumers", "msg-2");
      await collector.add("stream:ws1", "consumers", "msg-3");
      await collector.add("stream:ws1", "consumers", "msg-4");
      await collector.add("stream:ws1", "consumers", "msg-5");

      expect(collector.getPendingCount()).toBe(5);
    });
  });

  describe("getPendingCount", () => {
    it("should return correct pending count", async () => {
      expect(collector.getPendingCount()).toBe(0);

      await collector.add("stream:ws1", "consumers", "msg-1");
      expect(collector.getPendingCount()).toBe(1);

      await collector.add("stream:ws2", "consumers", "msg-2");
      expect(collector.getPendingCount()).toBe(2);
    });
  });
});
