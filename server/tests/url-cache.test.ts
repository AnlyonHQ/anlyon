import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/logger.ts", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { UrlValidationCache, MessageDataCache } from "../src/lib/url-cache.ts";

describe("UrlValidationCache", () => {
  let cache: UrlValidationCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new UrlValidationCache(1000, 1000, 100);
  });

  afterEach(() => {
    cache.stop();
    vi.useRealTimers();
  });

  describe("set and get", () => {
    it("should not cache valid URLs", () => {
      cache.set("https://example.com", true);

      const result = cache.get("https://example.com");

      expect(result).toBeNull();
    });

    it("should store and retrieve invalid URL with error", () => {
      cache.set("https://invalid.com", false, "DNS resolution failed");

      const result = cache.get("https://invalid.com");

      expect(result).not.toBeNull();
      expect(result?.valid).toBe(false);
      expect(result?.error).toBe("DNS resolution failed");
    });

    it("should not store resolved IPs for valid URLs", () => {
      cache.set("https://example.com", true, undefined, "93.184.216.34");

      const result = cache.get("https://example.com");

      expect(result).toBeNull();
    });

    it("should return null for non-existent URL", () => {
      const result = cache.get("https://notcached.com");

      expect(result).toBeNull();
    });
  });

  describe("TTL expiration", () => {
    it("should expire entries after TTL", () => {
      cache.set("https://example.com", true);

      vi.advanceTimersByTime(1100);

      const result = cache.get("https://example.com");

      expect(result).toBeNull();
    });

    it("should return negative entry before TTL expires", () => {
      cache.set("https://example.com", false, "blocked");

      vi.advanceTimersByTime(500);

      const result = cache.get("https://example.com");

      expect(result).not.toBeNull();
    });
  });

  describe("max size eviction", () => {
    it("should evict oldest negative entry when max size reached", () => {
      const smallCache = new UrlValidationCache(10000, 10000, 3);

      smallCache.set("https://first.com", false, "blocked");
      smallCache.set("https://second.com", false, "blocked");
      smallCache.set("https://third.com", false, "blocked");
      smallCache.set("https://fourth.com", false, "blocked");

      expect(smallCache.get("https://first.com")).toBeNull();
      expect(smallCache.get("https://second.com")).not.toBeNull();
      expect(smallCache.get("https://fourth.com")).not.toBeNull();

      smallCache.stop();
    });
  });

  describe("invalidate", () => {
    it("should remove entry from cache", () => {
      cache.set("https://example.com", true);

      cache.invalidate("https://example.com");

      expect(cache.get("https://example.com")).toBeNull();
    });

    it("should handle invalidating non-existent entry", () => {
      expect(() => cache.invalidate("https://notcached.com")).not.toThrow();
    });
  });

  describe("cleanup", () => {
    it("should remove expired entries during cleanup", () => {
      cache.start();

      cache.set("https://example.com", true);

      vi.advanceTimersByTime(1100);

      vi.advanceTimersByTime(60000);

      expect(cache.getStats().size).toBe(0);
    });
  });

  describe("getStats", () => {
    it("should return correct stats", () => {
      cache.set("https://example1.com", false, "blocked");
      cache.set("https://example2.com", false, "blocked");

      const stats = cache.getStats();

      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(100);
    });
  });
});

describe("MessageDataCache", () => {
  let cache: MessageDataCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new MessageDataCache(1000, 100);
  });

  afterEach(() => {
    cache.clear();
    vi.useRealTimers();
  });

  describe("set and get", () => {
    it("should store and retrieve parsed data", () => {
      const headers = { "Content-Type": "application/json" };
      const body = { key: "value" };

      cache.set("msg-1", headers, body);

      const result = cache.get("msg-1");

      expect(result).not.toBeNull();
      expect(result?.headers).toEqual(headers);
      expect(result?.body).toEqual(body);
    });

    it("should return null for non-existent message", () => {
      const result = cache.get("msg-nonexistent");

      expect(result).toBeNull();
    });

    it("should handle null body", () => {
      const headers = { "X-Custom": "header" };

      cache.set("msg-1", headers, null);

      const result = cache.get("msg-1");

      expect(result?.body).toBeNull();
    });
  });

  describe("TTL expiration", () => {
    it("should expire entries after TTL", () => {
      cache.set("msg-1", {}, { data: "test" });

      vi.advanceTimersByTime(1100);

      const result = cache.get("msg-1");

      expect(result).toBeNull();
    });
  });

  describe("remove", () => {
    it("should remove entry from cache", () => {
      cache.set("msg-1", {}, { data: "test" });

      cache.remove("msg-1");

      expect(cache.get("msg-1")).toBeNull();
    });
  });

  describe("clear", () => {
    it("should remove all entries", () => {
      cache.set("msg-1", {}, { data: "1" });
      cache.set("msg-2", {}, { data: "2" });
      cache.set("msg-3", {}, { data: "3" });

      cache.clear();

      expect(cache.get("msg-1")).toBeNull();
      expect(cache.get("msg-2")).toBeNull();
      expect(cache.get("msg-3")).toBeNull();
    });
  });

  describe("max size eviction", () => {
    it("should evict oldest entry when max size reached", () => {
      const smallCache = new MessageDataCache(10000, 2);

      smallCache.set("msg-1", {}, { data: "1" });
      smallCache.set("msg-2", {}, { data: "2" });
      smallCache.set("msg-3", {}, { data: "3" });

      expect(smallCache.get("msg-1")).toBeNull();
      expect(smallCache.get("msg-2")).not.toBeNull();
      expect(smallCache.get("msg-3")).not.toBeNull();
    });
  });
});
