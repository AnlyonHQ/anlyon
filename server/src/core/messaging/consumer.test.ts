import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockRedisKeys } from "../../../tests/setup.ts";
import { verifyDeliverySignature, signDeliveryPayload } from "../../utils/crypto.ts";

const {
  mockRedis,
  mockEmitEvent,
  mockGetSubscriptionSecret,
  mockSignDeliveryForWorkspace,
  mockSafeFetch,
  mockQueueMessageUpdate,
  mockLogMessageExecution,
  mockExecPipelineChecked,
  mockGetRunWithTree,
  mockIngestSpans,
} = vi.hoisted(() => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    hget: vi.fn(),
    hset: vi.fn(),
    hgetall: vi.fn(),
    pipeline: vi.fn(),
    incr: vi.fn(),
    zadd: vi.fn(),
    sadd: vi.fn(),
  };
  return {
    mockRedis,
    mockEmitEvent: vi.fn(),
    mockGetSubscriptionSecret: vi.fn(),
    mockSignDeliveryForWorkspace: vi.fn(),
    mockSafeFetch: vi.fn(),
    mockQueueMessageUpdate: vi.fn().mockResolvedValue(undefined),
    mockLogMessageExecution: vi.fn().mockResolvedValue(undefined),
    mockExecPipelineChecked: vi.fn().mockResolvedValue([]),
    mockGetRunWithTree: vi.fn().mockResolvedValue({ run: { environmentId: "env_test123" } }),
    mockIngestSpans: vi.fn().mockResolvedValue({ ingested: 1 }),
  };
});

vi.mock("../../db/index.ts", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../../lib/redis.ts", () => ({
  redis: mockRedis,
  RedisKeys: MockRedisKeys,
  execPipelineChecked: (...args: unknown[]) => mockExecPipelineChecked(...args),
  USAGE_COUNTER_TTL_SECONDS: 172_800,
}));

vi.mock("../../lib/logger.ts", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../lib/safe-http.ts", () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SsrfBlockedError";
    }
  },
}));

vi.mock("../../lib/circuit-breaker.ts", () => ({
  CircuitBreaker: {
    canRequest: vi.fn().mockResolvedValue({ allowed: true }),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    isFailureStatus: (status: number) => status >= 500 || status === 429 || status === 408,
  },
}));

vi.mock("../../lib/batch-writer.ts", () => ({
  queueMessageUpdate: (...args: unknown[]) => mockQueueMessageUpdate(...args),
}));

vi.mock("../../lib/callback-queue.ts", () => ({
  callbackQueue: {
    enqueue: vi.fn(),
  },
}));

vi.mock("../../lib/url-cache.ts", () => ({
  urlValidationCache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  },
  messageDataCache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("../logging/execution-logger.ts", () => ({
  logMessageExecution: (...args: unknown[]) => mockLogMessageExecution(...args),
}));

vi.mock("../auth/delivery-secrets.ts", () => ({
  signDeliveryForWorkspace: (...args: unknown[]) => mockSignDeliveryForWorkspace(...args),
}));

vi.mock("../environments/halt.ts", () => ({ isEnvironmentHalted: vi.fn().mockResolvedValue(false) }));

vi.mock("../events/service.ts", () => ({
  getSubscriptionSigningByInternalId: (...args: unknown[]) => mockGetSubscriptionSecret(...args),
}));

vi.mock("../events/emitter.ts", () => ({
  emitEvent: (...args: unknown[]) => mockEmitEvent(...args),
}));

vi.mock("../runs/service.ts", () => ({
  getRunWithTree: (...args: unknown[]) => mockGetRunWithTree(...args),
  ingestSpans: (...args: unknown[]) => mockIngestSpans(...args),
}));

import { deliverMessage, type MessageData } from "./consumer.ts";

function createReadableResponse(opts: {
  ok: boolean;
  status: number;
  statusText?: string;
  body?: string;
}) {
  const text = opts.body ?? "";
  const bytes = new TextEncoder().encode(text);
  return {
    ok: opts.ok,
    status: opts.status,
    statusText: opts.statusText ?? (opts.ok ? "OK" : "Error"),
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: bytes };
          },
          releaseLock() {},
          async cancel() {},
        };
      },
    },
  };
}

