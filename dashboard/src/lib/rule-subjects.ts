import type { ApprovalPolicy, ImpactLimit } from "./types";

export interface DecidedBy {
	label: string;
	note?: string;
}

export function policyDecidedBy(policy: ApprovalPolicy): DecidedBy {
	if (policy.effect !== "require_approval") return { label: "Automatic" };
	if (policy.decidedBy === "end_user") {
		return { label: "The user", note: "Your team on workspace calls" };
	}
	return { label: "Your team" };
}

export function limitAllowance(limit: ImpactLimit): string {
	return limit.scope.kind === "end_user"
		? "Each user has their own; workspace calls share one"
		: "One allowance for every call";
}
