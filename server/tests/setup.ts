import { vi } from "vitest";

export function createMockRedis() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    hget: vi.fn(),
    hset: vi.fn(),
    hgetall: vi.fn(),
    hdel: vi.fn(),
    incr: vi.fn(),
    incrby: vi.fn(),
    decr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
    exists: vi.fn(),
    sadd: vi.fn(),
    srem: vi.fn(),
    smembers: vi.fn(),
    sismember: vi.fn(),
    zadd: vi.fn(),
    zrem: vi.fn(),
    zrange: vi.fn(),
    zrangebyscore: vi.fn(),
    zcount: vi.fn(),
    xadd: vi.fn(),
    xread: vi.fn(),
    xack: vi.fn(),
    xdel: vi.fn(),
    scan: vi.fn(),
    mget: vi.fn(),
    mset: vi.fn(),
    pipeline: vi.fn(() => createMockPipeline()),
    eval: vi.fn(),
  };
}

export const MockRedisKeys = {
  pendingStream: (workspaceId: string) => `workspace:${workspaceId}:stream:pending`,
  scheduledSet: (workspaceId: string) => `workspace:${workspaceId}:zset:scheduled`,
  processingSet: (workspaceId: string) => `workspace:${workspaceId}:zset:processing`,
  dlqSet: (workspaceId: string) => `workspace:${workspaceId}:zset:dlq`,
  queuePendingStream: (workspaceId: string, queueId: string) => `queue:${workspaceId}:${queueId}:stream:pending`,
  queueScheduledSet: (workspaceId: string, queueId: string) => `queue:${workspaceId}:${queueId}:zset:scheduled`,
  queueProcessingSet: (workspaceId: string, queueId: string) => `queue:${workspaceId}:${queueId}:zset:processing`,
  queueDlqSet: (workspaceId: string, queueId: string) => `queue:${workspaceId}:${queueId}:zset:dlq`,
  queueCache: (queueId: string) => `cache:queue:${queueId}`,
  queueStats: (workspaceId: string, queueId: string) => `queue:${workspaceId}:${queueId}:stats`,
  activeQueues: (workspaceId: string) => `index:queues:${workspaceId}:active`,
  activeQueuesPending: () => `index:queues:pending`,
  activeWorkspacesPending: () => `index:workspaces:pending`,
  activeWorkspacesScheduled: () => `index:workspaces:scheduled`,
  activeWorkspacesProcessing: () => `index:workspaces:processing`,
  message: (workspaceId: string, messageId: string) => `workspace:${workspaceId}:messages:${messageId}`,
  contentHash: (workspaceId: string, hash: string) => `workspace:${workspaceId}:dedup:${hash}`,
  usageCounter: (workspaceId: string, date: string, metric: string) => `workspace:${workspaceId}:usage:${date}:${metric}`,
  rateLimit: (workspaceId: string, window: string) => `workspace:${workspaceId}:ratelimit:${window}`,
  apiKey: (keyHash: string) => `apikey:${keyHash}`,
  apiKeyPrevious: (keyId: string) => `apikey:${keyId}:previous`,
  apiKeyRollbackLock: (keyId: string) => `apikey:${keyId}:rollback-lock`,
  deliverySecret: (workspaceId: string) => `workspace:${workspaceId}:delivery-secret`,
  deliverySecretOld: (workspaceId: string) => `workspace:${workspaceId}:delivery-secret:old`,
  session: (sessionId: string) => `session:${sessionId}`,
  cronSchedule: (scheduleId: string) => `cron:schedule:${scheduleId}`,
  allCronSchedules: () => `cron:schedules:active`,
  workerLock: (workerName: string) => `lock:worker:${workerName}`,
  circuitBreaker: (host: string) => `circuit:${host}`,
  workerHeartbeat: (workerType: string, workerId: string) => `health:worker:${workerType}:${workerId}`,
  activeWorkers: (workerType: string) => `health:workers:${workerType}`,
  workspaceCache: (workspaceId: string) => `cache:workspace:${workspaceId}`,
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
  fileStorageGauge: (workspaceId: string) => `files:${workspaceId}:storage`,
  cacheStats: (workspaceId: string) => `cache:${workspaceId}:stats`,
  eventsIngestStream: () => `events:ingest`,
  eventsHasSubs: (workspaceId: string) => `events:has-subs:${workspaceId}`,
};

