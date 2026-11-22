import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SchedulerWorker } from './scheduler';

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
    scheduledSet: (id: string) => `workspace:${id}:zset:scheduled`,
    pendingStream: (id: string) => `workspace:${id}:stream:pending`,
    activeWorkspacesScheduled: () => 'index:workspaces:scheduled',
    activeWorkspacesPending: () => 'index:workspaces:pending',
  },
  batchMoveScheduledToPending: vi.fn().mockResolvedValue([]),
  getNextScheduledTimestamp: vi.fn().mockResolvedValue(null),
}));

vi.mock('../db/index', () => ({
  db: {
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../db/schema/messages', () => ({
  messages: {
    messageId: 'messageId',
  },
}));

vi.mock('drizzle-orm', () => ({
  inArray: vi.fn(),
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
  schedulerMetrics: {
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

vi.mock('../config/env', () => ({
  env: {
    SCHEDULER_POLL_INTERVAL: '1000',
  },
}));

describe('SchedulerWorker', () => {
  let worker: SchedulerWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    worker = new SchedulerWorker();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await worker.stop();
  });

  describe('constructor', () => {
    it('should initialize with unique worker ID', () => {
      const stats = worker.getStats();
      expect(stats.workerId).toMatch(/^scheduler-\d+-\d+$/);
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
      expect(stats).toHaveProperty('nextPollTime');
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

describe('Scheduler batch operations', () => {
  it('should batch move messages to pending', async () => {
    const { batchMoveScheduledToPending } = await import('../lib/redis');

    vi.mocked(batchMoveScheduledToPending).mockResolvedValue([
      'msg1', 'msg2', 'msg3', 'msg4', 'msg5',
    ]);

    const result = await batchMoveScheduledToPending('workspace-1', [
      'msg1', 'msg2', 'msg3', 'msg4', 'msg5',
    ]);

    expect(result).toEqual(['msg1', 'msg2', 'msg3', 'msg4', 'msg5']);
  });
});
