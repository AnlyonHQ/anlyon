export type DecisionSource = "policy" | "human" | "system" | "assistant";

export type DecisionCode =
  | "POLICY_DENIED"
  | "POLICY_APPROVED"
  | "HUMAN_APPROVED"
  | "HUMAN_DENIED"
  | "APPROVAL_EXPIRED"
  | "ASSISTANT_APPROVED"
  | "END_USER_ERASED";

export type InvocationDecision = {
  source: DecisionSource;
  code: DecisionCode;
  effect: "approved" | "denied" | "expired";
  explanation: string;
  policy: { id: string; name: string; version: number } | null;
  decidedAt: string;
};

const NAME_MAX = 80;

function policyRef(policy: { id: string; name: string; version: number }): string {
  return `${JSON.stringify(policy.name.slice(0, NAME_MAX))}, version ${policy.version}`;
}

export function policyDecision(
  effect: "approved" | "denied",
  policy: { id: string; name: string; version: number },
  decidedAt: Date,
): InvocationDecision {
  return {
    source: "policy",
    code: effect === "denied" ? "POLICY_DENIED" : "POLICY_APPROVED",
    effect,
    explanation:
      effect === "denied"
        ? `Denied by policy ${policyRef(policy)}. The request was not sent.`
        : `Approved by policy ${policyRef(policy)}.`,
    policy,
    decidedAt: decidedAt.toISOString(),
  };
}

export function planDecision(approvalId: string, decidedAt: Date): InvocationDecision {
  return {
    source: "human",
    code: "HUMAN_APPROVED",
    effect: "approved",
    explanation: `Approved by a reviewer as one write of the function plan ${approvalId}.`,
    policy: null,
    decidedAt: decidedAt.toISOString(),
  };
}

export function humanDecision(effect: "approved" | "denied", decidedAt: Date): InvocationDecision {
  return {
    source: "human",
    code: effect === "denied" ? "HUMAN_DENIED" : "HUMAN_APPROVED",
    effect,
    explanation: effect === "denied" ? "Denied by a reviewer. The request was not sent." : "Approved by a reviewer.",
    policy: null,
    decidedAt: decidedAt.toISOString(),
  };
}

export function assistantDecision(model: string, decidedAt: Date): InvocationDecision {
  return {
    source: "assistant",
    code: "ASSISTANT_APPROVED",
    effect: "approved",
    explanation: `Approved by Anlyon Vigil (${model.slice(0, 40)}) within the workspace's auto-approve limits.`,
    policy: null,
    decidedAt: decidedAt.toISOString(),
  };
}

export function expiredDecision(decidedAt: Date): InvocationDecision {
  return {
    source: "system",
    code: "APPROVAL_EXPIRED",
    effect: "expired",
    explanation: "The approval request expired before anyone decided it. The request was not sent.",
    policy: null,
    decidedAt: decidedAt.toISOString(),
  };
}

export function erasedDecision(decidedAt: Date): InvocationDecision {
  return {
    source: "system",
    code: "END_USER_ERASED",
    effect: "denied",
    explanation: "Cancelled: the end user this request was made for was erased. The request was not sent.",
    policy: null,
    decidedAt: decidedAt.toISOString(),
  };
}

export function toPublicDecision(raw: unknown): InvocationDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.code !== "string" || typeof d.source !== "string" || typeof d.effect !== "string") return null;
  const policy = d.policy as Record<string, unknown> | null | undefined;
  return {
    source: d.source as DecisionSource,
    code: d.code as DecisionCode,
    effect: d.effect as InvocationDecision["effect"],
    explanation: String(d.explanation ?? ""),
    policy:
      policy && typeof policy.id === "string"
        ? { id: policy.id, name: String(policy.name ?? ""), version: Number(policy.version) }
        : null,
    decidedAt: String(d.decidedAt ?? ""),
  };
}
