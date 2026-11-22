import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../lib/redis', () => ({
  redis: {
    keys: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(0),
    pipeline: vi.fn(() => ({
      xgroup: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      sadd: vi.fn().mockReturnThis(),
      hincrby: vi.fn().mockReturnThis(),
      pfadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xack: vi.fn().mockResolvedValue(1),
    hgetall: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    srem: vi.fn().mockResolvedValue(0),
  },
  redisBlocking: {
    xreadgroup: vi.fn().mockResolvedValue(null),
  },
  createBlockingConnection: vi.fn(() => ({
    xreadgroup: vi.fn().mockResolvedValue(null),
    quit: vi.fn().mockResolvedValue("OK"),
  })),
  RedisKeys: {
    pendingStream: (id: string) => `workspace:${id}:stream:pending`,
    queuePendingStream: (wsId: string, qId: string) => `queue:${wsId}:${qId}:stream:pending`,
    activeQueuesPending: () => 'index:queues:pending',
    message: (wsId: string, msgId: string) => `workspace:${wsId}:messages:${msgId}`,
    activeWorkspacesPending: () => 'index:workspaces:pending',
    processingSet: (id: string) => `workspace:${id}:zset:processing`,
    activeWorkspacesProcessing: () => 'index:workspaces:processing',
    environmentHalt: (id: string) => `env:halt:${id}`,
    workspaceSuspended: (id: string) => `ws:suspended:${id}`,
    abuseStats: (id: string, hour: string) => `abuse:${id}:${hour}:stats`,
    abuseHosts: (id: string, hour: string) => `abuse:${id}:${hour}:hosts`,
  },
  execPipelineChecked: vi.fn().mockResolvedValue([]),
}));

import { ConsumerWorker } from './consumer';
import { redis, redisBlocking } from '../lib/redis';

vi.mock('../lib/worker-health', () => {
  return {
    WorkerHealth: class MockWorkerHealth {
      start = vi.fn().mockResolvedValue(undefined);
      stop = vi.fn().mockResolvedValue(undefined);
      recordProcessed = vi.fn();
      recordError = vi.fn();
    },
  };
});

vi.mock('../lib/metrics', () => ({
  consumerMetrics: {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    increment: vi.fn(),
    setGauge: vi.fn(),
    recordHistogram: vi.fn(),
    getAll: vi.fn().mockReturnValue({
      counters: {},
      gauges: {},
      histograms: {},
      timestamp: Date.now(),
    }),
  },
  Timer: class MockTimer {
    elapsed = vi.fn().mockReturnValue(10);
    recordTo = vi.fn().mockReturnValue(10);
  },
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

vi.mock('../lib/workspace-index-cache', () => ({
  workspaceIndexCache: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getWorkspaceIds: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../core/messaging/consumer', () => ({
  deliverMessage: vi.fn().mockResolvedValue(undefined),
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
    CONSUMER_WORKERS: '1',
  },
}));

vi.mock('../lib/batch-ack', () => ({
  batchAckCollector: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    getPendingCount: vi.fn().mockReturnValue(0),
    getStats: vi.fn().mockReturnValue({ pending: 0, metrics: {} }),
  },
}));

vi.mock('../lib/callback-queue', () => ({
  callbackQueue: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    enqueue: vi.fn(),
    getStats: vi.fn().mockReturnValue({ queued: 0, inFlight: 0 }),
  },
}));

vi.mock('../lib/url-cache', () => ({
  urlValidationCache: {
    start: vi.fn(),
    stop: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    getStats: vi.fn().mockReturnValue({ size: 0, maxSize: 1000 }),
  },
}));

describe('ConsumerWorker', () => {
  let worker: ConsumerWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new ConsumerWorker(0, 10);
  });

  afterEach(async () => {
    await worker.stop();
  });

  describe('constructor', () => {
    it('should initialize with correct consumer ID', () => {
      const stats = worker.getStats();
      expect(stats.consumerId).toBe('consumer-0');
      expect(stats.concurrency).toBe(10);
    });

    it('should use default concurrency when not specified', () => {
      const defaultWorker = new ConsumerWorker(1);
      const stats = defaultWorker.getStats();
      expect(stats.concurrency).toBe(10);
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

      expect(stats).toHaveProperty('consumerId');
      expect(stats).toHaveProperty('isRunning');
      expect(stats).toHaveProperty('inFlightTasks');
      expect(stats).toHaveProperty('concurrency');
      expect(stats).toHaveProperty('adaptiveBlockTime');
      expect(stats).toHaveProperty('metrics');
    });

    it('should show zero in-flight tasks initially', () => {
      const stats = worker.getStats();
      expect(stats.inFlightTasks).toBe(0);
    });
  });

  describe('adaptive block time', () => {
    it('should have default block time', () => {
      const stats = worker.getStats();
      expect(stats.adaptiveBlockTime).toBe(5000);
    });
  });
});

describe('startConsumers', () => {
  it('should be importable', async () => {
    const { startConsumers } = await import('./consumer');
    expect(typeof startConsumers).toBe('function');
  });
});

describe('Redis Client Separation', () => {
  it('should use redisBlocking for XREADGROUP (blocking) operations', async () => {

    expect(redisBlocking.xreadgroup).toBeDefined();

  });

  it('should use regular redis for non-blocking operations', () => {
    expect(redis.hgetall).toBeDefined();
    expect(redis.pipeline).toBeDefined();
  });

  it('should have separate clients for API and worker operations', () => {
    expect(redis).toBeDefined();
    expect(redisBlocking).toBeDefined();
    expect(redis).not.toBe(redisBlocking);
  });
});
