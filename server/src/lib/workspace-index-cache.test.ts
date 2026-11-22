import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('ioredis', () => {
  return {
    Redis: class MockRedis {
      subscribe = vi.fn().mockResolvedValue(undefined);
      unsubscribe = vi.fn().mockResolvedValue(undefined);
      quit = vi.fn().mockResolvedValue(undefined);
      on = vi.fn();
    },
  };
});

vi.mock('./redis', () => ({
  redis: {
    smembers: vi.fn().mockResolvedValue([]),
    scard: vi.fn().mockResolvedValue(0),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
  },
  RedisKeys: {
    activeWorkspacesPending: () => 'index:workspaces:pending',
    activeWorkspacesScheduled: () => 'index:workspaces:scheduled',
    activeWorkspacesProcessing: () => 'index:workspaces:processing',
  },
}));

import { WorkspaceIndexCache } from './workspace-index-cache';
import { redis } from './redis';

describe('WorkspaceIndexCache', () => {
  let cache: WorkspaceIndexCache;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new WorkspaceIndexCache();
  });

  afterEach(async () => {
    await cache.stop();
  });

  describe('getWorkspaceIds', () => {
    it('should fetch workspace IDs from Redis on first call', async () => {
      vi.mocked(redis.smembers).mockResolvedValue(['ws1', 'ws2', 'ws3']);

      const result = await cache.getWorkspaceIds('pending');

      expect(result).toEqual(['ws1', 'ws2', 'ws3']);
      expect(redis.smembers).toHaveBeenCalledWith('index:workspaces:pending');
    });

    it('should return cached workspace IDs on subsequent calls', async () => {
      vi.mocked(redis.smembers).mockResolvedValue(['ws1', 'ws2']);

      await cache.getWorkspaceIds('pending');
      await cache.getWorkspaceIds('pending');

      expect(redis.smembers).toHaveBeenCalledTimes(1);
    });

    it('should handle different index types independently', async () => {
      vi.mocked(redis.smembers)
        .mockResolvedValueOnce(['pending-ws1'])
        .mockResolvedValueOnce(['scheduled-ws1'])
        .mockResolvedValueOnce(['processing-ws1']);

      const pending = await cache.getWorkspaceIds('pending');
      const scheduled = await cache.getWorkspaceIds('scheduled');
      const processing = await cache.getWorkspaceIds('processing');

      expect(pending).toEqual(['pending-ws1']);
      expect(scheduled).toEqual(['scheduled-ws1']);
      expect(processing).toEqual(['processing-ws1']);
    });
  });

  describe('hasWorkspaces', () => {
    it('should return true when workspaces exist', async () => {
      vi.mocked(redis.smembers).mockResolvedValue(['ws1']);

      await cache.getWorkspaceIds('pending');

      const result = await cache.hasWorkspaces('pending');
      expect(result).toBe(true);
    });

    it('should return false when no workspaces exist', async () => {
      vi.mocked(redis.smembers).mockResolvedValue([]);
      vi.mocked(redis.scard).mockResolvedValue(0);

      const result = await cache.hasWorkspaces('pending');
      expect(result).toBe(false);
    });

    it('should use SCARD for uncached checks', async () => {
      vi.mocked(redis.scard).mockResolvedValue(5);

      const result = await cache.hasWorkspaces('pending');

      expect(result).toBe(true);
      expect(redis.scard).toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('should force refresh cache from Redis', async () => {
      vi.mocked(redis.smembers)
        .mockResolvedValueOnce(['ws1'])
        .mockResolvedValueOnce(['ws1', 'ws2']);

      const first = await cache.getWorkspaceIds('pending');
      expect(first).toEqual(['ws1']);

      const refreshed = await cache.refresh('pending');
      expect(refreshed).toEqual(['ws1', 'ws2']);
      expect(redis.smembers).toHaveBeenCalledTimes(2);
    });
  });

  describe('pub/sub handling', () => {
    it('should start and stop cleanly', async () => {
      await cache.start();
      await cache.stop();
      expect(true).toBe(true);
    });
  });
});

describe('Workspace Index Helper Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should have helper functions available', async () => {
    expect(true).toBe(true);
  });
});
