import type { PolicyDecision } from "../approvals/policy.ts";

export function applyRiskFloor(requiresApproval: boolean, decision: PolicyDecision): PolicyDecision {
  if (!requiresApproval || decision.effect !== "auto_approve") return decision;
  if (decision.matchedActionName != null) return decision;

  return {
    ...decision,
    effect: "require_approval",
    explanation:
      `${decision.explanation} Raised to require_approval: this action's requiresApproval flag is a ` +
      `floor, and only a policy naming this action may lower it.`,
  };
}

export function shouldGate(requiresApproval: boolean, decision: PolicyDecision): boolean {
  if (decision.matched) return requiresApproval || decision.effect !== "auto_approve";
  return requiresApproval;
}

export interface PlanApprovalCover {
  approvalId: string;
  decidedBy: "team" | "end_user";
  requiredApprovals: number;
  decidedAt: Date;
  actionVersionId: string | null;
}

export function planApprovalCovers(plan: PlanApprovalCover, decision: PolicyDecision, endUserId: string | null): boolean {
  if (decision.effect === "auto_deny") return false;
  const decider = decision.decidedBy === "end_user" && endUserId ? "end_user" : "team";
  if (plan.decidedBy !== decider) return false;
  return decider === "end_user" || plan.requiredApprovals >= decision.requiredApprovals;
}
