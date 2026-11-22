import { describe, it, expect, vi, beforeEach } from "vitest";

const updateReturning = vi.fn();
const selectWhere = vi.fn();

vi.mock("../src/core/actions/secrets.ts", () => ({
  loadSecretPolicies: vi.fn().mockResolvedValue(new Map()),
  resolveSecrets: vi.fn(),
}));

vi.mock("../src/core/billing/usage-enforcement.ts", () => ({
  checkActionQuota: vi.fn(),
  checkActionInvokeQuota: vi.fn(),
}));

const versionTx = {
  select: () => ({ from: () => ({ where: () => Promise.resolve([{ max: 0 }]) }) }),
  insert: () => ({ values: () => Promise.resolve(undefined) }),
  update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
};

vi.mock("../src/db/index.ts", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => selectWhere() }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => updateReturning() }) }) }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(versionTx),
  },
}));

vi.mock("../src/lib/logger.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/logger.ts")>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { updateAction, UNSCOPED_AUTHORITY } = await import("../src/core/actions/service.ts");
const { AuthorizationError } = await import("../src/utils/errors.ts");

const ENV = "env_1";
const WS = "ws_1";

const WRITER = { scopes: ["actions:read", "actions:write", "actions:invoke"] };
const GOVERNOR = { scopes: [...WRITER.scopes, "actions:govern"] };

function gatedRow() {
  return {
    id: "uuid-1",
    actionId: "act_1",
    name: "refund",
    description: null,
    method: "POST",
    urlTemplate: "https://api.example.com/refund",
    headers: {},
    bodyTemplate: null,
    inputSchema: {},
    requiresApproval: true,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectWhere.mockResolvedValue([gatedRow()]);
  updateReturning.mockImplementation(async () => [{ ...gatedRow(), requiresApproval: false }]);
});

describe("changing an action's approval requirement", () => {
  it("refuses to ungate for a key holding only actions:write", async () => {
    await expect(
      updateAction(WS, "refund", { requiresApproval: false }, WRITER, ENV)
    ).rejects.toThrow(AuthorizationError);
  });

  it("names the scope needed, so the fix is obvious", async () => {
    await expect(
      updateAction(WS, "refund", { requiresApproval: false }, WRITER, ENV)
    ).rejects.toThrow(/actions:govern/);
  });

  it("refuses to ADD a gate without the scope too  governance is not one-way", async () => {
    selectWhere.mockResolvedValue([{ ...gatedRow(), requiresApproval: false }]);
    await expect(
      updateAction(WS, "refund", { requiresApproval: true }, WRITER, ENV)
    ).rejects.toThrow(AuthorizationError);
  });

  it("allows the change for a key granted actions:govern", async () => {
    await expect(
      updateAction(WS, "refund", { requiresApproval: false }, GOVERNOR, ENV)
    ).resolves.toMatchObject({ requiresApproval: false });
  });

  it("allows a role-authorised session caller", async () => {
    await expect(
      updateAction(WS, "refund", { requiresApproval: false }, UNSCOPED_AUTHORITY, ENV)
    ).resolves.toMatchObject({ requiresApproval: false });
  });
});

describe("ordinary edits are unaffected", () => {
  it("lets actions:write change the URL", async () => {
    updateReturning.mockResolvedValue([
      { ...gatedRow(), urlTemplate: "https://api.example.com/refund/v2" },
    ]);
    await expect(
      updateAction(WS, "refund", { urlTemplate: "https://api.example.com/refund/v2" }, WRITER, ENV)
    ).resolves.toMatchObject({ urlTemplate: "https://api.example.com/refund/v2" });
  });

  it("lets actions:write restate the flag at its current value", async () => {
    updateReturning.mockResolvedValue([gatedRow()]);
    await expect(
      updateAction(WS, "refund", { requiresApproval: true }, WRITER, ENV)
    ).resolves.toMatchObject({ requiresApproval: true });
  });
});
