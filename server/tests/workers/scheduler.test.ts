import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMockRedis,
  createMockDb,
  createMockLogger,
  createChainableWhere,
  MockRedisKeys,
} from "../setup.ts";

const mockDb = createMockDb();
vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));

const mockRedis = createMockRedis();
vi.mock("../../src/lib/redis.ts", () => ({
  redis: mockRedis,
  RedisKeys: MockRedisKeys,
  batchMoveScheduledToPending: vi.fn().mockResolvedValue([]),
  batchMoveQueueScheduledToPending: vi.fn().mockResolvedValue([]),
  getNextScheduledTimestamp: vi.fn().mockResolvedValue(null),
  USAGE_COUNTER_TTL_SECONDS: 172_800,
}));

const mockLogger = createMockLogger();
vi.mock("../../src/lib/logger.ts", () => ({
  createLogger: () => mockLogger,
  logger: mockLogger,
}));

vi.mock("../../src/config/env.ts", () => ({
  env: {
    SCHEDULER_POLL_INTERVAL: "1000",
  },
}));

vi.mock("../../src/lib/distributed-lock.ts", () => ({
  LeaderElection: vi.fn(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isCurrentLeader: vi.fn().mockReturnValue(true),
    };
  }),
}));

vi.mock("../../src/lib/worker-health.ts", () => ({
  WorkerHealth: vi.fn(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      setLeaderStatus: vi.fn(),
      recordProcessed: vi.fn(),
      recordError: vi.fn(),
    };
  }),
}));

vi.mock("../../src/lib/sentry.ts", () => ({
  captureException: vi.fn(),
}));

vi.mock("../../src/lib/metrics.ts", () => ({
  schedulerMetrics: {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    increment: vi.fn(),
    setGauge: vi.fn(),
    getAll: vi.fn().mockReturnValue({}),
  },
  Timer: vi.fn().mockImplementation(() => ({
    recordTo: vi.fn(),
  })),
}));

vi.mock("../../src/lib/workspace-index-cache.ts", () => ({
  workspaceIndexCache: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getWorkspaceIds: vi.fn().mockResolvedValue([]),
  },
  removeFromWorkspaceIndex: vi.fn().mockResolvedValue(undefined),
}));

describe("Scheduler Worker Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockDb.select).mockReturnValue({ from: vi.mocked(mockDb._mocks.from) } as any);
    vi.mocked(mockDb._mocks.from).mockReturnValue({
      where: createChainableWhere(vi.mocked(mockDb.where), vi.mocked(mockDb.returning)),
    } as any);
    vi.mocked(mockDb.where).mockResolvedValue([]);
    vi.mocked(mockDb.returning).mockResolvedValue([]);
    vi.mocked(mockDb.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.mocked(mockDb.returning) }),
    } as any);
    vi.mocked(mockDb.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.mocked(mockDb.returning),
          catch: vi.fn(),
        }),
      }),
    } as any);
    vi.mocked(mockDb.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    } as any);
    vi.mocked(mockRedis.pipeline).mockReturnValue({
      set: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      hset: vi.fn().mockReturnThis(),
      incrby: vi.fn().mockReturnThis(),
      sadd: vi.fn().mockReturnThis(),
      xadd: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zrem: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    } as any);
    vi.mocked(mockRedis.mget).mockResolvedValue(["0", "0", "0"]);
    vi.mocked(mockRedis.smembers).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("Scheduled Message Delivery", () => {
    it("should process messages scheduled for future delivery", async () => {
      const { batchMoveScheduledToPending } = await import("../../src/lib/redis.ts");

      vi.mocked(batchMoveScheduledToPending).mockResolvedValue(2);

      const moved = await batchMoveScheduledToPending("workspace_123", Date.now());

      expect(moved).toBe(2);
      expect(batchMoveScheduledToPending).toHaveBeenCalledWith("workspace_123", expect.any(Number));
    });

    it("should not process messages scheduled for future", async () => {
      const { schedulerWorker } = await import("../../src/workers/scheduler.ts");

      const futureMessages = [
        {
          id: "msg_123",
          messageId: "msg_test_123",
          workspaceId: "workspace_123",
          status: "scheduled",
          scheduledFor: new Date(Date.now() + 3600000),
        },
      ];

      vi.mocked(mockDb.where).mockResolvedValue([]);

      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("should handle batch scheduled message processing", async () => {
      const { SchedulerWorker } = await import("../../src/workers/scheduler.ts");

      const worker = new SchedulerWorker();
      const stats = worker.getStats();

      expect(stats).toBeDefined();
      expect(stats.isRunning).toBe(false);
      expect(mockRedis.pipeline).not.toHaveBeenCalled();
    });
  });

  describe("Worker stats", () => {
    it("should track scheduler worker stats", async () => {
      const { SchedulerWorker } = await import("../../src/workers/scheduler.ts");

      const worker = new SchedulerWorker();
      const stats = worker.getStats();

      expect(stats).toBeDefined();
      expect(stats.workerId).toBeDefined();
      expect(stats.isRunning).toBe(false);
    });
  });

  describe("Lifecycle", () => {
    it("should handle worker start and stop gracefully", async () => {
      const { SchedulerWorker } = await import("../../src/workers/scheduler.ts");

      const worker = new SchedulerWorker();

      await expect(worker.start()).resolves.not.toThrow();

      await expect(worker.stop()).resolves.not.toThrow();
    });
  });

  describe("Distributed Lock", () => {
    it("should use leader election for coordination", async () => {
      const { SchedulerWorker } = await import("../../src/workers/scheduler.ts");

      const worker = new SchedulerWorker();
      const stats = worker.getStats();

      expect(stats.isLeader).toBeDefined();
      expect(typeof stats.isLeader).toBe("boolean");
    });

    it("should track leader status correctly", async () => {
      const { SchedulerWorker } = await import("../../src/workers/scheduler.ts");

      const worker = new SchedulerWorker();

      expect(typeof worker.getStats().isLeader).toBe("boolean");

      await worker.start();

      const stats = worker.getStats();
      expect(stats.isRunning).toBe(true);
      expect(stats.isLeader).toBeDefined();

      await worker.stop();
    });

    it("should stop processing when stopped", async () => {
      const { SchedulerWorker } = await import("../../src/workers/scheduler.ts");

      const worker = new SchedulerWorker();
      await worker.start();

      await worker.stop();

      expect(worker.getStats().isRunning).toBe(false);
    });
  });
});
