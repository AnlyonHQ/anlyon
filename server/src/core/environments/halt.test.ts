import { describe, it, expect, vi, beforeEach } from "vitest";

const dbState: { selectResults: unknown[][] } = { selectResults: [] };

function createMockDb() {
  const node: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy"]) node[m] = vi.fn(() => node);
  node.then = (resolve: (rows: unknown[]) => void) => resolve(dbState.selectResults.shift() ?? []);
  return {
    select: vi.fn(() => node),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ slug: "prod" }]) })) })),
    })),
  };
}

const mockDb = createMockDb();
vi.mock("../../db/index.ts", () => ({ db: mockDb }));

const pipeline = { eval: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) };
const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  mget: vi.fn(async (keys: string[]) => keys.map(() => null as string | null)),
  set: vi.fn().mockResolvedValue("OK"),
  eval: vi.fn().mockResolvedValue(1),
  del: vi.fn().mockResolvedValue(1),
  pipeline: vi.fn(() => pipeline),
};
vi.mock("../../lib/redis.ts", () => ({
  redis: mockRedis,
  RedisKeys: { environmentHalt: (id: string) => `env:halt:${id}` },
}));
vi.mock("../../lib/logger.ts", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../events/emitter.ts", () => ({ emitEvent: vi.fn() }));
vi.mock("../../lib/product-events.ts", () => ({ captureMilestoneOnce: vi.fn() }));
vi.mock("./service.ts", () => ({ getEnvironment: vi.fn() }));

const { syncHaltedEnvironments, isEnvironmentHalted, resyncHaltStateSweep, HALT_RESYNC_CHUNK, HALT_RESYNC_LOCK_SECONDS } =
  await import("./halt.ts");

const T1 = new Date("2026-09-24T12:00:00.000Z");
const T2 = new Date("2026-09-24T12:05:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectResults = [];
  mockRedis.pipeline.mockReturnValue(pipeline as never);
  mockRedis.get.mockResolvedValue(null);
  mockRedis.mget.mockImplementation(async (keys: string[]) => keys.map(() => null));
  mockRedis.set.mockResolvedValue("OK");
});

function redisHolds(values: Record<string, string>) {
  mockRedis.mget.mockImplementation(async (keys: string[]) => keys.map((k) => values[k] ?? null));
}

const writesSent = () => pipeline.eval.mock.calls.map((call) => call.slice(2));

