import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/redis.ts", () => ({
  redis: {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    eval: vi.fn(),
  },
  RedisKeys: {
    workerLock: (name: string) => `lock:worker:${name}`,
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

import { DistributedLock, withLock, LeaderElection } from "../src/lib/distributed-lock.ts";
import { redis } from "../src/lib/redis.ts";

const mockRedis = redis as unknown as {
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
};

describe("DistributedLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("acquire", () => {
    it("should acquire lock successfully", async () => {
      mockRedis.set.mockResolvedValue("OK");

      const lock = new DistributedLock("test-lock", 30000);
      const acquired = await lock.acquire();

      expect(acquired).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        "lock:worker:test-lock",
        expect.any(String),
        "PX",
        30000,
        "NX"
      );
    });

    it("should fail to acquire lock when already held", async () => {
      mockRedis.set.mockResolvedValue(null);

      const lock = new DistributedLock("test-lock");
      const acquired = await lock.acquire();

      expect(acquired).toBe(false);
    });

    it("should use unique lock ID", async () => {
      mockRedis.set.mockResolvedValue("OK");

      const lock1 = new DistributedLock("test-lock");
      const lock2 = new DistributedLock("test-lock");

      await lock1.acquire();
      await lock2.acquire();

      const lock1Id = mockRedis.set.mock.calls[0][1];
      const lock2Id = mockRedis.set.mock.calls[1][1];

      expect(lock1Id).not.toBe(lock2Id);
    });

    it("should start renewal after acquiring lock", async () => {
      mockRedis.set.mockResolvedValue("OK");
      mockRedis.eval.mockResolvedValue(1);

      const lock = new DistributedLock("test-lock", 30000);
      await lock.acquire();

      mockRedis.eval.mockClear();

      await vi.advanceTimersByTimeAsync(10001);

      await lock.release();

      expect(mockRedis.eval).toHaveBeenCalled();
    });
  });

  describe("release", () => {
    it("should release lock when owned", async () => {
      mockRedis.set.mockResolvedValue("OK");
      mockRedis.eval.mockResolvedValue(1);

      const lock = new DistributedLock("test-lock");
      await lock.acquire();
      const released = await lock.release();

      expect(released).toBe(true);
      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it("should fail to release lock when not owned", async () => {
      mockRedis.eval.mockResolvedValue(0);

      const lock = new DistributedLock("test-lock");
      const released = await lock.release();

      expect(released).toBe(false);
    });

    it("should use atomic release with Lua script", async () => {
      mockRedis.set.mockResolvedValue("OK");
      mockRedis.eval.mockResolvedValue(1);

      const lock = new DistributedLock("test-lock");
      await lock.acquire();
      await lock.release();

      const evalCall = mockRedis.eval.mock.calls.find(
        (call: any[]) => call[0].includes("del")
      );
      expect(evalCall).toBeDefined();
    });

    it("should stop renewal after release", async () => {
      mockRedis.set.mockResolvedValue("OK");
      mockRedis.eval.mockResolvedValue(1);

      const lock = new DistributedLock("test-lock", 30000);
      await lock.acquire();

      await lock.release();

      mockRedis.eval.mockClear();

      await vi.advanceTimersByTimeAsync(15000);

      expect(mockRedis.eval).not.toHaveBeenCalled();
    });
  });

  describe("extend", () => {
    it("should extend lock TTL when owned", async () => {
      mockRedis.set.mockResolvedValue("OK");
      mockRedis.eval.mockResolvedValue(1);

      const lock = new DistributedLock("test-lock", 30000);
      await lock.acquire();

      mockRedis.eval.mockClear();
      const extended = await lock.extend();

      expect(extended).toBe(true);
      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it("should fail to extend when not owned", async () => {
      mockRedis.eval.mockResolvedValue(0);

      const lock = new DistributedLock("test-lock");
      const extended = await lock.extend();

      expect(extended).toBe(false);
    });

    it("should use custom TTL when provided", async () => {
      mockRedis.set.mockResolvedValue("OK");
      mockRedis.eval.mockResolvedValue(1);

      const lock = new DistributedLock("test-lock", 30000);
      await lock.acquire();

      mockRedis.eval.mockClear();
      await lock.extend(60000);

      const evalCall = mockRedis.eval.mock.calls[0];
      expect(evalCall[4]).toBe(60000);
    });
  });

  describe("isHeld", () => {
    it("should return true when lock is held by this instance", async () => {
      mockRedis.set.mockResolvedValue("OK");

      const lock = new DistributedLock("test-lock");
      await lock.acquire();

      const lockId = mockRedis.set.mock.calls[0][1];
      mockRedis.get.mockResolvedValue(lockId);

      const held = await lock.isHeld();

      expect(held).toBe(true);
    });

    it("should return false when lock is held by another instance", async () => {
      mockRedis.get.mockResolvedValue("different-lock-id");

      const lock = new DistributedLock("test-lock");
      const held = await lock.isHeld();

      expect(held).toBe(false);
    });

    it("should return false when lock is not held", async () => {
      mockRedis.get.mockResolvedValue(null);

      const lock = new DistributedLock("test-lock");
      const held = await lock.isHeld();

      expect(held).toBe(false);
    });
  });
});

describe("withLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should execute function when lock is acquired", async () => {
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);

    const fn = vi.fn().mockResolvedValue("result");

    const result = await withLock("test-lock", fn);

    expect(fn).toHaveBeenCalled();
    expect(result).toBe("result");
  });

  it("should return null when lock cannot be acquired", async () => {
    mockRedis.set.mockResolvedValue(null);

    const fn = vi.fn().mockResolvedValue("result");

    const result = await withLock("test-lock", fn, { waitMs: 0 });

    expect(fn).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("should release lock after function completes", async () => {
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);

    await withLock("test-lock", async () => "result");

    expect(mockRedis.eval).toHaveBeenCalled();
  });

  it("should release lock even if function throws", async () => {
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);

    const error = new Error("Test error");

    await expect(
      withLock("test-lock", async () => {
        throw error;
      })
    ).rejects.toThrow("Test error");

    expect(mockRedis.eval).toHaveBeenCalled();
  });

  it("should retry acquiring lock within wait time", async () => {
    let attempts = 0;
    mockRedis.set.mockImplementation(async () => {
      attempts++;
      return attempts >= 3 ? "OK" : null;
    });
    mockRedis.eval.mockResolvedValue(1);

    const fn = vi.fn().mockResolvedValue("result");

    const resultPromise = withLock("test-lock", fn, {
      waitMs: 1000,
      retryIntervalMs: 100,
    });

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    const result = await resultPromise;

    expect(result).toBe("result");
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it("should use custom TTL", async () => {
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);

    await withLock("test-lock", async () => "result", { ttlMs: 60000 });

    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "PX",
      60000,
      "NX"
    );
  });
});

