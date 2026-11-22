import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/safe-http.ts", () => ({
  safeFetch: vi.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

vi.mock("../src/lib/redis.ts", () => ({
  redis: {
    lpush: vi.fn(),
    ltrim: vi.fn(),
    expire: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
  },
  RedisKeys: {},
}));

vi.mock("../src/utils/url-validation.ts", () => ({
  resolveAndValidateUrl: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock("../src/lib/url-cache.ts", () => ({
  urlValidationCache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  },
}));

vi.mock("../src/core/auth/delivery-secrets.ts", () => ({
  signDeliveryForWorkspace: vi.fn().mockResolvedValue({
    signature: "test-signature",
    timestamp: 1234567890,
  }),
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

const mockIsEnvironmentHalted = vi.fn().mockResolvedValue(false);
vi.mock("../src/core/environments/halt.ts", () => ({
  isEnvironmentHalted: (...args: unknown[]) => mockIsEnvironmentHalted(...args),
}));

import { CallbackQueue } from "../src/lib/callback-queue.ts";
import { redis } from "../src/lib/redis.ts";
import { urlValidationCache } from "../src/lib/url-cache.ts";
import { signDeliveryForWorkspace } from "../src/core/auth/delivery-secrets.ts";
import { safeFetch } from "../src/lib/safe-http.ts";

const mockFetch = safeFetch as unknown as ReturnType<typeof vi.fn>;

const mockRedis = redis as unknown as {
  lpush: ReturnType<typeof vi.fn>;
  ltrim: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
};

describe("CallbackQueue", () => {
  let queue: CallbackQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    queue = new CallbackQueue(2);
    mockFetch.mockReset();
    mockIsEnvironmentHalted.mockResolvedValue(false);
  });

  afterEach(async () => {
    await queue.stop();
    vi.useRealTimers();
  });

  describe("enqueue", () => {
    it("should add callback to queue", () => {
      queue.enqueue("ws-1", "https://example.com/callback", {
        messageId: "msg-1",
        status: "delivered",
      });

      expect(queue.getStats().queued).toBe(1);
    });

    it("should drop callbacks when queue is full", () => {
      for (let i = 0; i < 100; i++) {
        queue.enqueue("ws-1", "https://example.com/callback", {
          messageId: `msg-${i}`,
          status: "delivered",
        });
      }

      expect(queue.getStats().queued).toBe(100);
    });
  });

  describe("start and processing", () => {
    it("should process callbacks when started", async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await queue.start();
      queue.enqueue("ws-1", "https://example.com/callback", {
        messageId: "msg-1",
        status: "delivered",
      });

      await vi.advanceTimersByTimeAsync(100);

      expect(mockFetch).toHaveBeenCalled();
    });

    it("should send correct headers", async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await queue.start();
      queue.enqueue("ws-1", "https://example.com/callback", {
        messageId: "msg-1",
        status: "delivered",
      });

      await vi.advanceTimersByTimeAsync(100);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/callback",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "X-Callback-Attempt": "1",
            "Anlyon-Signature": "test-signature",
            "Anlyon-Timestamp": "1234567890",
            "X-Anlyon-Workspace-Id": "ws-1",
          }),
        })
      );
    });

    it("should respect concurrency limit", async () => {
      let resolveFirst: () => void;
      let resolveSecond: () => void;
      let resolveThird: () => void;

      const firstPromise = new Promise<void>((r) => {
        resolveFirst = r;
      });
      const secondPromise = new Promise<void>((r) => {
        resolveSecond = r;
      });
      const thirdPromise = new Promise<void>((r) => {
        resolveThird = r;
      });

      mockFetch
        .mockImplementationOnce(() => firstPromise.then(() => ({ ok: true })))
        .mockImplementationOnce(() => secondPromise.then(() => ({ ok: true })))
        .mockImplementationOnce(() => thirdPromise.then(() => ({ ok: true })));

      await queue.start();

      queue.enqueue("ws-1", "https://example.com/1", {
        messageId: "msg-1",
        status: "delivered",
      });
      queue.enqueue("ws-1", "https://example.com/2", {
        messageId: "msg-2",
        status: "delivered",
      });
      queue.enqueue("ws-1", "https://example.com/3", {
        messageId: "msg-3",
        status: "delivered",
      });

      await vi.advanceTimersByTimeAsync(50);

      expect(queue.getStats().inFlight).toBe(2);

      resolveFirst!();
      resolveSecond!();
      await vi.advanceTimersByTimeAsync(50);

      expect(mockFetch).toHaveBeenCalledTimes(3);

      resolveThird!();
      await vi.advanceTimersByTimeAsync(50);
    });
  });

  describe("retry logic", () => {
    it("should retry on failure", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true });

      await queue.start();
      queue.enqueue("ws-1", "https://example.com/callback", {
        messageId: "msg-1",
        status: "delivered",
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2100);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should record failure after max attempts", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });
      mockRedis.lpush.mockResolvedValue(1);
      mockRedis.ltrim.mockResolvedValue("OK");
      mockRedis.expire.mockResolvedValue(1);

      await queue.start();
      queue.enqueue("ws-1", "https://example.com/callback", {
        messageId: "msg-1",
        status: "failed",
      });

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(4100);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockRedis.lpush).toHaveBeenCalled();
    });
  });

  describe("URL validation", () => {
    it("should skip callback for invalid URL", async () => {
      (urlValidationCache.get as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        valid: false,
        error: "Invalid URL",
        expiresAt: Date.now() + 60000,
      });

      await queue.start();
      queue.enqueue("ws-1", "https://invalid.com/callback", {
        messageId: "msg-1",
        status: "delivered",
      });

      await vi.advanceTimersByTimeAsync(100);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should delegate URL validation to safeFetch if not cached", async () => {
      (urlValidationCache.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        null
      );
      mockFetch.mockResolvedValue({ ok: true });

      await queue.start();
      queue.enqueue("ws-1", "https://example.com/callback", {
        messageId: "msg-1",
        status: "delivered",
      });

      await vi.advanceTimersByTimeAsync(100);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/callback",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("stop", () => {
    it("should wait for in-flight callbacks to complete", async () => {
      let resolveCallback: () => void;
      const callbackPromise = new Promise<void>((r) => {
        resolveCallback = r;
      });

      mockFetch.mockImplementation(() =>
        callbackPromise.then(() => ({ ok: true }))
      );

      await queue.start();
      queue.enqueue("ws-1", "https://example.com/callback", {
        messageId: "msg-1",
        status: "delivered",
      });

      await vi.advanceTimersByTimeAsync(50);

      const stopPromise = queue.stop();

      resolveCallback!();
      await vi.advanceTimersByTimeAsync(100);

      await stopPromise;

      expect(queue.getStats().inFlight).toBe(0);
    });
  });

  describe("getStats", () => {
    it("should return correct stats", () => {
      queue.enqueue("ws-1", "https://example.com/1", {
        messageId: "msg-1",
        status: "delivered",
      });
      queue.enqueue("ws-1", "https://example.com/2", {
        messageId: "msg-2",
        status: "delivered",
      });

      const stats = queue.getStats();

      expect(stats.queued).toBe(2);
      expect(stats.inFlight).toBe(0);
    });
  });

  describe("signing", () => {
    it("preserves the originating environment for callback signing", async () => {
      mockFetch.mockResolvedValue({ ok: true });
      await queue.start();
      queue.enqueue("ws-1", "https://example.com/callback", { messageId: "msg-env", status: "delivered" }, "env_staging");
      await vi.advanceTimersByTimeAsync(100);
      expect(signDeliveryForWorkspace).toHaveBeenCalledWith("ws-1", expect.stringContaining("msg-env"), "env_staging");
      expect(mockFetch.mock.calls[0][1].headers["X-Anlyon-Environment-Id"]).toBe("env_staging");
    });

    it("should sign callback payload", async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await queue.start();
      queue.enqueue("ws-1", "https://example.com/callback", {
        messageId: "msg-1",
        status: "delivered",
        responseStatus: 200,
      });

      await vi.advanceTimersByTimeAsync(100);

      expect(signDeliveryForWorkspace).toHaveBeenCalledWith(
        "ws-1",
        expect.stringContaining("msg-1"),
        undefined
      );
    });
  });
  describe("idempotency", () => {
    it("sends a key that is stable across retries of the same callback", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      await queue.start();
      queue.enqueue("ws-1", "https://example.com/callback", {
        messageId: "msg-1",
        status: "delivered",
      }, "env-1");
      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
      const keys = mockFetch.mock.calls.map(
        ([, init]) => (init as { headers: Record<string, string> }).headers["X-Idempotency-Key"],
      );
      expect(new Set(keys)).toEqual(new Set(["msg-1:delivered"]));
    });
  });

  describe("environment halt", () => {
    it("holds a callback while its environment is halted instead of sending or dropping it", async () => {
      mockIsEnvironmentHalted.mockResolvedValue(true);
      mockFetch.mockResolvedValue({ ok: true });

      await queue.start();
      queue.enqueue("ws-1", "https://example.com/callback", {
        messageId: "msg-1",
        status: "delivered",
      }, "env-1");

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(queue.getStats().queued).toBe(1);
    });

    it("releases a held callback once the environment resumes", async () => {
      mockIsEnvironmentHalted.mockResolvedValue(true);
      mockFetch.mockResolvedValue({ ok: true });

      await queue.start();
      queue.enqueue("ws-1", "https://example.com/callback", {
        messageId: "msg-1",
        status: "delivered",
      }, "env-1");
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockFetch).not.toHaveBeenCalled();

      mockIsEnvironmentHalted.mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(queue.getStats().queued).toBe(0);
    });

    it("does not hold a legacy callback that recorded no environment", async () => {
      mockIsEnvironmentHalted.mockResolvedValue(true);
      mockFetch.mockResolvedValue({ ok: true });

      await queue.start();
      queue.enqueue("ws-1", "https://example.com/callback", {
        messageId: "msg-1",
        status: "delivered",
      });

      await vi.advanceTimersByTimeAsync(100);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockIsEnvironmentHalted).not.toHaveBeenCalled();
    });
  });
});
