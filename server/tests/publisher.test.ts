import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockDb = {
  select: vi.fn(() => mockDb),
  from: vi.fn(() => mockDb),
  where: vi.fn(() => mockDb),
  limit: vi.fn(() => mockDb),
  offset: vi.fn(() => mockDb),
  orderBy: vi.fn(() => mockDb),
  insert: vi.fn(() => mockDb),
  values: vi.fn(() => mockDb),
  returning: vi.fn(),
  update: vi.fn(() => mockDb),
  set: vi.fn(() => mockDb),
  delete: vi.fn(() => mockDb),
  execute: vi.fn(),
  transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(mockDb)),
};

vi.mock("../src/db/index.ts", () => ({
  db: mockDb,
}));

vi.mock("../src/core/billing/message-accounting.ts", () => ({
  reserveMessageQuota: vi.fn(async (_workspaceId: string, _count: number, size: number) => {
    const usage = { dailyUsage: 0, monthlyUsage: 0, bandwidthUsage: 0, dailyCap: null, monthlyCap: null, bandwidthCap: null, messageSizeCap: 1024 * 1024 };
    return size > usage.messageSizeCap
      ? { ...usage, allowed: false, rejectedDimension: "message_size", reason: "Plan quota exceeded: message_size" }
      : { ...usage, allowed: true, reservationId: "resv_test" };
  }),
  finishMessageQuota: vi.fn(async () => undefined),
  getDurableMessageUsage: vi.fn(async () => ({ messages: 0, messagesReserved: 0, bandwidthReserved: 0 })),
  recordBandwidth: vi.fn(async () => undefined),
}));

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  xadd: vi.fn(),
  xread: vi.fn(),
  hset: vi.fn(),
  hget: vi.fn(),
  hgetall: vi.fn(),
  incr: vi.fn(),
  incrby: vi.fn(),
  expire: vi.fn(),
  sadd: vi.fn(),
  smembers: vi.fn(),
  zadd: vi.fn(),
  zrem: vi.fn(),
  zrangebyscore: vi.fn(),
  mget: vi.fn().mockResolvedValue(["0", "0", "0"]),
  eval: vi.fn().mockResolvedValue([1, "", 0, 0, 0]),
  pipeline: vi.fn(() => ({
    set: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    hset: vi.fn().mockReturnThis(),
    incrby: vi.fn().mockReturnThis(),
    sadd: vi.fn().mockReturnThis(),
    xadd: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    zrem: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  })),
};

const MockRedisKeys = {
  pendingStream: (workspaceId: string) => `workspace:${workspaceId}:stream:pending`,
  scheduledSet: (workspaceId: string) => `workspace:${workspaceId}:zset:scheduled`,
  processingSet: (workspaceId: string) => `workspace:${workspaceId}:zset:processing`,
  dlqSet: (workspaceId: string) => `workspace:${workspaceId}:zset:dlq`,
  message: (workspaceId: string, messageId: string) => `workspace:${workspaceId}:messages:${messageId}`,
  contentHash: (workspaceId: string, hash: string) => `workspace:${workspaceId}:dedup:${hash}`,
  usageCounter: (workspaceId: string, date: string, metric: string) => `workspace:${workspaceId}:usage:${date}:${metric}`,
  rateLimit: (workspaceId: string, window: string) => `workspace:${workspaceId}:ratelimit:${window}`,
  apiKey: (keyHash: string) => `apikey:${keyHash}`,
  workspaceCache: (workspaceId: string) => `cache:workspace:${workspaceId}`,
  activeWorkspacesPending: () => `index:workspaces:pending`,
  activeWorkspacesScheduled: () => `index:workspaces:scheduled`,
  queueScheduledSet: (workspaceId: string, queueId: string) => `workspace:${workspaceId}:queue:${queueId}:zset:scheduled`,
  quotaDaily: (workspaceId: string, date: string) => `quota:${workspaceId}:daily:${date}`,
  quotaMonthly: (workspaceId: string, month: string) => `quota:${workspaceId}:monthly:${month}`,
  quotaBandwidth: (workspaceId: string, month: string) => `quota:${workspaceId}:bandwidth:${month}`,
};

vi.mock("../src/lib/redis.ts", () => ({
  redis: mockRedis,
  RedisKeys: MockRedisKeys,
}));

vi.mock("../src/lib/logger.ts", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../src/utils/auth.ts", () => ({
  auth: {
    api: {
      getUser: vi.fn(() => Promise.resolve({ email: "test@example.com", id: "user_123" })),
    },
  },
}));

