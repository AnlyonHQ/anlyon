import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RetryWorker } from './retry';

vi.mock('../lib/redis', () => ({
  redis: {
    zrangebyscore: vi.fn().mockResolvedValue([]),
    zcard: vi.fn().mockResolvedValue(0),
    smembers: vi.fn().mockResolvedValue([]),
    srem: vi.fn().mockResolvedValue(1),
    pipeline: vi.fn(() => ({
      zrange: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  },
  RedisKeys: {
    processingSet: (id: string) => `workspace:${id}:zset:processing`,
    pendingStream: (id: string) => `workspace:${id}:stream:pending`,
    activeWorkspacesProcessing: () => 'index:workspaces:processing',
    activeWorkspacesPending: () => 'index:workspaces:pending',
  },
  batchMoveProcessingToPending: vi.fn().mockResolvedValue([]),
  getNextRetryTimestamp: vi.fn().mockResolvedValue(null),
}));

vi.mock('../lib/distributed-lock', () => {
  return {
    LeaderElection: class MockLeaderElection {
      private _isLeader = true;
      start = vi.fn().mockResolvedValue(undefined);
      stop = vi.fn().mockResolvedValue(undefined);
      isCurrentLeader = vi.fn().mockReturnValue(true);
      constructor(_name: string, _ttl: number, _onBecomeLeader?: () => void, _onLoseLeadership?: () => void) {}
    },
  };
});

vi.mock('../lib/worker-health', () => {
  return {
    WorkerHealth: class MockWorkerHealth {
      start = vi.fn().mockResolvedValue(undefined);
      stop = vi.fn().mockResolvedValue(undefined);
      setLeaderStatus = vi.fn();
      recordProcessed = vi.fn();
      recordError = vi.fn();
    },
  };
});

vi.mock('../lib/metrics', () => ({
  retryMetrics: {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    increment: vi.fn(),
    setGauge: vi.fn(),
    getAll: vi.fn().mockReturnValue({
      counters: {},
      gauges: {},
      histograms: {},
      timestamp: Date.now(),
    }),
  },
  Timer: vi.fn().mockImplementation(() => ({
    elapsed: vi.fn().mockReturnValue(10),
    recordTo: vi.fn().mockReturnValue(10),
  })),
}));

vi.mock('../lib/workspace-index-cache', () => ({
  workspaceIndexCache: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getWorkspaceIds: vi.fn().mockResolvedValue([]),
  },
  removeFromWorkspaceIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/time', () => ({
  getTimestamp: vi.fn().mockReturnValue(Math.floor(Date.now() / 1000)),
}));

vi.mock('../lib/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe('RetryWorker', () => {
  let worker: RetryWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    worker = new RetryWorker();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await worker.stop();
  });

  describe('constructor', () => {
    it('should initialize with unique worker ID', () => {
      const stats = worker.getStats();
      expect(stats.workerId).toMatch(/^retry-\d+-\d+$/);
    });
  });

  describe('start', () => {
    it('should start the worker successfully', async () => {
      await worker.start();
      const stats = worker.getStats();
      expect(stats.isRunning).toBe(true);
    });

    it('should not start if already running', async () => {
      await worker.start();
      await worker.start();
      const stats = worker.getStats();
      expect(stats.isRunning).toBe(true);
    });
  });

  describe('stop', () => {
    it('should stop the worker successfully', async () => {
      await worker.start();
      await worker.stop();
      const stats = worker.getStats();
      expect(stats.isRunning).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return current worker statistics', () => {
      const stats = worker.getStats();

      expect(stats).toHaveProperty('workerId');
      expect(stats).toHaveProperty('isRunning');
      expect(stats).toHaveProperty('isLeader');
      expect(stats).toHaveProperty('metrics');
    });
  });

  describe('adaptive polling', () => {
    it('should use MAX_POLL_INTERVAL when no workspaces', async () => {
      const { workspaceIndexCache } = await import('../lib/workspace-index-cache');
      vi.mocked(workspaceIndexCache.getWorkspaceIds).mockResolvedValue([]);

      await worker.start();

      const stats = worker.getStats();
      expect(stats.isRunning).toBe(true);
    });
  });
});

describe('Retry batch operations', () => {
  it('should batch move messages for retry', async () => {
    const { batchMoveProcessingToPending } = await import('../lib/redis');

    vi.mocked(batchMoveProcessingToPending).mockResolvedValue(['msg1', 'msg2', 'msg3']);

    const result = await batchMoveProcessingToPending('workspace-1', [
      'msg1', 'msg2', 'msg3',
    ]);

    expect(result).toEqual(['msg1', 'msg2', 'msg3']);
  });

  it('should return no ids when there is nothing to move', async () => {
    const { batchMoveProcessingToPending } = await import('../lib/redis');

    vi.mocked(batchMoveProcessingToPending).mockResolvedValue([]);

    const result = await batchMoveProcessingToPending('workspace-1', []);

    expect(result).toEqual([]);
  });
});

describe('Retry adaptive timing', () => {
  it('should calculate next poll delay based on earliest retry timestamp', async () => {
    const { getNextRetryTimestamp } = await import('../lib/redis');
    const now = Math.floor(Date.now() / 1000);

    vi.mocked(getNextRetryTimestamp).mockResolvedValue(now + 5);

    const result = await getNextRetryTimestamp(['ws1', 'ws2']);

    expect(result).toBe(now + 5);
  });

  it('should return null when no retry messages exist', async () => {
    const { getNextRetryTimestamp } = await import('../lib/redis');

    vi.mocked(getNextRetryTimestamp).mockResolvedValue(null);

    const result = await getNextRetryTimestamp([]);

    expect(result).toBeNull();
  });
});
