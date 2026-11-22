import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/redis.ts", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    mget: vi.fn(),
    pipeline: vi.fn(() => ({
      incrby: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  },
  RedisKeys: {
    workspaceCache: (id: string) => `workspace:cache:${id}`,
    quotaDaily: (wid: string, date: string) => `quota:daily:${wid}:${date}`,
    quotaMonthly: (wid: string, month: string) => `quota:monthly:${wid}:${month}`,
    quotaBandwidth: (wid: string, month: string) => `quota:bw:${wid}:${month}`,
  },
}));

vi.mock("../src/db/index.ts", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  },
}));

vi.mock("../src/db/schema/workspaces.ts", () => ({
  workspaces: {},
}));

vi.mock("../src/lib/logger.ts", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  getWorkspaceCached,
  invalidateWorkspaceCache,
  getTodayKey,
  getMonthKey,
  incrementQuotaFast,
  WORKSPACE_CACHE_VERSION,
} from "../src/lib/workspace-cache.ts";
import { usePlanFixture } from "./support/plan-fixture.ts";
import { redis } from "../src/lib/redis.ts";
import { db } from "../src/db/index.ts";

const PRICING_PLANS = { paygo: { maxMonthlyBandwidth: 250 * 1024 ** 3 } };
const BETA_FREE_LIMITS = { maxMonthlyMessages: 25_000 };
usePlanFixture({ free: BETA_FREE_LIMITS, paygo: PRICING_PLANS.paygo });

const mockRedis = redis as unknown as {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  mget: ReturnType<typeof vi.fn>;
  pipeline: ReturnType<typeof vi.fn>;
};

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
};

