import { describe, it, expect, vi, beforeEach } from "vitest";

const getPinnedActionVersionId = vi.fn();
const selectLimit = vi.fn();

vi.mock("../src/core/agents/service.ts", () => ({
  getPinnedActionVersionId: (...a: unknown[]) => getPinnedActionVersionId(...a),
}));

vi.mock("../src/core/actions/secrets.ts", () => ({
  loadSecretPolicies: vi.fn().mockResolvedValue(new Map()),
  resolveSecrets: vi.fn(),
}));

vi.mock("../src/core/billing/usage-enforcement.ts", () => ({
  checkActionQuota: vi.fn(),
  checkActionInvokeQuota: vi.fn(),
}));

vi.mock("../src/db/index.ts", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => selectLimit() }) }),
    }),
  },
}));

vi.mock("../src/lib/logger.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/logger.ts")>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { resolvePinnedDefinition } = await import("../src/core/actions/service.ts");

const LIVE = {
  id: "uuid-1",
  workspaceId: "ws_1",
  environmentId: "env_1",
  name: "refund",
  actionId: "act_1",
  method: "POST",
  urlTemplate: "https://api.example.com/refund/v2",
  headers: { "X-Version": "2" },
  bodyTemplate: null,
  inputSchema: {},
  requiresApproval: false,
  currentVersionId: "acv_current",
} as never;

const PINNED_ROW = {
  actionVersionId: "acv_old",
  method: "POST",
  urlTemplate: "https://api.example.com/refund",
  headers: { "X-Version": "1" },
  bodyTemplate: null,
  inputSchema: {},
  requiresApproval: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockResolvedValue([PINNED_ROW]);
});

describe("with no agent on the run", () => {
  it("uses the action as it stands, which is every call made today", async () => {
    const result = await resolvePinnedDefinition(LIVE, null);

    expect(result.definition.urlTemplate).toBe("https://api.example.com/refund/v2");
    expect(result.actionVersionId).toBe("acv_current");
    expect(getPinnedActionVersionId).not.toHaveBeenCalled();
  });
});

describe("when the agent's published version pins this action", () => {
  it("runs the pinned definition, not the edited one", async () => {
    getPinnedActionVersionId.mockResolvedValue("acv_old");

    const result = await resolvePinnedDefinition(LIVE, "agt_support");

    expect(result.definition.urlTemplate).toBe("https://api.example.com/refund");
    expect(result.actionVersionId).toBe("acv_old");
  });

  it("restores the pinned approval requirement too", async () => {
    getPinnedActionVersionId.mockResolvedValue("acv_old");

    const result = await resolvePinnedDefinition(LIVE, "agt_support");

    expect(result.definition.requiresApproval).toBe(true);
  });

  it("skips the lookup when the pin is already the current version", async () => {
    getPinnedActionVersionId.mockResolvedValue("acv_current");

    const result = await resolvePinnedDefinition(LIVE, "agt_support");

    expect(result.definition.urlTemplate).toBe("https://api.example.com/refund/v2");
    expect(selectLimit).not.toHaveBeenCalled();
  });
});

describe("when the pin cannot be resolved", () => {
  it("refuses rather than substituting the action's current definition", async () => {
    getPinnedActionVersionId.mockResolvedValue("acv_deleted");
    selectLimit.mockResolvedValue([]);

    await expect(resolvePinnedDefinition(LIVE, "agt_support")).rejects.toMatchObject({
      code: "ACTION_VERSION_PIN_UNRESOLVED",
      statusCode: 409,
    });
  });

  it("names the agent, the version and what to do about it", async () => {
    getPinnedActionVersionId.mockResolvedValue("acv_deleted");
    selectLimit.mockResolvedValue([]);

    await expect(resolvePinnedDefinition(LIVE, "agt_support")).rejects.toThrow(
      /agt_support.*acv_deleted.*will not substitute/is,
    );
  });
});

describe("when the agent pins nothing for this action", () => {
  it("uses the live definition", async () => {
    getPinnedActionVersionId.mockResolvedValue(null);

    const result = await resolvePinnedDefinition(LIVE, "agt_support");

    expect(result.definition.urlTemplate).toBe("https://api.example.com/refund/v2");
  });
});
