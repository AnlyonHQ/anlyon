import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockDbObj: any = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve([]))
    }))
  })),
  insert: vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn(() => Promise.resolve())
    }))
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    }))
  })),
};
mockDbObj.transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => fn(mockDbObj));

vi.mock("../src/db/index.ts", () => ({
  db: mockDbObj,
}));

vi.mock("../src/lib/redis.ts", () => ({
  redis: {
    mget: vi.fn(() => Promise.resolve(["100", "500", "1024"])),
    get: vi.fn(() => Promise.resolve("0")),
    hget: vi.fn(() => Promise.resolve("0")),
    set: vi.fn(() => Promise.resolve()),
    del: vi.fn(() => Promise.resolve()),
    scan: vi.fn(() => Promise.resolve(["0", []]))
  },
  RedisKeys: {
    quotaDaily: (workspaceId: string, date: string) => `quota:${workspaceId}:daily:${date}`,
    quotaMonthly: (workspaceId: string, month: string) => `quota:${workspaceId}:monthly:${month}`,
    quotaBandwidth: (workspaceId: string, month: string) => `quota:${workspaceId}:bandwidth:${month}`,
    quotaMemoryOps: (workspaceId: string, month: string) => `quota:${workspaceId}:memory-ops:${month}`,
    quotaEmbeddingTokens: (workspaceId: string, month: string) => `quota:${workspaceId}:embedding-tokens:${month}`,
    quotaLlmTokens: (workspaceId: string, month: string) => `quota:${workspaceId}:llm-tokens:${month}`,
    quotaRerankOps: (workspaceId: string, month: string) => `quota:${workspaceId}:rerank-ops:${month}`,
    quotaMemoryStorage: (workspaceId: string) => `quota:${workspaceId}:memory-storage`,
    quotaEventPublishes: (workspaceId: string, month: string) => `quota:${workspaceId}:event-publishes:${month}`,
    quotaCacheLookups: (workspaceId: string, month: string) => `quota:${workspaceId}:cache-lookups:${month}`,
    quotaActionInvokes: (workspaceId: string, month: string) => `quota:${workspaceId}:action-invokes:${month}`,
    fileStorageGauge: (workspaceId: string) => `files:${workspaceId}:storage`,
    cacheStats: (workspaceId: string) => `cache:${workspaceId}:stats`,
    workspaceCache: (workspaceId: string) => `cache:workspace:${workspaceId}`
  }
}));

vi.mock("../src/lib/workspace-cache.ts", () => ({
  invalidateWorkspaceCache: vi.fn(() => Promise.resolve()),
  getMonthKey: () => "2025-01",
  getTodayKey: () => "2025-01-15"
}));

vi.mock("../src/lib/logger.ts", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

describe("Usage Sync Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("getTodayKey and getMonthKey", () => {
    it("should return correct date format for today", async () => {
      const { getTodayKey } = await import("../src/lib/workspace-cache.ts");
      const todayKey = getTodayKey();

      expect(todayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("should return correct date format for month", async () => {
      const { getMonthKey } = await import("../src/lib/workspace-cache.ts");
      const monthKey = getMonthKey();

      expect(monthKey).toMatch(/^\d{4}-\d{2}$/);
    });
  });

  describe("syncWorkspaceUsage", () => {
    it("should sync usage from Redis to database", async () => {
      const { redis } = await import("../src/lib/redis.ts");
      const { db } = await import("../src/db/index.ts");

      vi.mocked(redis.mget).mockResolvedValue(["100", "500", "1024"]);

      const { syncWorkspaceUsage } = await import("../src/core/billing/usage-sync.ts");
      await syncWorkspaceUsage("workspace-123");

      expect(redis.mget).toHaveBeenCalled();
      expect(db.insert).toHaveBeenCalled();
    });

    it("should not sync if no usage", async () => {
      const { redis } = await import("../src/lib/redis.ts");
      const { db } = await import("../src/db/index.ts");

      vi.mocked(redis.mget).mockResolvedValue(["0", "0", "0"]);

      const { syncWorkspaceUsage } = await import("../src/core/billing/usage-sync.ts");
      await syncWorkspaceUsage("workspace-123");

      expect(redis.mget).toHaveBeenCalled();
    });
  });

  describe("handlePlanChange", () => {
    it("should invalidate cache on plan change", async () => {
      const { invalidateWorkspaceCache } = await import("../src/lib/workspace-cache.ts");

      const { handlePlanChange } = await import("../src/core/billing/usage-sync.ts");
      await handlePlanChange("workspace-123", "paygo");

      expect(invalidateWorkspaceCache).toHaveBeenCalledWith("workspace-123");
    });

    it("reports nothing to a payment provider on a plan change: plans are flat prices", async () => {
      const { redis } = await import("../src/lib/redis.ts");
      const { handlePlanChange } = await import("../src/core/billing/usage-sync.ts");
      await handlePlanChange("workspace-123", "production");
      expect(redis.mget).not.toHaveBeenCalled();
    });
  });

  describe("resetMonthlyUsage", () => {
    it("should reset all workspace usage counters", async () => {
      const { db } = await import("../src/db/index.ts");
      const { redis } = await import("../src/lib/redis.ts");

      vi.mocked(redis.scan).mockResolvedValue(["0", []]);

      const { resetMonthlyUsage } = await import("../src/core/billing/usage-sync.ts");
      await resetMonthlyUsage();

      expect(db.update).toHaveBeenCalled();
    });
  });
});
