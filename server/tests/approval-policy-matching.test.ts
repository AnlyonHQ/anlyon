import { describe, it, expect, vi, beforeEach } from "vitest";

const selectRows = vi.fn();

vi.mock("../src/db/index.ts", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => selectRows() }) }) }),
  },
}));

const { evaluatePolicies } = await import("../src/core/approvals/policy.ts");

const ENV = "env_1";

function policy(over: Record<string, unknown> = {}) {
  return {
    policyId: "pol_agent",
    name: "finance agent needs two",
    version: 1,
    priority: 10,
    enabled: true,
    matchKind: "any",
    matchActionName: null,
    matchAgentId: null,
    matchUserId: null,
    matchTags: null,
    minAmount: null,
    conditions: null,
    effect: "require_approval",
    requiredApprovals: 2,
    ...over,
  };
}

const CATCH_ALL_APPROVE = policy({
  policyId: "pol_all",
  name: "everything else runs",
  priority: 20,
  effect: "auto_approve",
  requiredApprovals: 1,
});

const ACTION_CTX = { kind: "action" as const, actionName: "refund" };

beforeEach(() => vi.clearAllMocks());

describe("matchAgentId", () => {
  it("matches the agent it names", async () => {
    selectRows.mockResolvedValue([policy({ matchAgentId: "agt_finance" }), CATCH_ALL_APPROVE]);

    const decision = await evaluatePolicies(ENV, { ...ACTION_CTX, agentId: "agt_finance" });

    expect(decision).toMatchObject({
      matched: true,
      effect: "require_approval",
      requiredApprovals: 2,
      matchedPolicyId: "pol_agent",
    });
  });

  it("does not match a different agent, which falls through as intended", async () => {
    selectRows.mockResolvedValue([policy({ matchAgentId: "agt_finance" }), CATCH_ALL_APPROVE]);

    const decision = await evaluatePolicies(ENV, { ...ACTION_CTX, agentId: "agt_support" });

    expect(decision).toMatchObject({ effect: "auto_approve", matchedPolicyId: "pol_all" });
  });

  it("refuses to fall through when the request names no agent at all", async () => {
    selectRows.mockResolvedValue([policy({ matchAgentId: "agt_finance" }), CATCH_ALL_APPROVE]);

    const decision = await evaluatePolicies(ENV, { ...ACTION_CTX, agentId: null });

    expect(decision.effect).toBe("require_approval");
    expect(decision.matchedPolicyId).toBe("pol_agent");
    expect(decision.explanation).toMatch(/named none/);
  });
});

describe("matchUserId", () => {
  it("matches the user it names", async () => {
    selectRows.mockResolvedValue([
      policy({ policyId: "pol_user", matchUserId: "user_42" }),
      CATCH_ALL_APPROVE,
    ]);

    const decision = await evaluatePolicies(ENV, { ...ACTION_CTX, userId: "user_42" });

    expect(decision).toMatchObject({ matched: true, matchedPolicyId: "pol_user" });
  });

  it("refuses to fall through when the request names no user", async () => {
    selectRows.mockResolvedValue([
      policy({ policyId: "pol_user", matchUserId: "user_42" }),
      CATCH_ALL_APPROVE,
    ]);

    const decision = await evaluatePolicies(ENV, { ...ACTION_CTX, userId: null });

    expect(decision.effect).toBe("require_approval");
    expect(decision.matchedPolicyId).toBe("pol_user");
  });
});

describe("unscoped policies are unaffected", () => {
  it("still matches first by priority", async () => {
    selectRows.mockResolvedValue([policy({ matchActionName: "refund" }), CATCH_ALL_APPROVE]);

    const decision = await evaluatePolicies(ENV, ACTION_CTX);

    expect(decision).toMatchObject({ matched: true, matchedPolicyId: "pol_agent" });
  });

  it("reports no match when nothing applies, so the caller can use its own default", async () => {
    selectRows.mockResolvedValue([policy({ matchActionName: "something-else" })]);

    const decision = await evaluatePolicies(ENV, ACTION_CTX);

    expect(decision.matched).toBe(false);
    expect(decision.effect).toBe("require_approval");
  });
});

describe("minAmount", () => {
  const AMOUNT_GATE = policy({ policyId: "pol_amount", name: "large refunds need two", minAmount: "1000" });

  it("governs at or above the minimum and falls through below it", async () => {
    selectRows.mockResolvedValue([AMOUNT_GATE, CATCH_ALL_APPROVE]);
    expect(await evaluatePolicies(ENV, { ...ACTION_CTX, amount: 5000 })).toMatchObject({ matchedPolicyId: "pol_amount", effect: "require_approval" });
    expect(await evaluatePolicies(ENV, { ...ACTION_CTX, amount: 10 })).toMatchObject({ matchedPolicyId: "pol_all", effect: "auto_approve" });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["a string", "5000"],
    ["not finite", Number.NaN],
  ])("requires approval when the amount is %s instead of skipping the gate", async (_label, amount) => {
    selectRows.mockResolvedValue([AMOUNT_GATE, CATCH_ALL_APPROVE]);
    const decision = await evaluatePolicies(ENV, { ...ACTION_CTX, amount: amount as number | null | undefined });
    expect(decision).toMatchObject({
      matched: true,
      effect: "require_approval",
      requiredApprovals: 2,
      matchedPolicyId: "pol_amount",
    });
    expect(decision.explanation).toMatch(/no numeric amount/);
  });

  it("requires approval even when the amount-gated policy itself auto-approves", async () => {
    selectRows.mockResolvedValue([policy({ policyId: "pol_amount", minAmount: "1000", effect: "auto_approve" })]);
    expect(await evaluatePolicies(ENV, ACTION_CTX)).toMatchObject({ matched: true, effect: "require_approval" });
  });

  it("stays a no-match when its conditions already rule the request out", async () => {
    selectRows.mockResolvedValue([
      policy({ policyId: "pol_amount", minAmount: "1000", conditions: { currency: "EUR" } }),
      CATCH_ALL_APPROVE,
    ]);
    const decision = await evaluatePolicies(ENV, { ...ACTION_CTX, payload: { currency: "USD" } });
    expect(decision.matchedPolicyId).toBe("pol_all");
  });
});
