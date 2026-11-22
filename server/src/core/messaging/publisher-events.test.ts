import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockRedisKeys } from "../../../tests/setup.ts";

const {
  mockRedis,
  mockCheckCustomHeadersQuota,
  mockCheckWebhooksQuota,
  mockGetWorkspaceCached,
  mockCheckQuotaFast,
  mockIncrementQuotaFast,
  mockGetQueueCached,
  mockLogMessageExecution,
  mockRecordPlanQuotaDecision,
  mockDbInsertValues,
  mockDbInsert,
  mockFinishMessageQuota,
  mockDispatchOutbox,
} = vi.hoisted(() => {
  const mockDbInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockDbInsert = vi.fn(() => ({
    values: (...args: unknown[]) => mockDbInsertValues(...args),
  }));
  return {
    mockRedis: {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      pipeline: vi.fn(),
    },
    mockCheckCustomHeadersQuota: vi.fn().mockResolvedValue(undefined),
    mockCheckWebhooksQuota: vi.fn().mockResolvedValue(undefined),
    mockGetWorkspaceCached: vi.fn(),
    mockCheckQuotaFast: vi.fn(),
    mockIncrementQuotaFast: vi.fn().mockResolvedValue(undefined),
    mockGetQueueCached: vi.fn().mockResolvedValue(null),
    mockLogMessageExecution: vi.fn().mockResolvedValue(undefined),
    mockRecordPlanQuotaDecision: vi.fn().mockResolvedValue(undefined),
    mockDbInsertValues,
    mockDbInsert,
    mockFinishMessageQuota: vi.fn().mockResolvedValue(undefined),
    mockDispatchOutbox: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../db/index.ts", () => ({
  db: {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run({ insert: mockDbInsert }),
    insert: (...args: unknown[]) => mockDbInsert(...args),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
    select: vi.fn(),
  },
}));

vi.mock("../billing/message-accounting.ts", () => ({ finishMessageQuota: mockFinishMessageQuota }));
vi.mock("./enqueue-outbox.ts", () => ({ dispatchMessageOutbox: mockDispatchOutbox }));
vi.mock("../../lib/product-events.ts", () => ({ captureMilestoneOnce: vi.fn() }));
vi.mock("../notifications/usage-alerts.ts", () => ({ checkAndSendUsageAlerts: vi.fn().mockResolvedValue(undefined) }));

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

vi.mock("../billing/usage-enforcement.ts", () => ({
  checkCustomHeadersQuota: (...args: unknown[]) => mockCheckCustomHeadersQuota(...args),
  checkWebhooksQuota: (...args: unknown[]) => mockCheckWebhooksQuota(...args),
  QuotaExceededError: class QuotaExceededError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "QuotaExceededError";
    }
  },
}));

vi.mock("../../lib/workspace-cache.ts", () => ({
  getWorkspaceCached: (...args: unknown[]) => mockGetWorkspaceCached(...args),
  reservePlanQuota: (...args: unknown[]) => mockCheckQuotaFast(...args),
  releasePlanQuota: (...args: unknown[]) => mockIncrementQuotaFast(...args),
}));

vi.mock("./queue-lookup.ts", () => ({
  getQueueCached: (...args: unknown[]) => mockGetQueueCached(...args),
}));

vi.mock("../logging/execution-logger.ts", () => ({
  logMessageExecution: (...args: unknown[]) => mockLogMessageExecution(...args),
}));

vi.mock("../billing/budget-tracing.ts", () => ({
  recordPlanQuotaDecision: (...args: unknown[]) => mockRecordPlanQuotaDecision(...args),
}));

vi.mock("../../utils/url-validation.ts", () => ({
  validateUrl: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock("../../utils/crypto.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/crypto.ts")>();
  return {
    ...actual,
    generateMessageId: vi.fn(() => "msg_generated_test"),
  };
});

import { publishMessage } from "./publisher.ts";

function outboxHashData(): Record<string, string | number> {
  const payload = mockDbInsertValues.mock.calls.find(([value]) => value.commands)?.[0];
  const command = payload.commands.find(([name]: string[]) => name === "hset");
  const fields = command.slice(2);
  return Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]]));
}

