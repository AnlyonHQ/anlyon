import { beforeEach, describe, expect, it, vi } from "vitest";

const { environment, select, policies, action } = vi.hoisted(() => ({
  environment: vi.fn(), select: vi.fn(), policies: vi.fn(), action: vi.fn(),
}));
vi.mock("../src/core/environments/service.ts", () => ({ getEnvironment: environment }));
vi.mock("../src/db/index.ts", () => ({ db: { select } }));
const { previewPolicies } = await import("../src/core/approvals/policy.ts");
const { evaluateApprovalPoliciesSchema } = await import("../src/utils/validation.ts");

const rule = {
  policyId: "apol_refund", name: "refund review", version: 2, matchKind: "action",
  matchActionName: "refund_order", matchAgentId: null, matchUserId: null, matchTags: null,
  minAmount: "50.01", conditions: null, effect: "require_approval", requiredApprovals: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  environment.mockResolvedValue({ id: "env_test" });
  action.mockResolvedValue([{ id: "action_row" }]);
  policies.mockResolvedValue([rule]);
  select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: action, orderBy: policies }) }) }));
});

describe("policy-only preview", () => {
  it.each([[50, false], [50.01, true], [120, true]])("uses production inclusive matching at %s", async (amount, matched) => {
    const result = await previewPolicies("ws", "env_test", { kind: "action", actionName: "refund_order", payload: { amount } });
    expect(environment).toHaveBeenCalledWith("ws", "env_test");
    expect(result.evaluation).toBe("policy_only");
    expect(result.decision.matched).toBe(matched);
    expect(result.limitations).toContain("unmatched ungated action");
    if (matched) expect(result.decision.matchedPolicyVersion).toBe(2);
  });

  it("cannot escape an attribution-scoped policy by omitting identity", async () => {
    policies.mockResolvedValue([{ ...rule, matchAgentId: "agt_finance", effect: "auto_deny" }]);
    const result = await previewPolicies("ws", "env_test", { kind: "action", actionName: "refund_order", payload: { amount: 120 } });
    expect(result.decision).toMatchObject({ matched: true, effect: "require_approval", matchedPolicyId: "apol_refund" });
  });

  it("does not read policies after workspace/environment authorization fails", async () => {
    environment.mockRejectedValue(new Error("not found"));
    await expect(previewPolicies("other_ws", "env_test", { kind: "custom" })).rejects.toThrow("not found");
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects an action not present in the selected environment", async () => {
    action.mockResolvedValue([]);
    await expect(previewPolicies("ws", "env_test", { kind: "action", actionName: "missing" })).rejects.toThrow("No action");
    expect(policies).not.toHaveBeenCalled();
  });

  it("derives custom tags and amount from payload, as production does", async () => {
    policies.mockResolvedValue([{ ...rule, matchKind: "custom", matchActionName: null, matchTags: ["finance"] }]);
    const result = await previewPolicies("ws", "env_test", { kind: "custom", payload: { amount: 80, tags: ["finance"] } });
    expect(result.decision.matched).toBe(true);
    expect(action).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "action" },
    { kind: "custom", actionName: "refund_order" },
    { kind: "custom", environmentId: "another" },
    { kind: "custom", amount: 100 },
    { kind: "custom", payload: { tags: "finance" } },
  ])("rejects ambiguous or unsupported context %j", (context) => {
    expect(evaluateApprovalPoliciesSchema.safeParse(context).success).toBe(false);
  });
});
