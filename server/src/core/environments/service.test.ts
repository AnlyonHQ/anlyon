import { describe, it, expect, vi, beforeEach } from "vitest";

const dbState: { selectResults: unknown[][] } = { selectResults: [] };

function createMockDb() {
  const node: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy", "innerJoin", "for"]) node[m] = vi.fn(() => node);
  node.then = (resolve: (rows: unknown[]) => void) => resolve(dbState.selectResults.shift() ?? []);

  const db: Record<string, unknown> = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    select: vi.fn(() => node),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: "env_new", slug: "staging" }]),
        onConflictDoNothing: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ isProtected: false }]) })),
      })),
    })),
  };
  return db as {
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };
}

const workspace = () => ({ id: "ws_1", plan: "free", createdAt: new Date() });

const mockDb = createMockDb();
vi.mock("../../db/index.ts", () => ({ db: mockDb }));
vi.mock("../../lib/logger.ts", async (importOriginal) => {
  const quiet = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { ...(await importOriginal<typeof import("../../lib/logger.ts")>()), createLogger: quiet };
});

const { assertNotProtected, updateEnvironment, createEnvironment, ensureDefaultEnvironment } = await import("./service.ts");
const { usePlanFixture } = await import("../../../tests/support/plan-fixture.ts");
usePlanFixture({ free: { maxEnvironments: 3 } });

const env = (over: Record<string, unknown> = {}) => ({
  id: "env_1",
  workspaceId: "ws_1",
  name: "Production",
  slug: "production",
  isDefault: true,
  isProtected: true,
  haltedAt: null,
  haltedReason: null,
  haltedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectResults = [];
});

describe("assertNotProtected", () => {
  it("blocks a destructive action on a protected environment", async () => {
    dbState.selectResults.push([env()]);
    await expect(
      assertNotProtected("ws_1", "env_1", "deleting a schedule")
    ).rejects.toThrow(/protected/i);
  });

  it("names the environment and the way forward", async () => {
    dbState.selectResults.push([env()]);
    await expect(
      assertNotProtected("ws_1", "env_1", "deleting a secret")
    ).rejects.toThrow(/production.*deleting a secret.*confirmProtected/is);
  });

  it("allows the action once explicitly confirmed", async () => {
    await expect(
      assertNotProtected("ws_1", "env_1", "deleting a schedule", true)
    ).resolves.toBeUndefined();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("does not interfere with unprotected environments", async () => {
    dbState.selectResults.push([env({ isProtected: false, slug: "staging" })]);
    await expect(assertNotProtected("ws_1", "env_1", "anything")).resolves.toBeUndefined();
  });
});

describe("updateEnvironment", () => {
  it("guards turning protection off", async () => {
    dbState.selectResults.push([workspace()], [env()]);
    await expect(
      updateEnvironment("ws_1", "env_1", { isProtected: false })
    ).rejects.toThrow(/protected/i);
  });

  it("turns protection off when confirmed", async () => {
    dbState.selectResults.push([workspace()], [env()]);
    await expect(
      updateEnvironment("ws_1", "env_1", { isProtected: false, confirmProtected: true })
    ).resolves.toBeDefined();
  });

  it("leaves an unprotected environment freely editable", async () => {
    dbState.selectResults.push([workspace()], [env({ isProtected: false })]);
    await expect(
      updateEnvironment("ws_1", "env_1", { name: "Staging" })
    ).resolves.toBeDefined();
  });
});

describe("createEnvironment", () => {
  it("maps a duplicate slug to a conflict rather than a 500", async () => {
    dbState.selectResults.push([workspace()], [{ used: 0 }]);
    mockDb.insert.mockReturnValueOnce({
      values: vi.fn(() => ({
        returning: vi.fn().mockRejectedValue(
          new Error('duplicate key value violates unique constraint "environments_workspace_slug_unique"')
        ),
      })),
    } as never);

    await expect(
      createEnvironment("ws_1", { name: "Staging", slug: "staging" })
    ).rejects.toThrow(/already exists/i);
  });

  it("rejects a malformed slug before touching the database", async () => {
    await expect(
      createEnvironment("ws_1", { name: "Bad", slug: "-nope-" })
    ).rejects.toThrow(/slug/i);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

describe("a fresh Early Beta workspace", () => {
  const captureInsert = (returned: Record<string, unknown>) => {
    const values = vi.fn((row: Record<string, unknown>) => ({
      returning: vi.fn().mockResolvedValue([{ ...returned, ...row }]),
      onConflictDoNothing: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ ...returned, ...row }]) })),
    }));
    mockDb.insert.mockReturnValueOnce({ values } as never);
    return values;
  };

  it("gets a protected Production default environment and can create a staging one", async () => {
    dbState.selectResults.push([workspace()], []);
    const defaults = captureInsert({ id: "env_default" });
    const created = await ensureDefaultEnvironment("ws_1");
    expect(defaults).toHaveBeenCalledWith({
      workspaceId: "ws_1", name: "Production", kind: "production", slug: "production", isDefault: true, isProtected: true,
    });
    expect(created).toMatchObject({ kind: "production", slug: "production", name: "Production", isProtected: true });

    dbState.selectResults.push([workspace()], [{ used: 1 }]);
    const staging = captureInsert({ id: "env_staging" });
    await expect(
      createEnvironment("ws_1", { name: "Staging", slug: "staging", kind: "staging" })
    ).resolves.toMatchObject({ kind: "staging", slug: "staging" });
    expect(staging).toHaveBeenCalledWith(expect.objectContaining({ kind: "staging", isDefault: false }));
  });

  it("leaves an existing default environment exactly as it is", async () => {
    const existing = env({ kind: "development", name: "Development", slug: "development", isProtected: false });
    dbState.selectResults.push([workspace()], [existing]);
    await expect(ensureDefaultEnvironment("ws_1")).resolves.toBe(existing);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("can create every kind, and may protect one, inside one total allowance", async () => {
    for (const kind of ["development", "staging", "production"] as const) {
      dbState.selectResults.push([workspace()], [{ used: 2 }]);
      captureInsert({ id: `env_${kind}` });
      await expect(
        createEnvironment("ws_1", { name: kind, slug: `my-${kind}`, kind, isProtected: kind === "production" })
      ).resolves.toMatchObject({ kind });
    }
  });

  it("is stopped by the count of environments, never by their kind", async () => {
    dbState.selectResults.push([workspace()], [{ used: 3 }]);
    await expect(
      createEnvironment("ws_1", { name: "Fourth", slug: "fourth", kind: "development" })
    ).rejects.toThrow(/allows 3 environments/);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("can change an environment's kind without a plan check", async () => {
    dbState.selectResults.push([workspace()], [env({ kind: "development", isProtected: false })]);
    await expect(updateEnvironment("ws_1", "env_1", { kind: "production" })).resolves.toBeDefined();
  });

  it("can turn protection on", async () => {
    dbState.selectResults.push([workspace()], [env({ isProtected: false })]);
    await expect(updateEnvironment("ws_1", "env_1", { isProtected: true })).resolves.toBeDefined();
  });
});
