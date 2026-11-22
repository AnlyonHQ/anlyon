import type { ApprovalPolicy, ApprovalPolicyEffect } from "@/lib/types";

export type PolicyScope =
	| "specific_action"
	| "all_actions"
	| "custom_requests"
	| "all_requests";

export const SCOPE_LABEL: Record<PolicyScope, string> = {
	specific_action: "A specific action",
	all_actions: "All actions in this environment",
	custom_requests: "Custom approval requests",
	all_requests: "All requests (advanced)",
};

export function isBroadScope(scope: PolicyScope): boolean {
	return scope === "all_actions" || scope === "all_requests";
}

export function needsBroadConfirmation(
	scope: PolicyScope,
	effect: ApprovalPolicyEffect,
): boolean {
	return effect === "auto_deny" && isBroadScope(scope);
}

export function targetingFor(
	scope: PolicyScope,
	actionName: string,
): { matchKind: "any" | "action" | "custom"; matchActionName: string | null } {
	switch (scope) {
		case "specific_action":
			return { matchKind: "action", matchActionName: actionName };
		case "all_actions":
			return { matchKind: "action", matchActionName: null };
		case "custom_requests":
			return { matchKind: "custom", matchActionName: null };
		case "all_requests":
			return { matchKind: "any", matchActionName: null };
	}
}

export function policyFormProblem(input: {
	name: string;
	environmentId: string;
	scope: PolicyScope;
	actionName: string;
	effect: ApprovalPolicyEffect;
	broadConfirmed: boolean;
}): string | null {
	if (!input.name.trim()) return "Give the policy a name.";
	if (!input.environmentId) return "Choose an environment.";
	if (input.scope === "specific_action" && !input.actionName) {
		return "Choose the action this policy applies to.";
	}
	if (
		needsBroadConfirmation(input.scope, input.effect) &&
		!input.broadConfirmed
	) {
		return "Confirm that denying everything in this scope is intended.";
	}
	return null;
}

const VERB: Record<ApprovalPolicyEffect, string> = {
	auto_deny: "Deny",
	auto_approve: "Auto-approve",
	require_approval: "Require approval for",
};

export function describePolicyIntent(input: {
	effect: ApprovalPolicyEffect;
	scope: PolicyScope;
	actionName: string;
	environmentName: string;
}): string {
	const verb = VERB[input.effect];
	const where = input.environmentName || "this environment";
	switch (input.scope) {
		case "specific_action":
			return `${verb} ${input.actionName || "the chosen action"} requests in ${where}.`;
		case "all_actions":
			return `${verb} requests for every action in ${where}.`;
		case "custom_requests":
			return `${verb} custom approval requests in ${where}.`;
		case "all_requests":
			return `${verb} every request in ${where}.`;
	}
}

export type PolicyTarget = Pick<ApprovalPolicy, "match"> & {
	scope?: PolicyScope;
};

export function scopeOf(policy: PolicyTarget): PolicyScope {
	if (policy.scope) return policy.scope;
	if (policy.match.kind === "custom") return "custom_requests";
	if (policy.match.kind === "any") return "all_requests";
	return policy.match.actionName ? "specific_action" : "all_actions";
}

export function describePolicyConditions(
	match: ApprovalPolicy["match"],
): string[] {
	const conditions: string[] = [];
	if (match.minAmount != null) conditions.push(`amount ≥ ${match.minAmount}`);
	if (match.agentId) conditions.push(`agent = ${match.agentId}`);
	if (match.userId) conditions.push(`user = ${match.userId}`);
	if (match.tags?.length) conditions.push(`all tags: ${match.tags.join(", ")}`);
	for (const [key, value] of Object.entries(match.conditions ?? {})) {
		conditions.push(
			`payload[${JSON.stringify(key)}] equals ${JSON.stringify(value)}`,
		);
	}
	if (match.condition) conditions.push(`when ${match.condition}`);
	return conditions;
}

export function describePolicyMatch(policy: PolicyTarget): string {
	const scope = scopeOf(policy);
	const target =
		scope === "specific_action"
			? `Action: ${policy.match.actionName}`
			: SCOPE_LABEL[scope];
	return [target, ...describePolicyConditions(policy.match)].join(" · ");
}

export function minimumAmountProblem(value: string): string | null {
	if (!value.trim()) return null;
	if (
		!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) ||
		!Number.isFinite(Number(value)) ||
		Number(value) < 0
	) {
		return "Enter a finite, non-negative amount, or leave blank for no minimum.";
	}
	return null;
}

export function policiesForAction(
	policies: ApprovalPolicy[],
	actionName: string,
): ApprovalPolicy[] {
	return policies
		.filter(
			(p) =>
				p.match.kind === "any" ||
				(p.match.kind === "action" &&
					(p.match.actionName === null || p.match.actionName === actionName)),
		)
		.sort((a, b) => a.priority - b.priority);
}