export function createMockPipeline() {
  const pipeline = {
    get: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    hset: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    sadd: vi.fn().mockReturnThis(),
    xadd: vi.fn().mockReturnThis(),
    incrby: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  return pipeline;
}


export function createChainableWhere(
  mockWhere: ReturnType<typeof vi.fn>,
  mockReturning?: ReturnType<typeof vi.fn>
) {
  return vi.fn((...args: unknown[]) => {
    const result = mockWhere(...args);
    return {
      then: (resolve: (rows: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
      catch: (reject: (e: unknown) => unknown) => Promise.resolve(result).catch(reject),
      limit: vi.fn(() => Promise.resolve(result)),
      orderBy: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(result)),
        then: (resolve: (rows: unknown) => unknown) => Promise.resolve(result).then(resolve),
      })),
      returning: mockReturning ?? vi.fn().mockResolvedValue([]),
    };
  });
}

export function createMockDb() {
  const mockWhere = vi.fn();
  const mockFrom = vi.fn();
  const mockReturning = vi.fn();
  const mockValues = vi.fn();
  const mockSet = vi.fn();
  const mockLimit = vi.fn();
  const mockOrderBy = vi.fn();
  const mockOffset = vi.fn();

  mockReturning.mockResolvedValue([]);

  mockWhere.mockResolvedValue([]);
  const chainableWhere = createChainableWhere(mockWhere, mockReturning);

  mockFrom.mockReturnValue({
    where: chainableWhere,
    innerJoin: vi.fn(() => ({ where: chainableWhere })),
    limit: mockLimit.mockReturnValue({ where: chainableWhere }),
    orderBy: mockOrderBy.mockReturnValue({ where: chainableWhere, limit: mockLimit }),
  });

  mockValues.mockReturnValue({ returning: mockReturning });

  mockSet.mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: mockReturning, catch: vi.fn() }),
  });

  const db = {
    select: vi.fn().mockReturnValue({ from: mockFrom }),
    insert: vi.fn().mockReturnValue({ values: mockValues }),
    update: vi.fn().mockReturnValue({ set: mockSet }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => {
      const tx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
            returning: mockReturning,
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        select: vi.fn().mockReturnValue({ from: mockFrom }),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      };
      return fn(tx);
    }),
    _mocks: {
      where: mockWhere,
      from: mockFrom,
      returning: mockReturning,
      values: mockValues,
      set: mockSet,
      limit: mockLimit,
      orderBy: mockOrderBy,
      offset: mockOffset,
    },
    where: mockWhere,
    returning: mockReturning,
  };

  return db;
}

export function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

export function createMockWorkspace(overrides: Partial<{
  id: string;
  name: string;
  slug: string;
  plan: string;
  ownerId: string;
  currentMonthMessages: number;
  currentMonthBandwidth: number;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: "ws_test123",
    name: "Test Workspace",
    slug: "test-workspace",
    plan: "free",
    ownerId: "user_test123",
    currentMonthMessages: 0,
    currentMonthBandwidth: 0,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

export function createMockMessage(overrides: Partial<{
  messageId: string;
  workspaceId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  status: string;
  attempts: number;
  maxRetries: number;
  scheduledFor: Date | null;
  createdAt: Date;
}> = {}) {
  return {
    messageId: "msg_test123",
    workspaceId: "ws_test123",
    url: "https://example.com/webhook",
    method: "POST",
    headers: {},
    body: { test: "data" },
    status: "pending",
    attempts: 0,
    maxRetries: 3,
    scheduledFor: null,
    createdAt: new Date(),
    ...overrides,
  };
}

export function createMockApiKey(overrides: Partial<{
  id: string;
  workspaceId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  isActive: string;
  createdBy: string;
  expiresAt: Date | null;
  createdAt: Date;
}> = {}) {
  return {
    id: "key_test123",
    workspaceId: "ws_test123",
    name: "Test Key",
    keyHash: "a".repeat(64),
    keyPrefix: "anlyon_live_fixture",
    isActive: "true",
    createdBy: "user_test123",
    expiresAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

export async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function expectErrorMessage(fn: () => any, message: string | RegExp): void {
  expect(fn).toThrow(message);
}

export async function expectAsyncErrorMessage(
  fn: () => Promise<any>,
  message: string | RegExp
): Promise<void> {
  await expect(fn()).rejects.toThrow(message);
}

export function randomString(length: number = 10): string {
  return Math.random().toString(36).substring(2, length + 2);
}

export function createMockResponse(overrides: Partial<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}> = {}) {
  const response = {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Map(),
    text: vi.fn().mockResolvedValue(overrides.body || ""),
    json: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
  return response;
}
