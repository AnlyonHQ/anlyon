import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockRedisKeys } from "../../../tests/setup.ts";

const {
  mockRedis,
  mockCheckEventPublishQuota,
  mockIncrementEventPublishesFast,
  mockSelect,
  mockInsert,
  mockUpdate,
  mockDelete,
} = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    xadd: vi.fn(),
  },
  mockCheckEventPublishQuota: vi.fn().mockResolvedValue(undefined),
  mockIncrementEventPublishesFast: vi.fn().mockResolvedValue(undefined),
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("../../db/index.ts", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

vi.mock("../../lib/redis.ts", () => ({
  redis: mockRedis,
  RedisKeys: MockRedisKeys,
}));

vi.mock("../../lib/logger.ts", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../config/env.ts", () => ({
  env: {
    DELIVERY_SECRET_MASTER_KEY: "test-master-key-32-chars-minimum!!",
    EVENTS_STREAM_MAXLEN: 10000,
  },
}));

vi.mock("../billing/usage-enforcement.ts", () => ({
  checkEventPublishQuota: (...args: unknown[]) => mockCheckEventPublishQuota(...args),
  QuotaExceededError: class QuotaExceededError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "QuotaExceededError";
    }
  },
}));

vi.mock("../../lib/workspace-cache.ts", () => ({
  incrementEventPublishesFast: (...args: unknown[]) =>
    mockIncrementEventPublishesFast(...args),
}));

vi.mock("../../utils/crypto.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/crypto.ts")>();
  return {
    ...actual,
    generateEventId: vi.fn(() => "evt_generated_test"),
  };
});

import { publishEvent, RESERVED_TOPIC_NAME } from "./service.ts";
import { ReservedTopicError } from "../../utils/errors.ts";

const baseTopic = {
  id: "topic-uuid-1",
  workspaceId: "ws_test123",
  environmentId: "env_test123",
  topicId: "top_test123",
  name: "orders",
  description: null,
  isReserved: false,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

function mockTopicLookup(topic: typeof baseTopic) {
  mockSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([topic]),
    }),
  });
}

function mockInsertWithConflictEmpty() {
  const returning = vi.fn().mockResolvedValue([]);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing, returning });
  mockInsert.mockReturnValue({ values });
  return { values, onConflictDoNothing, returning };
}

function mockInsertSuccess(row: Record<string, unknown>) {
  const returning = vi.fn().mockResolvedValue([row]);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing, returning });
  mockInsert.mockReturnValue({ values });
  return { values };
}

describe("publishEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckEventPublishQuota.mockResolvedValue(undefined);
    mockIncrementEventPublishesFast.mockResolvedValue(undefined);
    mockRedis.xadd.mockResolvedValue("1-0");
  });

  describe("idempotency", () => {
    it("returns deduplicated:true with original event id when insert conflicts", async () => {
      mockTopicLookup(baseTopic);
      mockInsertWithConflictEmpty();

      mockSelect.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              eventId: "evt_original_abc",
              status: "received",
              workspaceId: "ws_test123",
              topicId: baseTopic.id,
              idempotencyKey: "idem-key-1",
            },
          ]),
        }),
      });

      const result = await publishEvent("ws_test123", {
        topic: "orders",
        type: "order.created",
        data: { orderId: "1" },
        idempotencyKey: "idem-key-1",
      }, { environmentId: "env_test123" });

      expect(result).toEqual({
        id: "evt_original_abc",
        status: "received",
        deduplicated: true,
      });
      expect(mockRedis.xadd).not.toHaveBeenCalled();
      expect(mockIncrementEventPublishesFast).not.toHaveBeenCalled();
    });
  });

  describe("reserved topic", () => {
    const reservedTopic = {
      ...baseTopic,
      name: RESERVED_TOPIC_NAME,
      isReserved: true,
    };

    it("throws ReservedTopicError when publishing to reserved topic without allowReserved", async () => {
      mockTopicLookup(reservedTopic);

      await expect(
        publishEvent("ws_test123", {
          topic: RESERVED_TOPIC_NAME,
          type: "message.delivered",
          data: {},
        }, { environmentId: "env_test123" })
      ).rejects.toBeInstanceOf(ReservedTopicError);

      expect(mockCheckEventPublishQuota).not.toHaveBeenCalled();
    });

    it("skips checkEventPublishQuota when allowReserved is true", async () => {
      mockTopicLookup(reservedTopic);
      mockInsertSuccess({
        id: "evt-internal-1",
        eventId: "evt_platform_1",
        status: "received",
        workspaceId: "ws_test123",
        topicId: reservedTopic.id,
        type: "message.delivered",
        data: {},
      });

      const result = await publishEvent(
        "ws_test123",
        {
          topic: RESERVED_TOPIC_NAME,
          type: "message.delivered",
          data: { messageId: "msg_1" },
        },
        { allowReserved: true, environmentId: "env_test123" }
      );

      expect(result).toEqual({ id: "evt_platform_1", status: "received" });
      expect(mockCheckEventPublishQuota).not.toHaveBeenCalled();
      expect(mockIncrementEventPublishesFast).not.toHaveBeenCalled();
      expect(mockRedis.xadd).toHaveBeenCalled();
    });

    it("calls checkEventPublishQuota for normal topic publishes", async () => {
      mockTopicLookup(baseTopic);
      mockInsertSuccess({
        id: "evt-internal-2",
        eventId: "evt_user_1",
        status: "received",
        workspaceId: "ws_test123",
        topicId: baseTopic.id,
        type: "order.created",
        data: {},
      });

      await publishEvent("ws_test123", {
        topic: "orders",
        type: "order.created",
        data: {},
      }, { environmentId: "env_test123" });

      expect(mockCheckEventPublishQuota).toHaveBeenCalledWith("ws_test123");
      expect(mockIncrementEventPublishesFast).toHaveBeenCalledWith("ws_test123");
    });
  });
});
