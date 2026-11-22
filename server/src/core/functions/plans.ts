import { createHash } from "node:crypto";
import type { FunctionPlan } from "../../db/schema/functions.ts";
import { evaluatePolicies, withDefaultDecider, type PolicyDecision } from "../approvals/policy.ts";
import { canonicalJson } from "../effects/canonical.ts";
import { endUserDeciderFor } from "../workspace/defaults.ts";

export interface PlannedWrite {
  sequence: number;
  action: string;
  input: unknown;
}

export function plannedWrites(plan: FunctionPlan): PlannedWrite[] {
  return plan.writes.map((write) => ({ sequence: write.sequence, action: write.action, input: JSON.parse(write.canonicalInput) }));
}

export function planDigestOf(binding: {
  functionVersionId: string;
  inputDigest: string;
  endUserId: string | null;
  plan: FunctionPlan;
}): string {
  const material = canonicalJson({
    v: 2,
    functionVersionId: binding.functionVersionId,
    inputDigest: binding.inputDigest,
    endUserId: binding.endUserId,
    writes: binding.plan.writes.map((write) => [write.action, write.canonicalInput, write.actionVersionId ?? null]),
  });
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

export interface PlanDecision {
  effect: "require_approval" | "auto_deny";
  decidedBy: "team" | "end_user";
  requiredApprovals: number;
  matchedPolicyId: string | null;
  matchedPolicyVersion: number | null;
  explanation: string;
}

export function combinePlanDecisions(decisions: PolicyDecision[], endUserId: string | null): PlanDecision {
  const denied = decisions.find((decision) => decision.effect === "auto_deny");
  if (denied) {
    return {
      effect: "auto_deny",
      decidedBy: "team",
      requiredApprovals: 1,
      matchedPolicyId: denied.matchedPolicyId,
      matchedPolicyVersion: denied.matchedPolicyVersion,
      explanation: `A write in this plan is denied by policy. ${denied.explanation}`,
    };
  }
  const endUserDecides = endUserId !== null && decisions.length > 0 && decisions.every((decision) => decision.decidedBy === "end_user");
  const strictest = decisions.reduce<PolicyDecision | null>(
    (best, decision) => (decision.matched && (!best || decision.requiredApprovals > best.requiredApprovals) ? decision : best),
    null,
  );
  return {
    effect: "require_approval",
    decidedBy: endUserDecides ? "end_user" : "team",
    requiredApprovals: endUserDecides ? 1 : Math.max(1, ...decisions.map((decision) => (decision.matched ? decision.requiredApprovals : 1))),
    matchedPolicyId: strictest?.matchedPolicyId ?? null,
    matchedPolicyVersion: strictest?.matchedPolicyVersion ?? null,
    explanation: endUserDecides
      ? "Every write in this plan is one the end user decides, by policy or the workspace default, so the end user decides the plan."
      : `A plan with writes needs one approval of the whole plan.${strictest ? ` The strictest policy among its writes: ${strictest.explanation}` : " No policy matched its writes; applied the default (one approval by the team)."}`,
  };
}

export async function decidePlan(
  scope: { workspaceId: string; environmentId: string },
  writes: PlannedWrite[],
  endUserId: string | null,
): Promise<PlanDecision> {
  const defaultDecider = endUserId ? await endUserDeciderFor(scope.workspaceId) : "team";
  const decisions: PolicyDecision[] = [];
  for (const write of writes) {
    const payload = write.input && typeof write.input === "object" && !Array.isArray(write.input) ? (write.input as Record<string, unknown>) : {};
    const decision = await evaluatePolicies(scope.environmentId, {
      kind: "action",
      actionName: write.action,
      amount: typeof payload.amount === "number" ? payload.amount : null,
      payload,
    });
    decisions.push(withDefaultDecider(decision, endUserId, defaultDecider));
  }
  return combinePlanDecisions(decisions, endUserId);
}
