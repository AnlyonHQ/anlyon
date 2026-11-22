import { describe, it, expect, vi, beforeEach } from "vitest";

const redisGet = vi.fn();
const dbLimit = vi.fn();

vi.mock("../src/lib/redis.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/redis.ts")>()),
  redis: { get: (...a: unknown[]) => redisGet(...a), eval: async () => 1 },
}));

vi.mock("../src/db/index.ts", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => dbLimit() }) }) }),
  },
}));

vi.mock("../src/lib/logger.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/logger.ts")>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { isEnvironmentHalted } = await import("../src/core/environments/halt.ts");

beforeEach(() => vi.clearAllMocks());

describe("the fast path", () => {
  it("reports halted when the Redis flag is set", async () => {
    redisGet.mockResolvedValue("1:1790000000000");
    expect(await isEnvironmentHalted("env_1")).toBe(true);
  });

  it("reports running when it is not", async () => {
    redisGet.mockResolvedValue("0:1790000000000");
    expect(await isEnvironmentHalted("env_1")).toBe(false);
  });
});

describe("when Redis is unreachable", () => {
  it("falls back to Postgres, which is the source of truth", async () => {
    redisGet.mockRejectedValue(new Error("ECONNREFUSED"));
    dbLimit.mockResolvedValue([{ haltedAt: new Date() }]);

    expect(await isEnvironmentHalted("env_1")).toBe(true);
  });

  it("reports running when Postgres says the environment is active", async () => {
    redisGet.mockRejectedValue(new Error("ECONNREFUSED"));
    dbLimit.mockResolvedValue([{ haltedAt: null }]);

    expect(await isEnvironmentHalted("env_1")).toBe(false);
  });
});

describe("when neither layer can be read", () => {
  it("reports HALTED rather than assuming nothing is stopped", async () => {
    redisGet.mockRejectedValue(new Error("ECONNREFUSED"));
    dbLimit.mockRejectedValue(new Error("connection terminated"));

    expect(await isEnvironmentHalted("env_1")).toBe(true);
  });

  it("also fails closed when the environment row is missing entirely", async () => {
    redisGet.mockRejectedValue(new Error("ECONNREFUSED"));
    dbLimit.mockResolvedValue([]);

    expect(await isEnvironmentHalted("env_1")).toBe(false);
  });
});
