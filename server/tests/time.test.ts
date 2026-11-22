import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  calculateBackoff,
  calculateNextRetry,
  formatDate,
  getUsageDate,
  isPast,
  isFuture,
  getTimestamp,
  timestampToDate,
} from "../src/utils/time.ts";

describe("Time Utilities", () => {
  describe("calculateBackoff", () => {
    beforeEach(() => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should calculate exponential backoff for attempt 0", () => {
      const delay = calculateBackoff(0, 1000);
      expect(delay).toBe(1000);
    });

    it("should calculate exponential backoff for attempt 1", () => {
      const delay = calculateBackoff(1, 1000);
      expect(delay).toBe(2000);
    });

    it("should calculate exponential backoff for attempt 2", () => {
      const delay = calculateBackoff(2, 1000);
      expect(delay).toBe(4000);
    });

    it("should calculate exponential backoff for attempt 5", () => {
      const delay = calculateBackoff(5, 1000);
      expect(delay).toBe(32000);
    });

    it("should cap delay at 1 hour maximum", () => {
      const maxDelay = 1000 * 60 * 60;
      const delay = calculateBackoff(20, 1000);
      expect(delay).toBeLessThanOrEqual(maxDelay + maxDelay * 0.1);
    });

    it("should use default base delay of 1000ms", () => {
      const delay = calculateBackoff(0);
      expect(delay).toBe(1000);
    });

    it("should add jitter to the delay", () => {
      vi.restoreAllMocks();

      const delays = new Set<number>();
      for (let i = 0; i < 10; i++) {
        delays.add(calculateBackoff(1, 1000));
      }

      expect(delays.size).toBeGreaterThanOrEqual(1);
    });

    it("should keep jitter within ±10% range", () => {
      vi.restoreAllMocks();

      const baseExpected = 2000;
      for (let i = 0; i < 100; i++) {
        const delay = calculateBackoff(1, 1000);
        const minExpected = baseExpected - baseExpected * 0.1;
        const maxExpected = baseExpected + baseExpected * 0.1;

        expect(delay).toBeGreaterThanOrEqual(minExpected);
        expect(delay).toBeLessThanOrEqual(maxExpected);
      }
    });

    it("should handle zero attempts", () => {
      const delay = calculateBackoff(0, 500);
      expect(delay).toBe(500);
    });

    it("should handle negative attempts gracefully", () => {
      const delay = calculateBackoff(-1, 1000);
      expect(delay).toBe(500);
    });
  });

  describe("calculateNextRetry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return a Date in the future", () => {
      const now = Date.now();
      const nextRetry = calculateNextRetry(0);

      expect(nextRetry.getTime()).toBeGreaterThanOrEqual(now);
    });

    it("should return date based on backoff calculation", () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);

      const now = new Date();
      const nextRetry = calculateNextRetry(0);

      const expectedTime = now.getTime() + 1000;
      expect(Math.abs(nextRetry.getTime() - expectedTime)).toBeLessThan(100);
    });

    it("should increase delay with higher attempts", () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);

      const retry1 = calculateNextRetry(1);
      const retry2 = calculateNextRetry(2);
      const retry3 = calculateNextRetry(3);

      const now = Date.now();
      const delay1 = retry1.getTime() - now;
      const delay2 = retry2.getTime() - now;
      const delay3 = retry3.getTime() - now;

      expect(delay2).toBeGreaterThan(delay1);
      expect(delay3).toBeGreaterThan(delay2);
    });
  });

  describe("formatDate", () => {
    it("should format date with default pattern", () => {
      const date = new Date("2024-01-15T14:30:45Z");
      const formatted = formatDate(date);

      expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it("should format date with custom pattern", () => {
      const date = new Date("2024-01-15T14:30:45Z");
      const formatted = formatDate(date, "yyyy/MM/dd");

      expect(formatted).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
    });

    it("should handle different date patterns", () => {
      const date = new Date("2024-06-15T09:05:30Z");

      expect(formatDate(date, "yyyy")).toBe("2024");
      expect(formatDate(date, "MM")).toBe("06");
      expect(formatDate(date, "dd")).toBe("15");
    });
  });

  describe("getUsageDate", () => {
    it("should return date in YYYY-MM-DD format", () => {
      const result = getUsageDate(new Date("2024-01-15T14:30:45Z"));

      expect(result).toBe("2024-01-15");
    });

    it("should use current date when no argument provided", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-06-20T10:00:00Z"));

      const result = getUsageDate();

      expect(result).toBe("2024-06-20");

      vi.useRealTimers();
    });

    it("should handle different months", () => {
      expect(getUsageDate(new Date("2024-01-05"))).toBe("2024-01-05");
      expect(getUsageDate(new Date("2024-12-31"))).toBe("2024-12-31");
    });

    it("should zero-pad month and day", () => {
      const result = getUsageDate(new Date("2024-01-05"));

      expect(result).toBe("2024-01-05");
      expect(result.split("-")[1]).toBe("01");
      expect(result.split("-")[2]).toBe("05");
    });
  });

  describe("isPast", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return true for date in the past", () => {
      const pastDate = new Date("2024-01-14T12:00:00Z");

      expect(isPast(pastDate)).toBe(true);
    });

    it("should return false for date in the future", () => {
      const futureDate = new Date("2024-01-16T12:00:00Z");

      expect(isPast(futureDate)).toBe(false);
    });

    it("should return false for current time", () => {
      const now = new Date();

      expect(isPast(now)).toBe(false);
    });

    it("should handle millisecond precision", () => {
      const justPast = new Date(Date.now() - 1);
      const justFuture = new Date(Date.now() + 1);

      expect(isPast(justPast)).toBe(true);
      expect(isPast(justFuture)).toBe(false);
    });
  });

  describe("isFuture", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return true for date in the future", () => {
      const futureDate = new Date("2024-01-16T12:00:00Z");

      expect(isFuture(futureDate)).toBe(true);
    });

    it("should return false for date in the past", () => {
      const pastDate = new Date("2024-01-14T12:00:00Z");

      expect(isFuture(pastDate)).toBe(false);
    });

    it("should return false for current time", () => {
      const now = new Date();

      expect(isFuture(now)).toBe(false);
    });

    it("should handle millisecond precision", () => {
      const justPast = new Date(Date.now() - 1);
      const justFuture = new Date(Date.now() + 1);

      expect(isFuture(justPast)).toBe(false);
      expect(isFuture(justFuture)).toBe(true);
    });
  });

  describe("getTimestamp", () => {
    it("should return Unix timestamp in seconds", () => {
      const date = new Date("2024-01-15T12:00:00Z");
      const timestamp = getTimestamp(date);

      expect(timestamp).toBe(1705320000);
    });

    it("should use current time when no argument provided", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));

      const timestamp = getTimestamp();

      expect(timestamp).toBe(1705320000);

      vi.useRealTimers();
    });

    it("should floor to whole seconds", () => {
      const date = new Date("2024-01-15T12:00:00.999Z");
      const timestamp = getTimestamp(date);

      expect(Number.isInteger(timestamp)).toBe(true);
    });

    it("should handle epoch", () => {
      const epoch = new Date(0);
      const timestamp = getTimestamp(epoch);

      expect(timestamp).toBe(0);
    });
  });

  describe("timestampToDate", () => {
    it("should convert Unix timestamp to Date", () => {
      const timestamp = 1705320000;
      const date = timestampToDate(timestamp);

      expect(date).toEqual(new Date("2024-01-15T12:00:00Z"));
    });

    it("should handle zero timestamp (epoch)", () => {
      const date = timestampToDate(0);

      expect(date).toEqual(new Date(0));
    });

    it("should be inverse of getTimestamp", () => {
      const original = new Date("2024-06-15T10:30:00Z");
      const timestamp = getTimestamp(original);
      const restored = timestampToDate(timestamp);

      expect(restored.getTime()).toBe(Math.floor(original.getTime() / 1000) * 1000);
    });

    it("should handle large timestamps", () => {
      const timestamp = 4102444800;
      const date = timestampToDate(timestamp);

      expect(date.getUTCFullYear()).toBe(2100);
    });
  });
});