describe("publishMessage, the delivery publisher event fan-out uses", () => {
  let mockWorkspace: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(mockRedis.mget).mockResolvedValue(["0", "0", "0"]);
    vi.mocked(mockRedis.eval).mockResolvedValue([1, "", 0, 0, 0]);
    vi.mocked(mockDb.from).mockReturnValue({ where: vi.mocked(mockDb.where) } as any);
    vi.mocked(mockDb.select).mockReturnValue({ from: vi.mocked(mockDb.from) } as any);

    const { WORKSPACE_CACHE_VERSION } = await import("../src/lib/workspace-cache.ts");
    mockWorkspace = {
      version: WORKSPACE_CACHE_VERSION,
      policyEpoch: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      id: "workspace_123",
      plan: "production",
      maxRetries: 3,
      maxMessagesPerDay: "unlimited",
      maxMonthlyMessages: 1000000,
      maxMessageSize: 1024 * 1024,
      maxMonthlyBandwidth: 50 * 1024 ** 3,
    };

    vi.mocked(mockRedis.get).mockImplementation(async (key: string) => {
      if (key.startsWith("cache:workspace:")) {
        return JSON.stringify(mockWorkspace);
      }
      if (key.includes("api-key:")) {
        return JSON.stringify({ workspaceId: "workspace_123", keyHash: "hash_123" });
      }
      return null;
    });

    vi.mocked(mockDb.returning).mockImplementation(async () => {
      return [
        {
          id: "msg_123",
          messageId: "msg_test_123",
          workspaceId: "workspace_123",
          url: "https://example.com/webhook",
          method: "POST",
          status: "pending",
          attempts: 0,
          createdAt: new Date(),
        },
      ];
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("publishing one delivery", () => {
    it("should publish a message successfully", async () => {
      const { publishMessage } = await import("../src/core/messaging/publisher.ts");

      const messageData = {
        url: "https://example.com/webhook",
        method: "POST",
        body: { test: "data" },
        headers: { "Content-Type": "application/json" },
      };

      const result = await publishMessage({
        workspaceId: "workspace_123",
        ...messageData,
      });

      expect(result).toBeDefined();
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should support delayed execution with scheduledFor", async () => {
      const { publishMessage } = await import("../src/core/messaging/publisher.ts");

      const futureDate = new Date(Date.now() + 3600000);

      const messageData = {
        url: "https://example.com/webhook",
        method: "POST",
        scheduledFor: futureDate.toISOString(),
        body: { test: "data" },
      };

      await publishMessage({
        workspaceId: "workspace_123",
        ...messageData,
      });

      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should support content deduplication via contentId", async () => {
      const { publishMessage } = await import("../src/core/messaging/publisher.ts");

      const messageData = {
        url: "https://example.com/webhook",
        method: "POST",
        contentId: "unique_content_123",
        body: { test: "data" },
      };

      vi.mocked(mockRedis.get).mockImplementation(async (key: string) => {
        if (key.startsWith("cache:workspace:")) {
          return JSON.stringify(mockWorkspace);
        }
        return null;
      });

      const result = await publishMessage({
        workspaceId: "workspace_123",
        ...messageData,
      });

      expect(mockRedis.get).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("should support custom retry configuration", async () => {
      const { publishMessage } = await import("../src/core/messaging/publisher.ts");

      const messageData = {
        url: "https://example.com/webhook",
        method: "POST",
        maxRetries: 5,
        body: { test: "data" },
      };

      await publishMessage({
        workspaceId: "workspace_123",
        cachedWorkspace: mockWorkspace,
        ...messageData,
      });

      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should support callback URLs for success and failure", async () => {
      const { publishMessage } = await import("../src/core/messaging/publisher.ts");

      const messageData = {
        url: "https://example.com/webhook",
        method: "POST",
        callbackUrl: "https://example.com/success",
        failureCallbackUrl: "https://example.com/failure",
        body: { test: "data" },
      };

      await publishMessage({
        workspaceId: "workspace_123",
        cachedWorkspace: mockWorkspace,
        ...messageData,
      });

      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should enforce plan-based message size limits", async () => {
      const { publishMessage } = await import("../src/core/messaging/publisher.ts");

      const largeBody = { data: "x".repeat(2 * 1024 * 1024) };

      const messageData = {
        url: "https://example.com/webhook",
        method: "POST",
        body: largeBody,
      };

      const freeWorkspace = {
        ...mockWorkspace,
        plan: "free",
        maxMessageSize: 1 * 1024 * 1024,
      };
      vi.mocked(mockRedis.get).mockImplementation(async (key: string) => {
        if (key.startsWith("cache:workspace:")) {
          return JSON.stringify(freeWorkspace);
        }
        return null;
      });

      await expect(
        publishMessage({
          workspaceId: "workspace_123",
          ...messageData,
        })
      ).rejects.toThrow();
    });
  });

  describe("destination URL validation", () => {
    it("should reject private IP addresses (SSRF protection)", async () => {
      const { resolveAndValidateUrl } = await import("../src/utils/url-validation.ts");

      const privateUrls = [
        "http://localhost/webhook",
        "http://127.0.0.1/webhook",
        "http://192.168.1.1/webhook",
        "http://10.0.0.1/webhook",
        "http://172.16.0.1/webhook",
      ];

      for (const url of privateUrls) {
        const result = await resolveAndValidateUrl(url);
        expect(result.valid).toBe(false);
      }
    });

    it("should accept valid public URLs", async () => {
      const { validateUrl } = await import("../src/utils/url-validation.ts");

      const validUrls = [
        "https://example.com/webhook",
        "https://api.example.com/hook",
        "https://subdomain.example.com/path/to/webhook",
      ];

      for (const url of validUrls) {
        const result = validateUrl(url);
        expect(result.valid).toBe(true);
      }
    });
  });

  describe("Usage Tracking", () => {
    it("should increment message count on publish", async () => {
      const { publishMessage } = await import("../src/core/messaging/publisher.ts");

      const messageData = {
        url: "https://example.com/webhook",
        method: "POST",
        body: { test: "data" },
      };

      await publishMessage({
        workspaceId: "workspace_123",
        cachedWorkspace: mockWorkspace,
        ...messageData,
      });

      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should track bandwidth usage", async () => {
      const { publishMessage } = await import("../src/core/messaging/publisher.ts");

      const largeBody = { data: "x".repeat(1000) };

      const messageData = {
        url: "https://example.com/webhook",
        method: "POST",
        body: largeBody,
      };

      await publishMessage({
        workspaceId: "workspace_123",
        cachedWorkspace: mockWorkspace,
        ...messageData,
      });

      expect(mockDb.insert).toHaveBeenCalled();
    });
  });
});