describe("publishMessage eventId plumbing", () => {
  let pipelineHset: ReturnType<typeof vi.fn>;
  let pipelineExpire: ReturnType<typeof vi.fn>;
  let pipelineXadd: ReturnType<typeof vi.fn>;
  let pipelineSadd: ReturnType<typeof vi.fn>;
  let pipelineExec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    pipelineHset = vi.fn().mockReturnThis();
    pipelineExpire = vi.fn().mockReturnThis();
    pipelineXadd = vi.fn().mockReturnThis();
    pipelineSadd = vi.fn().mockReturnThis();
    pipelineExec = vi.fn().mockResolvedValue([]);

    mockRedis.pipeline.mockReturnValue({
      hset: pipelineHset,
      expire: pipelineExpire,
      xadd: pipelineXadd,
      sadd: pipelineSadd,
      zadd: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      zrem: vi.fn().mockReturnThis(),
      exec: pipelineExec,
    } as any);

    mockDbInsert.mockImplementation(() => ({
      values: (...args: unknown[]) => mockDbInsertValues(...args),
    }));
    mockDbInsertValues.mockResolvedValue(undefined);

    mockGetWorkspaceCached.mockResolvedValue({
      id: "ws_test123",
      plan: "paygo",
      maxRetries: 3,
    });
    mockCheckQuotaFast.mockResolvedValue({
      allowed: true,
      reservationId: "reservation-test",
      dailyUsage: 2,
      monthlyUsage: 10,
      bandwidthUsage: 128,
      dailyCap: 100,
      monthlyCap: 1000,
      bandwidthCap: 4096,
      messageSizeCap: 1024,
    });
    mockCheckCustomHeadersQuota.mockResolvedValue(undefined);
    mockCheckWebhooksQuota.mockResolvedValue(undefined);
    mockIncrementQuotaFast.mockResolvedValue(undefined);
    mockLogMessageExecution.mockResolvedValue(undefined);
    mockGetQueueCached.mockResolvedValue(null);
  });

  it("writes eventId and eventSubscriptionId into Redis hash and DB insert", async () => {
    const result = await publishMessage({
      workspaceId: "ws_test123",
      environmentId: "env_test123",
      url: "https://example.com/hook",
      method: "POST",
      body: { id: "evt_1", type: "order.created" },
      eventId: "event-internal-uuid",
      eventSubscriptionId: "sub-internal-uuid",
    });

    expect(result.messageId).toBe("msg_generated_test");
    expect(result.status).toBe("pending");

    expect(mockDispatchOutbox).toHaveBeenCalledWith("msg_generated_test");
    const hashData = outboxHashData();
    expect(hashData.eventId).toBe("event-internal-uuid");
    expect(hashData.eventSubscriptionId).toBe("sub-internal-uuid");

    expect(mockDbInsertValues).toHaveBeenCalled();
    const dbValues = mockDbInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(dbValues.eventId).toBe("event-internal-uuid");
    expect(dbValues.eventSubscriptionId).toBe("sub-internal-uuid");
  });

  it("writes durable trace context into Redis and the message row", async () => {
    await publishMessage({
      workspaceId: "ws_test123",
      environmentId: "env_test123",
      url: "https://example.com/hook",
      body: { hello: true },
      traceRunId: "run_trace",
      traceParentSpanId: "span_parent",
    });

    const hashData = outboxHashData();
    expect(hashData.traceRunId).toBe("run_trace");
    expect(hashData.traceParentSpanId).toBe("span_parent");
    expect(typeof hashData.traceStartedAt).toBe("string");

    const dbValues = mockDbInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(dbValues.traceRunId).toBe("run_trace");
    expect(dbValues.traceParentSpanId).toBe("span_parent");
    expect(dbValues.traceStartedAt).toBeInstanceOf(Date);
  });

  it("records the workspace plan decision with the caller's correlated run", async () => {
    await publishMessage({
      workspaceId: "ws_test123",
      environmentId: "env_test",
      quotaTraceId: "plan_quota_message_req_1",
      url: "https://example.com/hook",
      body: { hello: true },
      runId: "run_trace",
      parentSpanId: "span_parent",
    });

    expect(mockRecordPlanQuotaDecision).toHaveBeenCalledWith(
      "ws_test123",
      { runId: "run_trace", environmentId: "env_test", parentSpanId: "span_parent" },
      expect.objectContaining({
        id: "plan_quota_message_req_1",
        allowed: true,
        dailyUsage: 2,
        monthlyCap: 1000,
      })
    );
  });

  it("skips checkCustomHeadersQuota when eventId is set (even with headers)", async () => {
    await publishMessage({
      workspaceId: "ws_test123",
      environmentId: "env_test123",
      url: "https://example.com/hook",
      headers: { "X-Custom": "yes" },
      body: { hello: true },
      eventId: "event-internal-uuid",
      eventSubscriptionId: "sub-internal-uuid",
    });

    expect(mockCheckCustomHeadersQuota).not.toHaveBeenCalled();
  });

  it("enforces checkCustomHeadersQuota when eventId is absent and headers present", async () => {
    await publishMessage({
      workspaceId: "ws_test123",
      environmentId: "env_test123",
      url: "https://example.com/hook",
      headers: { "X-Custom": "yes" },
      body: { hello: true },
    });

    expect(mockCheckCustomHeadersQuota).toHaveBeenCalledWith("ws_test123");
  });

  it("does not call checkCustomHeadersQuota when no headers and no eventId", async () => {
    await publishMessage({
      workspaceId: "ws_test123",
      environmentId: "env_test123",
      url: "https://example.com/hook",
      body: { hello: true },
    });

    expect(mockCheckCustomHeadersQuota).not.toHaveBeenCalled();
  });

  it("omits event fields from Redis/DB when eventId is not provided", async () => {
    await publishMessage({
      workspaceId: "ws_test123",
      environmentId: "env_test123",
      url: "https://example.com/hook",
      body: { hello: true },
    });

    const hashData = outboxHashData();
    expect(hashData.eventId).toBeUndefined();
    expect(hashData.eventSubscriptionId).toBeUndefined();

    const dbValues = mockDbInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(dbValues.eventId).toBeNull();
    expect(dbValues.eventSubscriptionId).toBeNull();
  });

  it("accepts durable work when immediate Redis dispatch fails", async () => {
    mockDispatchOutbox.mockRejectedValueOnce(new Error("Redis unavailable"));
    const result = await publishMessage({ workspaceId: "ws_test123", environmentId: "env_test123", url: "https://example.com" });
    expect(result.messageId).toBe("msg_generated_test");
    expect(mockFinishMessageQuota).toHaveBeenCalledWith("ws_test123", "reservation-test", "billed", expect.anything());
    expect(mockIncrementQuotaFast).not.toHaveBeenCalled();
    expect(mockDbInsertValues.mock.calls.some(([value]) => value.commands)).toBe(true);
  });

  it("releases the identity-based reservation when database persistence fails", async () => {
    mockDbInsertValues.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(publishMessage({ workspaceId: "ws_test123", environmentId: "env_test123", url: "https://example.com" })).rejects.toThrow("Database unavailable");
    expect(mockDispatchOutbox).not.toHaveBeenCalled();
    expect(mockIncrementQuotaFast).toHaveBeenCalledWith("ws_test123", 1, expect.any(Number), "reservation-test");
  });

  it("releases admission if quota tracing fails before persistence", async () => {
    mockRecordPlanQuotaDecision.mockRejectedValueOnce(new Error("Trace unavailable"));
    await expect(publishMessage({ workspaceId: "ws_test123", environmentId: "env_test123", url: "https://example.com" })).rejects.toThrow("Trace unavailable");
    expect(mockDbInsertValues).not.toHaveBeenCalled();
    expect(mockIncrementQuotaFast).toHaveBeenCalledWith("ws_test123", 1, expect.any(Number), "reservation-test");
  });
});
