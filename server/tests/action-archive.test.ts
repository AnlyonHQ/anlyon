import { describe, it, expect, vi, beforeEach } from "vitest";

const selectWhere = vi.fn();
const updateSet = vi.fn();
const deleteWhere = vi.fn();

const versionTx = {
  select: () => ({ from: () => ({ where: () => Promise.resolve([{ max: 0 }]) }) }),
  insert: () => ({ values: () => Promise.resolve(undefined) }),
  update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
};

vi.mock("../src/db/index.ts", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => selectWhere() }) }),
    update: () => ({ set: (v: unknown) => (updateSet(v), { where: () => Promise.resolve(undefined) }) }),
    delete: () => ({ where: () => deleteWhere() }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(versionTx),
  },
}));

vi.mock("../src/core/actions/secrets.ts", () => ({
  loadSecretPolicies: vi.fn().mockResolvedValue(new Map()),
  resolveSecrets: vi.fn(),
}));

vi.mock("../src/core/billing/usage-enforcement.ts", () => ({
  checkActionQuota: vi.fn(),
  checkActionInvokeQuota: vi.fn(),
}));

vi.mock("../src/lib/logger.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/logger.ts")>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { deleteAction, UNSCOPED_AUTHORITY } = await import("../src/core/actions/service.ts");
const { AuthorizationError } = await import("../src/utils/errors.ts");

const WRITER = { scopes: ["actions:read", "actions:write"] };
const GOVERNOR = { scopes: [...WRITER.scopes, "actions:govern"] };

function action(over: Record<string, unknown> = {}) {
  return {
    id: "uuid-1",
    actionId: "act_1",
    name: "refund",
    requiresApproval: false,
    archivedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectWhere.mockResolvedValue([action()]);
});

describe("deleting an action", () => {
  it("archives rather than destroying the row", async () => {
    await deleteAction("ws_1", "refund", WRITER, "env_1");

    expect(deleteWhere).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ archivedAt: expect.any(Date) }),
    );
  });

  it("never issues a delete, so versions and invocations cannot cascade away", async () => {
    await deleteAction("ws_1", "refund", GOVERNOR, "env_1");

    expect(deleteWhere).not.toHaveBeenCalled();
  });
});

describe("archiving a gated action is a governance act", () => {
  it("refuses a key holding only actions:write", async () => {
    selectWhere.mockResolvedValue([action({ requiresApproval: true })]);

    await expect(deleteAction("ws_1", "refund", WRITER, "env_1")).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("names the scope, since deleting a gate is deleting a gate", async () => {
    selectWhere.mockResolvedValue([action({ requiresApproval: true })]);

    await expect(deleteAction("ws_1", "refund", WRITER, "env_1")).rejects.toThrow(
      /actions:govern/,
    );
  });

  it("allows it with actions:govern", async () => {
    selectWhere.mockResolvedValue([action({ requiresApproval: true })]);

    await expect(deleteAction("ws_1", "refund", GOVERNOR, "env_1")).resolves.toBeUndefined();
  });

  it("allows a role-authorised session caller", async () => {
    selectWhere.mockResolvedValue([action({ requiresApproval: true })]);

    await expect(
      deleteAction("ws_1", "refund", UNSCOPED_AUTHORITY, "env_1"),
    ).resolves.toBeUndefined();
  });

  it("leaves ungated actions deletable with actions:write, as before", async () => {
    await expect(deleteAction("ws_1", "refund", WRITER, "env_1")).resolves.toBeUndefined();
  });
});