describe("Workspace Cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getTodayKey", () => {
    it("should return date in YYYY-MM-DD format", () => {
      const result = getTodayKey();

      expect(result).toBe("2024-06-15");
    });
  });

  describe("getMonthKey", () => {
    it("uses the UTC month even when the local month differs", () => {
      vi.setSystemTime(new Date("2024-07-01T00:15:00Z"));
      const localYear = vi.spyOn(Date.prototype, "getFullYear").mockReturnValue(2024);
      const localMonth = vi.spyOn(Date.prototype, "getMonth").mockReturnValue(5);
      try {
        expect(getMonthKey()).toBe("2024-07");
      } finally {
        localYear.mockRestore();
        localMonth.mockRestore();
      }
    });

    it("should return month in YYYY-MM format", () => {
      const result = getMonthKey();

      expect(result).toBe("2024-06");
    });

    it("should zero-pad single digit months", () => {
      vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));

      const result = getMonthKey();

      expect(result).toBe("2024-01");
    });
  });

  describe("getWorkspaceCached", () => {
    it("should return cached workspace when available", async () => {
      const cachedData = {
        version: WORKSPACE_CACHE_VERSION,
        policyEpoch: 0,
        id: "ws_123",
        plan: "paygo",
        maxRetries: 5,
        maxMessagesPerDay: "unlimited",
        maxMonthlyMessages: "unlimited",
        maxMessageSize: 10 * 1024 * 1024,
        maxMonthlyBandwidth: PRICING_PLANS.paygo.maxMonthlyBandwidth,
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedData));

      const result = await getWorkspaceCached("ws_123");

      expect(result).toEqual(cachedData);
      expect(mockRedis.get).toHaveBeenCalledWith("workspace:cache:ws_123");
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it.each([undefined, WORKSPACE_CACHE_VERSION - 1, WORKSPACE_CACHE_VERSION + 1])(
      "refreshes derived limits from stale cache version %s",
      async (version) => {
        mockRedis.get.mockResolvedValue(JSON.stringify({
          version, policyEpoch: 0, id: "ws_123", plan: "free", maxMonthlyMessages: 999999,
        }));
        mockDb.select.mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: "ws_123", plan: "free", createdAt: new Date("2026-01-01T00:00:00Z") }]),
          }),
        });

        const result = await getWorkspaceCached("ws_123");
        expect(result?.version).toBe(WORKSPACE_CACHE_VERSION);
        expect(result?.maxMonthlyMessages).toBe(BETA_FREE_LIMITS.maxMonthlyMessages);
        expect(mockRedis.set).toHaveBeenCalledWith(
          "workspace:cache:ws_123", expect.any(String), "EX", 300,
        );
      },
    );

    it("uses Free limits for an unrecognised database plan", async () => {
      mockRedis.get.mockResolvedValue(null);
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "ws_123", plan: "future-plan", createdAt: new Date("2026-01-01T00:00:00Z") }]),
        }),
      });
      const result = await getWorkspaceCached("ws_123");
      expect(result?.plan).toBe("free");
      expect(result?.maxMonthlyMessages).toBe(BETA_FREE_LIMITS.maxMonthlyMessages);
    });

    it("should fetch from database on cache miss", async () => {
      mockRedis.get.mockResolvedValue(null);
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "ws_123", plan: "free", createdAt: new Date("2026-01-01T00:00:00Z") },
          ]),
        }),
      });
      mockRedis.set.mockResolvedValue("OK");

      const result = await getWorkspaceCached("ws_123");

      expect(result).toBeDefined();
      expect(result?.id).toBe("ws_123");
      expect(result?.plan).toBe("free");
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it("should return null for non-existent workspace", async () => {
      mockRedis.get.mockResolvedValue(null);
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getWorkspaceCached("ws_nonexistent");

      expect(result).toBeNull();
    });

    it("should handle invalid cached JSON", async () => {
      mockRedis.get.mockResolvedValue("invalid-json");
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "ws_123", plan: "free", createdAt: new Date("2026-01-01T00:00:00Z") },
          ]),
        }),
      });
      mockRedis.set.mockResolvedValue("OK");

      const result = await getWorkspaceCached("ws_123");

      expect(result).toBeDefined();
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("should set correct TTL on cached data", async () => {
      mockRedis.get.mockResolvedValue(null);
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "ws_123", plan: "free", createdAt: new Date("2026-01-01T00:00:00Z") },
          ]),
        }),
      });
      mockRedis.set.mockResolvedValue("OK");

      await getWorkspaceCached("ws_123");

      expect(mockRedis.set).toHaveBeenCalledWith(
        "workspace:cache:ws_123",
        expect.any(String),
        "EX",
        300
      );
    });
  });

  describe("invalidateWorkspaceCache", () => {
    it("should delete cache entry", async () => {
      mockRedis.del.mockResolvedValue(1);

      await invalidateWorkspaceCache("ws_123");

      expect(mockRedis.del).toHaveBeenCalledWith("workspace:cache:ws_123");
    });
  });

  describe("incrementQuotaFast", () => {
    it("should increment all counters", async () => {
      const mockPipeline = {
        incrby: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      mockRedis.pipeline.mockReturnValue(mockPipeline);

      await incrementQuotaFast("ws_123", 1, 1000);

      expect(mockPipeline.incrby).toHaveBeenCalledTimes(3);
      expect(mockPipeline.expire).toHaveBeenCalledTimes(3);
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it("should skip bandwidth increment when size is 0", async () => {
      const mockPipeline = {
        incrby: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      mockRedis.pipeline.mockReturnValue(mockPipeline);

      await incrementQuotaFast("ws_123", 1, 0);

      expect(mockPipeline.incrby).toHaveBeenCalledTimes(2);
    });

    it("should use correct keys", async () => {
      const mockPipeline = {
        incrby: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      mockRedis.pipeline.mockReturnValue(mockPipeline);

      await incrementQuotaFast("ws_123", 5, 2000);

      expect(mockPipeline.incrby).toHaveBeenCalledWith(
        "quota:daily:ws_123:2024-06-15",
        5
      );
      expect(mockPipeline.incrby).toHaveBeenCalledWith(
        "quota:monthly:ws_123:2024-06",
        5
      );
      expect(mockPipeline.incrby).toHaveBeenCalledWith(
        "quota:bw:ws_123:2024-06",
        10000
      );
    });

    it("should set appropriate TTLs", async () => {
      const mockPipeline = {
        incrby: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      mockRedis.pipeline.mockReturnValue(mockPipeline);

      await incrementQuotaFast("ws_123", 1, 100);

      expect(mockPipeline.expire).toHaveBeenCalledWith(
        "quota:daily:ws_123:2024-06-15",
        90000
      );
      expect(mockPipeline.expire).toHaveBeenCalledWith(
        "quota:monthly:ws_123:2024-06",
        2678400
      );
    });
  });
});