function baseMessage(overrides: Partial<MessageData> = {}): MessageData {
  return {
    messageId: "msg_test123",
    workspaceId: "ws_test123",
    environmentId: "env_test123",
    url: "https://example.com/webhook",
    method: "POST",
    headers: "{}",
    body: JSON.stringify({ hello: "world" }),
    maxRetries: "3",
    attempts: "0",
    ...overrides,
  };
}

describe("deliverMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecPipelineChecked.mockResolvedValue([]);
    mockQueueMessageUpdate.mockResolvedValue(undefined);
    mockLogMessageExecution.mockResolvedValue(undefined);
    mockSignDeliveryForWorkspace.mockResolvedValue(null);
    mockGetSubscriptionSecret.mockResolvedValue(null);
    mockGetRunWithTree.mockResolvedValue({ run: { environmentId: "env_test123" } });
    mockIngestSpans.mockResolvedValue({ ingested: 1 });
    mockRedis.pipeline.mockReturnValue({
      del: vi.fn().mockReturnThis(),
      incr: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zremrangebyrank: vi.fn().mockReturnThis(),
      sadd: vi.fn().mockReturnThis(),
      hset: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    } as any);
  });

  describe("loop guard (eventId)", () => {
    it("records one terminal queue_delivery span for a traced successful delivery", async () => {
      mockSafeFetch.mockResolvedValue(
        createReadableResponse({ ok: true, status: 200, body: "ok" })
      );

      await deliverMessage(baseMessage({
        traceRunId: "run_trace",
        traceParentSpanId: "span_parent",
        traceStartedAt: "2026-07-15T00:00:00.000Z",
        queueId: "que_internal",
      }));

      expect(mockGetRunWithTree).toHaveBeenCalledWith({ workspaceId: "ws_test123" }, "run_trace");
      expect(mockIngestSpans).toHaveBeenCalledWith(
        { workspaceId: "ws_test123", environmentId: "env_test123" },
        "run_trace",
        [expect.objectContaining({
          id: "queue_msg_test123",
          parentId: "span_parent",
          type: "queue_delivery",
          status: "succeeded",
          startedAt: "2026-07-15T00:00:00.000Z",
          attributes: expect.objectContaining({ messageId: "msg_test123", queueId: "que_internal", attempt: 1 }),
        })],
      );
    });

    it("emits message.delivered on success when eventId is absent", async () => {
      mockSafeFetch.mockResolvedValue(
        createReadableResponse({ ok: true, status: 200, body: "ok" })
      );

      await deliverMessage(baseMessage());

      expect(mockEmitEvent).toHaveBeenCalledWith("ws_test123", "message.delivered", {
        messageId: "msg_test123",
        responseStatus: 200,
      });
    });

    it("does NOT emit message.delivered on success when eventId is set", async () => {
      mockSafeFetch.mockResolvedValue(
        createReadableResponse({ ok: true, status: 200, body: "ok" })
      );

      await deliverMessage(
        baseMessage({
          eventId: "evt-internal-uuid",
          eventSubscriptionId: "sub-internal-uuid",
        })
      );

      expect(mockEmitEvent).not.toHaveBeenCalled();
    });

    it("emits message.failed on DLQ when eventId is absent", async () => {
      mockSafeFetch.mockResolvedValue(
        createReadableResponse({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          body: "fail",
        })
      );

      await deliverMessage(
        baseMessage({
          maxRetries: "1",
          attempts: "0",
        })
      );

      expect(mockEmitEvent).toHaveBeenCalledWith("ws_test123", "message.failed", {
        messageId: "msg_test123",
        attempts: 1,
        errorMessage: "HTTP 500: Internal Server Error",
      });
    });

    it("does NOT emit message.failed on DLQ when eventId is set", async () => {
      mockSafeFetch.mockResolvedValue(
        createReadableResponse({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          body: "fail",
        })
      );

      await deliverMessage(
        baseMessage({
          maxRetries: "1",
          attempts: "0",
          eventId: "evt-internal-uuid",
        })
      );

      expect(mockEmitEvent).not.toHaveBeenCalled();
    });
  });

  describe("per-subscription signing", () => {
    const subSecret = "whsec_subscription_secret_test";
    const workspaceSecret = "whsec_workspace_secret_test";
    const bodyObj = { id: "evt_1", type: "order.created", data: { n: 1 } };

    it("signs with subscription secret when eventSubscriptionId resolves a secret", async () => {
      mockGetSubscriptionSecret.mockResolvedValue({ secret: subSecret, format: "anlyon", expiresAt: null });
      mockSafeFetch.mockResolvedValue(
        createReadableResponse({ ok: true, status: 200, body: "ok" })
      );

      await deliverMessage(
        baseMessage({
          eventId: "evt-internal-uuid",
          eventSubscriptionId: "sub-internal-uuid",
          body: JSON.stringify(bodyObj),
        })
      );

      expect(mockGetSubscriptionSecret).toHaveBeenCalledWith("sub-internal-uuid");
      expect(mockSignDeliveryForWorkspace).not.toHaveBeenCalled();

      const fetchCall = mockSafeFetch.mock.calls[0];
      const headers = fetchCall[1].headers as Record<string, string>;
      expect(headers["Anlyon-Signature"]).toBeDefined();

      const bodyString = JSON.stringify(bodyObj);
      const verified = verifyDeliverySignature(
        bodyString,
        headers["Anlyon-Signature"],
        subSecret
      );
      expect(verified.valid).toBe(true);

      const wrong = verifyDeliverySignature(
        bodyString,
        headers["Anlyon-Signature"],
        workspaceSecret
      );
      expect(wrong.valid).toBe(false);
    });

    it("binds subscription delivery to its trusted environment and exact outgoing body", async () => {
      mockGetSubscriptionSecret.mockResolvedValue({ secret: subSecret, format: "anlyon", expiresAt: null });
      mockSafeFetch.mockResolvedValue(createReadableResponse({ ok: true, status: 200, body: "ok" }));
      await deliverMessage(baseMessage({ environmentId: "env_staging", eventSubscriptionId: "sub-internal-uuid", body: JSON.stringify({ text: "héllo" }) }));
      const sent = mockSafeFetch.mock.calls[0][1];
      const header = sent.headers["Anlyon-Signature"] as string;
      const timestamp = header.split(",")[0].slice(2);
      const expected = createHmac("sha256", subSecret).update(`anlyon-delivery-v2.${timestamp}.env_staging.${sent.body}`).digest("hex");
      expect(header).toContain(`env=env_staging,v2=${expected}`);
      expect(sent.headers["X-Anlyon-Environment-Id"]).toBe("env_staging");
    });

    it("falls back to signDeliveryForWorkspace when subscription secret is null", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const bodyString = JSON.stringify(bodyObj);
      const signature = signDeliveryPayload(bodyString, workspaceSecret, timestamp);

      mockGetSubscriptionSecret.mockResolvedValue(null);
      mockSignDeliveryForWorkspace.mockResolvedValue({ signature, timestamp });
      mockSafeFetch.mockResolvedValue(
        createReadableResponse({ ok: true, status: 200, body: "ok" })
      );

      await deliverMessage(
        baseMessage({
          eventId: "evt-internal-uuid",
          eventSubscriptionId: "sub-internal-uuid",
          body: JSON.stringify(bodyObj),
        })
      );

      expect(mockGetSubscriptionSecret).toHaveBeenCalledWith("sub-internal-uuid");
      expect(mockSignDeliveryForWorkspace).toHaveBeenCalledWith("ws_test123", bodyString, "env_test123");

      const fetchCall = mockSafeFetch.mock.calls[0];
      const headers = fetchCall[1].headers as Record<string, string>;
      expect(headers["Anlyon-Signature"]).toBe(signature);

      const verified = verifyDeliverySignature(
        bodyString,
        headers["Anlyon-Signature"],
        workspaceSecret
      );
      expect(verified.valid).toBe(true);
    });
  });
});
