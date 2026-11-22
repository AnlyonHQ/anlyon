import { describe, it, expect, vi, beforeEach } from "vitest";

const rowDefaults = {
  secretId: "sec_1",
  name: "STRIPE_KEY",
  description: null,
  lastUsedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const dbState: { selectResults: unknown[][]; inserted: unknown[]; updated: unknown[] } = {
  selectResults: [],
  inserted: [],
  updated: [],
};

function createMockDb() {
  const node: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy"]) node[m] = vi.fn(() => node);
  node.then = (resolve: (rows: unknown[]) => void) => resolve(dbState.selectResults.shift() ?? []);

  return {
    select: vi.fn(() => node),
    insert: vi.fn(() => ({
      values: vi.fn((v: unknown) => {
        dbState.inserted.push(v);
        return { returning: vi.fn().mockResolvedValue([{ ...(v as object), ...rowDefaults }]) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: unknown) => {
        dbState.updated.push(v);
        return {
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ ...rowDefaults, ...(v as object) }]),
            then: (r: (x: unknown) => unknown) => Promise.resolve(undefined).then(r),
          })),
        };
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  };
}

const mockDb = createMockDb();
vi.mock("../../db/index.ts", () => ({ db: mockDb }));
vi.mock("../../lib/logger.ts", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../config/env.ts", () => ({
  env: { DELIVERY_SECRET_MASTER_KEY: "a-master-key-that-is-at-least-32-chars" },
}));
vi.mock("../billing/usage-enforcement.ts", () => ({ checkSecretQuota: vi.fn() }));
vi.mock("../events/emitter.ts", () => ({ emitEvent: vi.fn() }));
vi.mock("../connections/provider.ts", () => ({ requireConnectionProvider: vi.fn(), ConnectionRevokedError: class ConnectionRevokedError extends Error {} }));

const mockAssertNotProtected = vi.fn();
vi.mock("../environments/service.ts", () => ({
  assertNotProtected: (...a: unknown[]) => mockAssertNotProtected(...a),
}));

const { putSecret, listSecrets, getSecretMetadata, deleteSecret, resolveSecrets } =
  await import("./secrets.ts");

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectResults = [];
  dbState.inserted = [];
  dbState.updated = [];
  mockAssertNotProtected.mockResolvedValue(undefined);
});

describe("putSecret", () => {
  it("stores the value encrypted and never returns it", async () => {
    dbState.selectResults.push([]);

    const view = await putSecret("ws_1", "STRIPE_KEY", { value: "sk_live_xyz" }, "env_1");

    expect(JSON.stringify(view)).not.toContain("sk_live_xyz");
    const stored = dbState.inserted[0] as { valueEncrypted: string };
    expect(stored.valueEncrypted).not.toContain("sk_live_xyz");
    expect(stored.valueEncrypted.startsWith("v3.")).toBe(true);
  });

  it("scopes the row to the environment it was given", async () => {
    dbState.selectResults.push([]);
    await putSecret("ws_1", "STRIPE_KEY", { value: "v" }, "env_staging");
    expect(dbState.inserted[0]).toMatchObject({ environmentId: "env_staging" });
  });

  it("rotates in place rather than creating a second row", async () => {
    dbState.selectResults.push([{ id: "uuid-1", ...rowDefaults }]);
    await putSecret("ws_1", "STRIPE_KEY", { value: "new" }, "env_1");
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(dbState.updated).toHaveLength(1);
  });
});

describe("reads", () => {
  it("returns metadata only, never a value", async () => {
    dbState.selectResults.push([{ id: "uuid-1", valueEncrypted: "v2.aaaa.secret", ...rowDefaults }]);

    const view = await getSecretMetadata("ws_1", "STRIPE_KEY", "env_1");

    expect(view).toMatchObject({ id: "sec_1", name: "STRIPE_KEY" });
    expect(JSON.stringify(view)).not.toContain("valueEncrypted");
    expect(JSON.stringify(view)).not.toContain("v2.aaaa");
  });

  it("does not leak values through a listing either", async () => {
    dbState.selectResults.push([{ id: "uuid-1", valueEncrypted: "v2.aaaa.secret", ...rowDefaults }]);
    const list = await listSecrets("ws_1", "env_1");
    expect(JSON.stringify(list)).not.toContain("v2.aaaa");
  });

  it("reports a missing secret rather than returning nothing", async () => {
    dbState.selectResults.push([]);
    await expect(getSecretMetadata("ws_1", "NOPE", "env_1")).rejects.toThrow(/not found/i);
  });
});

describe("deleteSecret", () => {
  it("goes through the protected-environment guard", async () => {
    dbState.selectResults.push([{ id: "uuid-1" }]);
    await deleteSecret("ws_1", "STRIPE_KEY", "env_1");
    expect(mockAssertNotProtected).toHaveBeenCalledWith(
      "ws_1",
      "env_1",
      "deleting a secret",
      undefined
    );
  });

  it("does not delete when the guard rejects", async () => {
    mockAssertNotProtected.mockRejectedValue(new Error("Environment is protected"));
    await expect(deleteSecret("ws_1", "STRIPE_KEY", "env_1")).rejects.toThrow(/protected/i);
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});

describe("resolveSecrets", () => {
  it("names every missing secret instead of failing on the first", async () => {
    dbState.selectResults.push([]);
    await expect(resolveSecrets("ws_1", ["A", "B"], "env_1")).rejects.toThrow(/A, B/);
  });

  it("does no work, and no query, for an empty request", async () => {
    expect(await resolveSecrets("ws_1", [], "env_1")).toEqual(new Map());
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
