import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  calculateBackoff,
  calculateNextRetry,
  formatDate,
  getUsageDate,
  isPast,
  isFuture,
  getTimestamp,
  timestampToDate,
} from './time';

describe('Time Utilities', () => {
  describe('getTimestamp', () => {
    it('should convert Date to Unix timestamp in seconds', () => {
      const date = new Date('2024-01-01T00:00:00Z');
      const timestamp = getTimestamp(date);

      expect(timestamp).toBe(Math.floor(date.getTime() / 1000));
      expect(Number.isInteger(timestamp)).toBe(true);
    });

    it('should use current time when no date provided', () => {
      const now = Date.now();
      const timestamp = getTimestamp();

      expect(timestamp).toBeGreaterThanOrEqual(Math.floor(now / 1000));
      expect(timestamp).toBeLessThanOrEqual(Math.floor((now + 100) / 1000));
    });

    it('should handle dates in the future', () => {
      const futureDate = new Date(Date.now() + 3600000);
      const timestamp = getTimestamp(futureDate);

      expect(timestamp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  describe('timestampToDate', () => {
    it('should convert Unix timestamp to Date', () => {
      const timestamp = 1704067200;
      const date = timestampToDate(timestamp);

      expect(date).toBeInstanceOf(Date);
      expect(date.getTime()).toBe(timestamp * 1000);
    });

    it('should round-trip with getTimestamp', () => {
      const originalDate = new Date('2024-06-15T12:30:45Z');
      const timestamp = getTimestamp(originalDate);
      const reconstructedDate = timestampToDate(timestamp);

      expect(Math.abs(reconstructedDate.getTime() - originalDate.getTime())).toBeLessThan(1000);
    });
  });

  describe('calculateBackoff', () => {
    it('should calculate exponential backoff for attempts', () => {
      expect(calculateBackoff(0)).toBeGreaterThanOrEqual(800);
      expect(calculateBackoff(0)).toBeLessThanOrEqual(1200);

      expect(calculateBackoff(1)).toBeGreaterThanOrEqual(1600);
      expect(calculateBackoff(1)).toBeLessThanOrEqual(2400);

      expect(calculateBackoff(2)).toBeGreaterThanOrEqual(3200);
      expect(calculateBackoff(2)).toBeLessThanOrEqual(4800);
    });

    it('should cap at maximum delay of 1 hour', () => {
      const maxDelay = 1000 * 60 * 60;
      const result = calculateBackoff(20);

      expect(result).toBeLessThanOrEqual(maxDelay * 1.2);
    });

    it('should add random jitter', () => {
      const delays = Array.from({ length: 10 }, () => calculateBackoff(3));
      const uniqueDelays = new Set(delays);

      expect(uniqueDelays.size).toBeGreaterThan(1);
    });

    it('should use custom base delay', () => {
      const customBase = 500;
      const result = calculateBackoff(0, customBase);

      expect(result).toBeGreaterThanOrEqual(customBase * 0.8);
      expect(result).toBeLessThanOrEqual(customBase * 1.2);
    });
  });

  describe('calculateNextRetry', () => {
    it('should return future date for retry', () => {
      const now = new Date();
      const nextRetry = calculateNextRetry(1);

      expect(nextRetry.getTime()).toBeGreaterThan(now.getTime());
    });

    it('should increase delay with more attempts', () => {
      const retry1 = calculateNextRetry(1);
      const retry2 = calculateNextRetry(2);
      const retry3 = calculateNextRetry(3);

      const now = Date.now();
      expect(retry2.getTime() - now).toBeGreaterThan(retry1.getTime() - now);
      expect(retry3.getTime() - now).toBeGreaterThan(retry2.getTime() - now);
    });
  });

  describe('isPast and isFuture', () => {
    it('should correctly identify past dates', () => {
      const pastDate = new Date(Date.now() - 10000);
      expect(isPast(pastDate)).toBe(true);
      expect(isFuture(pastDate)).toBe(false);
    });

    it('should correctly identify future dates', () => {
      const futureDate = new Date(Date.now() + 10000);
      expect(isPast(futureDate)).toBe(false);
      expect(isFuture(futureDate)).toBe(true);
    });
  });

  describe('formatDate', () => {
    it('should format date with default pattern', () => {
      const date = new Date('2024-01-15T10:30:45Z');
      const formatted = formatDate(date);

      expect(formatted).toMatch(/2024-01-15/);
    });

    it('should format date with custom pattern', () => {
      const date = new Date('2024-01-15T10:30:45Z');
      const formatted = formatDate(date, 'yyyy-MM-dd');

      expect(formatted).toBe('2024-01-15');
    });
  });

  describe('getUsageDate', () => {
    it('should return date in YYYY-MM-DD format', () => {
      const date = new Date('2024-06-15T12:30:45Z');
      const usageDate = getUsageDate(date);

      expect(usageDate).toBe('2024-06-15');
    });

    it('should use current date when no date provided', () => {
      const usageDate = getUsageDate();

      expect(usageDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