describe("LeaderElection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should become leader when lock is acquired", async () => {
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);

    const onBecomeLeader = vi.fn();
    const election = new LeaderElection(
      "test-election",
      30000,
      onBecomeLeader
    );

    await election.start();

    expect(election.isCurrentLeader()).toBe(true);
    expect(onBecomeLeader).toHaveBeenCalled();
  });

  it("should not become leader when lock is not acquired", async () => {
    mockRedis.set.mockResolvedValue(null);

    const onBecomeLeader = vi.fn();
    const election = new LeaderElection(
      "test-election",
      30000,
      onBecomeLeader
    );

    await election.start();

    expect(election.isCurrentLeader()).toBe(false);
    expect(onBecomeLeader).not.toHaveBeenCalled();
  });

  it("should periodically check leadership", async () => {
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);

    const election = new LeaderElection("test-election", 30000);
    await election.start();

    mockRedis.set.mockClear();
    mockRedis.eval.mockClear();

    await vi.advanceTimersByTimeAsync(15001);
    await election.stop();

    expect(mockRedis.eval).toHaveBeenCalled();
  });

  it("should call onLoseLeadership when losing leader status", async () => {
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);

    const onLoseLeadership = vi.fn();
    const election = new LeaderElection(
      "test-election",
      30000,
      undefined,
      onLoseLeadership
    );

    await election.start();
    expect(election.isCurrentLeader()).toBe(true);

    mockRedis.eval.mockResolvedValue(0);

    await vi.advanceTimersByTimeAsync(15001);

    expect(onLoseLeadership).toHaveBeenCalled();
    expect(election.isCurrentLeader()).toBe(false);
    await election.stop();
  });

  it("should stop election and release lock", async () => {
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);

    const onLoseLeadership = vi.fn();
    const election = new LeaderElection(
      "test-election",
      30000,
      undefined,
      onLoseLeadership
    );

    await election.start();
    await election.stop();

    expect(election.isCurrentLeader()).toBe(false);
    expect(onLoseLeadership).toHaveBeenCalled();
    expect(mockRedis.eval).toHaveBeenCalled();
  });

  it("should try to acquire lock if not leader", async () => {
    let attempts = 0;
    mockRedis.set.mockImplementation(async () => {
      attempts++;
      return attempts >= 3 ? "OK" : null;
    });
    mockRedis.eval.mockResolvedValue(1);

    const onBecomeLeader = vi.fn();
    const election = new LeaderElection(
      "test-election",
      30000,
      onBecomeLeader
    );

    await election.start();
    expect(election.isCurrentLeader()).toBe(false);

    await vi.advanceTimersByTimeAsync(30001);

    expect(election.isCurrentLeader()).toBe(true);
    expect(onBecomeLeader).toHaveBeenCalled();
    await election.stop();
  });
});
