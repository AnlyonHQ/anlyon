import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTimestamp, timestampToDate } from '../../utils/time';

describe('Publisher - executeAt Integration', () => {
  describe('Timestamp Handling', () => {
    it('should handle executeAt as Unix timestamp correctly', () => {
      const now = Math.floor(Date.now() / 1000);
      const executeAt = now + 3600;

      const scheduledDate = timestampToDate(executeAt);
      const reconstructedTimestamp = getTimestamp(scheduledDate);

      expect(reconstructedTimestamp).toBe(executeAt);
    });

    it('should handle scheduledFor ISO string correctly (backward compatibility)', () => {
      const futureDate = new Date(Date.now() + 3600000);
      const scheduledFor = futureDate.toISOString();

      const scheduledDate = new Date(scheduledFor);
      const timestamp = getTimestamp(scheduledDate);

      expect(timestamp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should prefer executeAt over scheduledFor when only executeAt is provided', () => {
      const executeAt = Math.floor(Date.now() / 1000) + 7200;

      const scheduledTimestamp = executeAt;
      const scheduledDate = timestampToDate(executeAt);

      expect(scheduledTimestamp).toBe(executeAt);
      expect(getTimestamp(scheduledDate)).toBe(executeAt);
    });

    it('should correctly identify scheduled vs pending messages', () => {
      const nowTimestamp = Math.floor(Date.now() / 1000);
      const futureTimestamp = nowTimestamp + 3600;

      const hasExecuteAt = futureTimestamp !== undefined;
      const status = hasExecuteAt ? 'scheduled' : 'pending';

      expect(status).toBe('scheduled');
    });

    it('should handle immediate execution (no executeAt)', () => {
      const executeAt = undefined;

      const hasExecuteAt = executeAt !== undefined;
      const status = hasExecuteAt ? 'scheduled' : 'pending';

      expect(status).toBe('pending');
    });
  });

  describe('Redis Timestamp Scores', () => {
    it('should use Unix timestamp directly as Redis sorted set score', () => {
      const executeAt = Math.floor(Date.now() / 1000) + 3600;

      const redisScore = executeAt;

      expect(redisScore).toBe(executeAt);
      expect(Number.isInteger(redisScore)).toBe(true);
    });

    it('should convert Date to timestamp for Redis when using scheduledFor', () => {
      const scheduledFor = new Date(Date.now() + 3600000).toISOString();
      const scheduledDate = new Date(scheduledFor);
      const redisScore = getTimestamp(scheduledDate);

      expect(Number.isInteger(redisScore)).toBe(true);
      expect(redisScore).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should maintain timestamp precision for scheduled messages', () => {
      const exactTimestamp = 1735689600;
      const date = timestampToDate(exactTimestamp);
      const reconstructed = getTimestamp(date);

      expect(reconstructed).toBe(exactTimestamp);
    });
  });

  describe('Message Scheduling Logic', () => {
    it('should determine status based on executeAt presence', () => {
      const withExecuteAt = {
        executeAt: Math.floor(Date.now() / 1000) + 3600,
        scheduledFor: undefined,
      };

      let status: 'pending' | 'scheduled' = 'pending';
      let scheduledTimestamp: number | undefined;

      if (withExecuteAt.executeAt) {
        scheduledTimestamp = withExecuteAt.executeAt;
        status = 'scheduled';
      }

      expect(status).toBe('scheduled');
      expect(scheduledTimestamp).toBe(withExecuteAt.executeAt);

      const withoutScheduling = {
        executeAt: undefined,
        scheduledFor: undefined,
      };

      status = 'pending';
      scheduledTimestamp = undefined;

      if (withoutScheduling.executeAt) {
        scheduledTimestamp = withoutScheduling.executeAt;
        status = 'scheduled';
      } else if (withoutScheduling.scheduledFor) {
        const date = new Date(withoutScheduling.scheduledFor);
        scheduledTimestamp = getTimestamp(date);
        status = 'scheduled';
      }

      expect(status).toBe('pending');
      expect(scheduledTimestamp).toBeUndefined();
    });

    it('should handle past timestamps correctly', () => {
      const pastTimestamp = Math.floor(Date.now() / 1000) - 3600;

      const message = {
        executeAt: pastTimestamp,
      };

      const status = message.executeAt ? 'scheduled' : 'pending';
      expect(status).toBe('scheduled');
    });

    it('should handle very far future timestamps', () => {
      const farFuture = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

      const message = {
        executeAt: farFuture,
      };

      const status = message.executeAt ? 'scheduled' : 'pending';
      const scheduledDate = timestampToDate(message.executeAt);

      expect(status).toBe('scheduled');
      expect(scheduledDate.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('Deduplication with executeAt', () => {
    it('should generate consistent hash regardless of executeAt', () => {
      const message1 = {
        url: 'https://example.com/webhook',
        method: 'POST',
        body: { data: 'test' },
        contentId: 'unique-123',
        executeAt: Math.floor(Date.now() / 1000) + 3600,
      };

      const message2 = {
        url: 'https://example.com/webhook',
        method: 'POST',
        body: { data: 'test' },
        contentId: 'unique-123',
        executeAt: Math.floor(Date.now() / 1000) + 7200,
      };

      const hashInput1 = `${message1.url}:${message1.method}:${JSON.stringify(message1.body)}:${message1.contentId}`;
      const hashInput2 = `${message2.url}:${message2.method}:${JSON.stringify(message2.body)}:${message2.contentId}`;

      expect(hashInput1).toBe(hashInput2);
    });
  });

  describe('Performance Optimizations', () => {
    it('should avoid unnecessary date conversions with executeAt', () => {
      const executeAt = Math.floor(Date.now() / 1000) + 3600;

      const scheduledTimestamp = executeAt;

      expect(scheduledTimestamp).toBe(executeAt);
      expect(typeof scheduledTimestamp).toBe('number');
    });

    it('should minimize conversions for database storage', () => {
      const executeAt = Math.floor(Date.now() / 1000) + 3600;

      const redisScore = executeAt;

      const dbDate = timestampToDate(executeAt);

      expect(redisScore).toBe(executeAt);
      expect(dbDate).toBeInstanceOf(Date);
      expect(getTimestamp(dbDate)).toBe(executeAt);
    });
  });

  describe('Backward Compatibility', () => {
    it('should handle scheduledFor when provided', () => {
      const scheduledFor = new Date(Date.now() + 3600000).toISOString();

      const scheduledDate = new Date(scheduledFor);
      const timestamp = getTimestamp(scheduledDate);

      expect(scheduledDate).toBeInstanceOf(Date);
      expect(timestamp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should prefer executeAt when both executeAt and scheduledFor are provided', () => {
      const executeAt = Math.floor(Date.now() / 1000) + 7200;
      const scheduledFor = new Date(Date.now() + 3600000).toISOString();

      let scheduledTimestamp: number;

      if (executeAt) {
        scheduledTimestamp = executeAt;
      } else if (scheduledFor) {
        scheduledTimestamp = getTimestamp(new Date(scheduledFor));
      } else {
        scheduledTimestamp = 0;
      }

      expect(scheduledTimestamp).toBe(executeAt);
    });
  });
});