describe("syncHaltedEnvironments", () => {
  it("writes nothing when every copy already matches the table", async () => {
    dbState.selectResults.push([
      { id: "env_1", haltedAt: T1, updatedAt: T1 },
      { id: "env_2", haltedAt: null, updatedAt: T2 },
    ]);
    redisHolds({ "env:halt:env_1": `1:${T1.getTime()}`, "env:halt:env_2": `0:${T2.getTime()}` });

    expect(await syncHaltedEnvironments()).toBe(1);

    expect(mockRedis.mget).toHaveBeenCalledTimes(1);
    expect(pipeline.eval).not.toHaveBeenCalled();
    expect(pipeline.exec).not.toHaveBeenCalled();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it("does not rewrite a matching copy just because the row's version moved on", async () => {
    dbState.selectResults.push([{ id: "env_2", haltedAt: null, updatedAt: T2 }]);
    redisHolds({ "env:halt:env_2": `0:${T1.getTime()}` });

    await syncHaltedEnvironments();

    expect(pipeline.exec).not.toHaveBeenCalled();
  });

  it("restores a halted environment's lost key, and leaves a running one's miss to the hot path", async () => {
    dbState.selectResults.push([
      { id: "env_1", haltedAt: T1, updatedAt: T1 },
      { id: "env_2", haltedAt: null, updatedAt: T2 },
    ]);

    expect(await syncHaltedEnvironments()).toBe(1);

    expect(writesSent()).toEqual([["env:halt:env_1", "1", String(T1.getTime())]]);
    expect(pipeline.exec).toHaveBeenCalledTimes(1);
  });

  it("repairs a copy that disagrees with the table, in both directions", async () => {
    dbState.selectResults.push([
      { id: "env_1", haltedAt: T2, updatedAt: T2 },
      { id: "env_2", haltedAt: null, updatedAt: T2 },
      { id: "env_3", haltedAt: null, updatedAt: T2 },
    ]);
    redisHolds({
      "env:halt:env_1": `0:${T1.getTime()}`,
      "env:halt:env_2": `1:${T1.getTime()}`,
      "env:halt:env_3": "1",
    });

    await syncHaltedEnvironments();

    expect(writesSent()).toEqual([
      ["env:halt:env_1", "1", String(T2.getTime())],
      ["env:halt:env_2", "0", String(T2.getTime())],
      ["env:halt:env_3", "0", String(T2.getTime())],
    ]);
  });

  it("bounds its commands: one MGET per chunk, one pipeline only for chunks with repairs", async () => {
    const total = HALT_RESYNC_CHUNK * 2 + 7;
    const rows = Array.from({ length: total }, (_, i) => ({ id: `env_${i}`, haltedAt: null as Date | null, updatedAt: T1 }));
    rows[total - 1] = { id: `env_${total - 1}`, haltedAt: T2, updatedAt: T2 };
    dbState.selectResults.push(rows);

    await syncHaltedEnvironments();

    expect(mockRedis.mget.mock.calls.map(([keys]) => keys.length)).toEqual([HALT_RESYNC_CHUNK, HALT_RESYNC_CHUNK, 7]);
    expect(pipeline.exec).toHaveBeenCalledTimes(1);
    expect(writesSent()).toEqual([[`env:halt:env_${total - 1}`, "1", String(T2.getTime())]]);
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it("never deletes: a stale read is refused by the version check, not raced by a DEL", async () => {
    dbState.selectResults.push([{ id: "env_1", haltedAt: T1, updatedAt: T1 }]);
    redisHolds({ "env:halt:env_1": `0:${T2.getTime()}` });

    await syncHaltedEnvironments();

    expect(writesSent()).toEqual([["env:halt:env_1", "1", String(T1.getTime())]]);
    expect(mockRedis.del).not.toHaveBeenCalled();
  });
});

describe("resyncHaltStateSweep", () => {
  it("skips when another instance holds the lock", async () => {
    mockRedis.set.mockResolvedValue(null);

    expect(await resyncHaltStateSweep()).toBe(false);

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockRedis.mget).not.toHaveBeenCalled();
  });

  it("holds the lock until it expires after a clean sweep, so the fleet sweeps once per interval", async () => {
    dbState.selectResults.push([{ id: "env_1", haltedAt: null, updatedAt: T1 }]);

    expect(await resyncHaltStateSweep()).toBe(true);

    expect(mockRedis.set).toHaveBeenCalledWith(
      "billing:sweep:halt-state-resync", expect.any(String), "EX", HALT_RESYNC_LOCK_SECONDS, "NX",
    );
    expect(HALT_RESYNC_LOCK_SECONDS).toBeLessThan(60);
    expect(mockRedis.eval).not.toHaveBeenCalled();
    expect(mockRedis.mget).toHaveBeenCalledTimes(1);
  });

  it("releases the lock when the sweep fails, so the next instance retries", async () => {
    dbState.selectResults.push([{ id: "env_1", haltedAt: T1, updatedAt: T1 }]);
    mockRedis.mget.mockRejectedValue(new Error("redis blip"));

    await expect(resyncHaltStateSweep()).rejects.toThrow("redis blip");

    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    expect(mockRedis.eval.mock.calls[0][2]).toBe("billing:sweep:halt-state-resync");
  });
});

describe("isEnvironmentHalted", () => {
  it("answers from an explicit halted copy without touching the database", async () => {
    mockRedis.get.mockResolvedValue(`1:${T1.getTime()}`);
    expect(await isEnvironmentHalted("env_1")).toBe(true);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("answers from an explicit running copy without touching the database", async () => {
    mockRedis.get.mockResolvedValue(`0:${T1.getTime()}`);
    expect(await isEnvironmentHalted("env_1")).toBe(false);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("treats a missing key as unknown: answers from Postgres and rebuilds the key", async () => {
    dbState.selectResults.push([{ haltedAt: T1, updatedAt: T1 }]);

    expect(await isEnvironmentHalted("env_1")).toBe(true);
    await vi.waitFor(() => expect(mockRedis.eval).toHaveBeenCalled());
    expect(mockRedis.eval.mock.calls[0].slice(2)).toEqual(["env:halt:env_1", "1", String(T1.getTime())]);
  });

  it("treats an unversioned key from before this format as unknown", async () => {
    mockRedis.get.mockResolvedValue("1");
    dbState.selectResults.push([{ haltedAt: null, updatedAt: T2 }]);

    expect(await isEnvironmentHalted("env_1")).toBe(false);
  });

  it("falls back to the database when Redis is unreachable", async () => {
    mockRedis.get.mockRejectedValue(new Error("redis down"));
    dbState.selectResults.push([{ haltedAt: T1, updatedAt: T1 }]);
    expect(await isEnvironmentHalted("env_1")).toBe(true);
  });
});
