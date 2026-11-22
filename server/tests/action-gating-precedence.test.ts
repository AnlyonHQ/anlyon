import { describe, it, expect } from "vitest";
import { applyRiskFloor, shouldGate } from "../src/core/actions/service.ts";
import type { PolicyDecision } from "../src/core/approvals/policy.ts";

function decision(over: Partial<PolicyDecision>): PolicyDecision {
  return {
    matched: true,
    effect: "require_approval",
    requiredApprovals: 1,
    matchedPolicyId: "pol_1",
    matchedPolicyVersion: 1,
    matchedActionName: null,
    explanation: "test",
    ...over,
  };
}

const NO_MATCH = decision({
  matched: false,
  matchedPolicyId: null,
  matchedPolicyVersion: null,
});

describe("a matched policy governs", () => {
  it("gates an UNGATED action  the hole this closes", () => {
    expect(shouldGate(false, decision({ effect: "require_approval" }))).toBe(true);
  });

  it("gates an ungated action so an auto_deny is recorded rather than silently run", () => {
    expect(shouldGate(false, decision({ effect: "auto_deny" }))).toBe(true);
  });

  it("lets an ungated action run when the policy auto-approves", () => {
    expect(shouldGate(false, decision({ effect: "auto_approve" }))).toBe(false);
  });

  it("still records an approval for a gated action the policy auto-approves", () => {
    expect(shouldGate(true, decision({ effect: "auto_approve" }))).toBe(true);
  });

  it("gates a gated action for the other two effects", () => {
    expect(shouldGate(true, decision({ effect: "require_approval" }))).toBe(true);
    expect(shouldGate(true, decision({ effect: "auto_deny" }))).toBe(true);
  });
});

describe("with no matching policy the action's own flag decides", () => {
  it("leaves an unflagged action executing inline", () => {
    expect(shouldGate(false, NO_MATCH)).toBe(false);
  });

  it("still gates a flagged action", () => {
    expect(shouldGate(true, NO_MATCH)).toBe(true);
  });

  it("ignores the effect carried by an unmatched decision", () => {
    expect(shouldGate(false, { ...NO_MATCH, effect: "require_approval" })).toBe(false);
    expect(shouldGate(false, { ...NO_MATCH, effect: "auto_deny" })).toBe(false);
  });
});


describe("the action's flag is a floor a policy may not lower", () => {
  it("raises a matched auto_approve to require_approval on a flagged action", () => {
    const raised = applyRiskFloor(true, decision({ effect: "auto_approve" }));

    expect(raised.effect).toBe("require_approval");
  });

  it("says which rule governed, so the audit trail is not silently rewritten", () => {
    const raised = applyRiskFloor(true, decision({ effect: "auto_approve" }));

    expect(raised.explanation).toMatch(/floor/);
    expect(raised.matchedPolicyId).toBe("pol_1");
  });

  it("lets a policy that NAMES the action lower the floor", () => {
    const kept = applyRiskFloor(true, decision({ effect: "auto_approve", matchedActionName: "notify" }));

    expect(kept.effect).toBe("auto_approve");
    expect(kept.explanation).toBe("test");
  });

  it("still raises when the decision carries no action scope at all", () => {
    const partial = { ...decision({ effect: "auto_approve" }) } as PolicyDecision;
    delete (partial as Partial<PolicyDecision>).matchedActionName;

    expect(applyRiskFloor(true, partial).effect).toBe("require_approval");
  });

  it("leaves stricter effects untouched  a floor raises, it does not clamp", () => {
    for (const effect of ["require_approval", "auto_deny"] as const) {
      expect(applyRiskFloor(true, decision({ effect })).effect).toBe(effect);
    }
  });

  it("does not touch an unflagged action, where the policy is the decision", () => {
    const untouched = applyRiskFloor(false, decision({ effect: "auto_approve" }));

    expect(untouched.effect).toBe("auto_approve");
    expect(untouched.explanation).toBe("test");
  });

  it("leaves an unmatched decision alone", () => {
    expect(applyRiskFloor(true, NO_MATCH).effect).toBe("require_approval");
    expect(applyRiskFloor(false, NO_MATCH).matched).toBe(false);
  });
});

describe("an approved function plan standing in for a write's own approval", async () => {
  const { planApprovalCovers } = await import("../src/core/actions/gating.ts");
  const plan = (over: Partial<Parameters<typeof planApprovalCovers>[0]> = {}) => ({
    approvalId: "apr_plan", decidedBy: "team" as const, requiredApprovals: 1, decidedAt: new Date(), actionVersionId: null, ...over,
  });

  it("covers a team approval that needs no more approvers than the plan had", () => {
    expect(planApprovalCovers(plan(), decision({}), null)).toBe(true);
    expect(planApprovalCovers(plan({ requiredApprovals: 2 }), decision({ requiredApprovals: 2 }), null)).toBe(true);
    expect(planApprovalCovers(plan(), decision({ requiredApprovals: 2 }), null)).toBe(false);
  });

  it("covers an end user's approval only when that end user decided the plan", () => {
    const endUsers = decision({ decidedBy: "end_user" });
    expect(planApprovalCovers(plan({ decidedBy: "end_user" }), endUsers, "alice")).toBe(true);
    expect(planApprovalCovers(plan({ decidedBy: "team" }), endUsers, "alice")).toBe(false);
    expect(planApprovalCovers(plan({ decidedBy: "end_user" }), endUsers, null)).toBe(false);
  });

  it("never covers a call a policy denies outright", () => {
    expect(planApprovalCovers(plan({ requiredApprovals: 5 }), decision({ effect: "auto_deny" }), null)).toBe(false);
  });
});
