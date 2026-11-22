import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/redis.ts", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    scan: vi.fn(),
  },
  RedisKeys: {
    circuitBreaker: (host: string) => `circuit:${host}`,
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

import { CircuitBreaker } from "../src/lib/circuit-breaker.ts";
import { redis } from "../src/lib/redis.ts";

const mockRedis = redis as unknown as {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
};

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (CircuitBreaker as any).localCache = new Map();
  });

  describe("extractHost", () => {
    it("should extract host from valid URL", async () => {
      mockRedis.get.mockResolvedValue(null);

      await CircuitBreaker.canRequest("https://api.example.com/webhook");

      expect(mockRedis.get).toHaveBeenCalledWith("circuit:api.example.com");
    });

    it("should extract host with port", async () => {
      mockRedis.get.mockResolvedValue(null);

      await CircuitBreaker.canRequest("https://api.example.com:8080/webhook");

      expect(mockRedis.get).toHaveBeenCalledWith("circuit:api.example.com:8080");
    });

    it("should handle invalid URL gracefully", async () => {
      const result = await CircuitBreaker.canRequest("not-a-url");

      expect(result.allowed).toBe(true);
    });
  });

  describe("canRequest", () => {
    it("should allow request when circuit is closed (no state)", async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await CircuitBreaker.canRequest(
        "https://api.example.com/webhook"
      );

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should allow request when circuit is closed with failures", async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          failures: 3,
          lastFailure: Date.now(),
          state: "closed",
          openUntil: 0,
        })
      );

      const result = await CircuitBreaker.canRequest(
        "https://api.example.com/webhook"
      );

      expect(result.allowed).toBe(true);
    });

    it("should block request when circuit is open", async () => {
      const futureTime = Date.now() + 30000;
      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          failures: 5,
          lastFailure: Date.now(),
          state: "open",
          openUntil: futureTime,
        })
      );

      const result = await CircuitBreaker.canRequest(
        "https://api.example.com/webhook"
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Circuit open for api.example.com");
    });

    it("should transition to half-open when open period expires", async () => {
      const pastTime = Date.now() - 1000;
      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          failures: 5,
          lastFailure: Date.now() - 30000,
          state: "open",
          openUntil: pastTime,
        })
      );
      mockRedis.set.mockResolvedValue("OK");

      const result = await CircuitBreaker.canRequest(
        "https://api.example.com/webhook"
      );

      expect(result.allowed).toBe(true);
      expect(mockRedis.set).toHaveBeenCalled();
      const setCall = mockRedis.set.mock.calls[0];
      const savedState = JSON.parse(setCall[1]);
      expect(savedState.state).toBe("half-open");
    });

    it("should allow request when circuit is half-open", async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          failures: 5,
          lastFailure: Date.now() - 30000,
          state: "half-open",
          openUntil: Date.now() - 1000,
        })
      );

      const result = await CircuitBreaker.canRequest(
        "https://api.example.com/webhook"
      );

      expect(result.allowed).toBe(true);
    });
  });

  describe("recordSuccess", () => {
    it("should reset circuit on success when closed with failures", async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          failures: 3,
          lastFailure: Date.now(),
          state: "closed",
          openUntil: 0,
        })
      );
      mockRedis.del.mockResolvedValue(1);

      await CircuitBreaker.recordSuccess("https://api.example.com/webhook");

      expect(mockRedis.del).toHaveBeenCalledWith("circuit:api.example.com");
    });

    it("should do nothing when closed with no failures", async () => {
      mockRedis.get.mockResolvedValue(null);

      await CircuitBreaker.recordSuccess("https://api.example.com/webhook");

      expect(mockRedis.del).not.toHaveBeenCalled();
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it("should track success count in half-open state", async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          failures: 5,
          lastFailure: Date.now() - 30000,
          state: "half-open",
          openUntil: Date.now() - 1000,
          successCount: 0,
        })
      );
      mockRedis.set.mockResolvedValue("OK");

      await CircuitBreaker.recordSuccess("https://api.example.com/webhook");

      expect(mockRedis.set).toHaveBeenCalled();
      const setCall = mockRedis.set.mock.calls[0];
      const savedState = JSON.parse(setCall[1]);
      expect(savedState.successCount).toBe(1);
    });

    it("should close circuit after enough successes in half-open", async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          failures: 5,
          lastFailure: Date.now() - 30000,
          state: "half-open",
          openUntil: Date.now() - 1000,
          successCount: 1,
        })
      );
      mockRedis.del.mockResolvedValue(1);

      await CircuitBreaker.recordSuccess("https://api.example.com/webhook");

      expect(mockRedis.del).toHaveBeenCalled();
    });

    it("should handle invalid URL gracefully", async () => {
      await expect(
        CircuitBreaker.recordSuccess("not-a-url")
      ).resolves.not.toThrow();
    });
  });

  describe("recordFailure", () => {
    it("should increment failure count", async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.set.mockResolvedValue("OK");

      await CircuitBreaker.recordFailure("https://api.example.com/webhook");

      expect(mockRedis.set).toHaveBeenCalled();
      const setCall = mockRedis.set.mock.calls[0];
      const savedState = JSON.parse(setCall[1]);
      expect(savedState.failures).toBe(1);
      expect(savedState.state).toBe("closed");
    });

    it("should open circuit after threshold failures", async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          failures: 4,
          lastFailure: Date.now() - 1000,
          state: "closed",
          openUntil: 0,
        })
      );
      mockRedis.set.mockResolvedValue("OK");

      await CircuitBreaker.recordFailure("https://api.example.com/webhook");

      expect(mockRedis.set).toHaveBeenCalled();
      const setCall = mockRedis.set.mock.calls[0];
      const savedState = JSON.parse(setCall[1]);
      expect(savedState.failures).toBe(5);
      expect(savedState.state).toBe("open");
      expect(savedState.openUntil).toBeGreaterThan(Date.now());
    });

    it("should immediately re-open circuit on failure in half-open state", async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          failures: 5,
          lastFailure: Date.now() - 30000,
          state: "half-open",
          openUntil: Date.now() - 1000,
        })
      );
      mockRedis.set.mockResolvedValue("OK");

      await CircuitBreaker.recordFailure("https://api.example.com/webhook");

      expect(mockRedis.set).toHaveBeenCalled();
      const setCall = mockRedis.set.mock.calls[0];
      const savedState = JSON.parse(setCall[1]);
      expect(savedState.state).toBe("open");
    });

    it("should handle invalid URL gracefully", async () => {
      await expect(
        CircuitBreaker.recordFailure("not-a-url")
      ).resolves.not.toThrow();
    });
  });

  describe("getOpenCircuits", () => {
    it("should return empty array when no circuits are open", async () => {
      mockRedis.scan.mockResolvedValueOnce(["0", []]);

      const result = await CircuitBreaker.getOpenCircuits();

      expect(result).toEqual([]);
    });

    it("should return open circuits", async () => {
      mockRedis.scan.mockResolvedValueOnce([
        "0",
        ["circuit:api.example.com", "circuit:api2.example.com"],
      ]);
      mockRedis.get
        .mockResolvedValueOnce(
          JSON.stringify({
            failures: 5,
            state: "open",
            openUntil: Date.now() + 30000,
          })
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            failures: 3,
            state: "closed",
            openUntil: 0,
          })
        );

      const result = await CircuitBreaker.getOpenCircuits();

      expect(result).toHaveLength(1);
      expect(result[0].host).toBe("api.example.com");
      expect(result[0].state.state).toBe("open");
    });

    it("should handle pagination in scan", async () => {
      mockRedis.scan
        .mockResolvedValueOnce(["100", ["circuit:api1.example.com"]])
        .mockResolvedValueOnce(["0", ["circuit:api2.example.com"]]);

      mockRedis.get
        .mockResolvedValueOnce(
          JSON.stringify({
            failures: 5,
            state: "open",
            openUntil: Date.now() + 30000,
          })
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            failures: 5,
            state: "open",
            openUntil: Date.now() + 30000,
          })
        );

      const result = await CircuitBreaker.getOpenCircuits();

      expect(result).toHaveLength(2);
    });
  });

  describe("Local Cache", () => {
    it("should use local cache for recent lookups", async () => {
      mockRedis.get.mockResolvedValueOnce(
        JSON.stringify({
          failures: 2,
          lastFailure: Date.now(),
          state: "closed",
          openUntil: 0,
        })
      );

      await CircuitBreaker.canRequest("https://api.example.com/webhook");
      expect(mockRedis.get).toHaveBeenCalledTimes(1);

      await CircuitBreaker.canRequest("https://api.example.com/webhook");
      expect(mockRedis.get).toHaveBeenCalledTimes(1);
    });
  });
});
