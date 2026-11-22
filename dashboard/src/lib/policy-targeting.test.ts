import { describe, expect, it } from "vitest";
import type { ApprovalPolicy } from "@/lib/types";
import {
	describePolicyIntent,
	describePolicyMatch,
	needsBroadConfirmation,
	policiesForAction,
	policyFormProblem,
	scopeOf,
	targetingFor,
} from "./policy-targeting";

const policy = (
	over: Partial<ApprovalPolicy> & { id: string },
): ApprovalPolicy =>
	({
		name: over.id,
		priority: 100,
		enabled: true,
		scope: "all_requests",
		needsScopeReview: false,
		match: {
			kind: "any",
			actionName: null,
			agentId: null,
			userId: null,
			tags: null,
			minAmount: null,
			conditions: null,
		},
		effect: "require_approval",
		requiredApprovals: 1,
		version: 1,
		scopeReviewedAt: null,
		createdAt: "",
		updatedAt: "",
		...over,
	}) as ApprovalPolicy;

describe("describePolicyIntent", () => {
	it("says exactly what will be denied, and where", () => {
		expect(
			describePolicyIntent({
				effect: "auto_deny",
				scope: "specific_action",
				actionName: "refund_order",
				environmentName: "Development",
			}),
		).toBe("Deny refund_order requests in Development.");
	});

	it("spells out a broad scope rather than hiding it", () => {
		expect(
			describePolicyIntent({
				effect: "auto_deny",
				scope: "all_requests",
				actionName: "",
				environmentName: "Development",
			}),
		).toBe("Deny every request in Development.");
	});
});

describe("policy match summaries", () => {
	it("distinguishes thresholds and displays every additional restriction", () => {
		const p = policy({ id: "refund" });
		p.match = {
			...p.match,
			minAmount: 50.01,
			agentId: "agent_a",
			userId: "user_a",
			tags: ["a", "b"],
			conditions: { currency: "USD", "input.level": 2 },
		};
		const summary = describePolicyMatch(p);
		expect(summary).toContain("amount ≥ 50.01");
		expect(summary).toContain("agent = agent_a");
		expect(summary).toContain("user = user_a");
		expect(summary).toContain("all tags: a, b");
		expect(summary).toContain('payload["input.level"] equals 2');
		p.match.minAmount = 300;
		expect(describePolicyMatch(p)).toContain("amount ≥ 300");
		expect(describePolicyMatch(p)).not.toBe(summary);
		p.match.minAmount = 0;
		expect(describePolicyMatch(p)).toContain("amount ≥ 0");
	});
});

describe("targetingFor", () => {
	it("submits an exact action name only for a specific action", () => {
		expect(targetingFor("specific_action", "refund_order")).toEqual({
			matchKind: "action",
			matchActionName: "refund_order",
		});
		expect(targetingFor("all_actions", "refund_order")).toEqual({
			matchKind: "action",
			matchActionName: null,
		});
		expect(
			targetingFor("custom_requests", "refund_order").matchActionName,
		).toBeNull();
		expect(targetingFor("all_requests", "refund_order").matchKind).toBe("any");
	});
});

describe("policyFormProblem", () => {
	const base = {
		name: "refund_order_denied",
		environmentId: "env_1",
		scope: "specific_action" as const,
		actionName: "refund_order",
		effect: "auto_deny" as const,
		broadConfirmed: false,
	};

	it("accepts a scoped deny", () => {
		expect(policyFormProblem(base)).toBeNull();
	});

	it("requires an action for a specific-action policy", () => {
		expect(policyFormProblem({ ...base, actionName: "" })).toMatch(/action/i);
	});

	it("requires explicit confirmation for a broad auto-deny, and only for that", () => {
		expect(needsBroadConfirmation("all_requests", "auto_deny")).toBe(true);
		expect(needsBroadConfirmation("all_actions", "auto_deny")).toBe(true);
		expect(needsBroadConfirmation("all_actions", "require_approval")).toBe(
			false,
		);
		expect(needsBroadConfirmation("specific_action", "auto_deny")).toBe(false);
		expect(policyFormProblem({ ...base, scope: "all_requests" })).toMatch(
			/confirm/i,
		);
		expect(
			policyFormProblem({
				...base,
				scope: "all_requests",
				broadConfirmed: true,
			}),
		).toBeNull();
	});
});

describe("scopeOf / policiesForAction", () => {
	it("falls back to match for a response without scope", () => {
		const legacy = policy({ id: "a", scope: undefined as never });
		expect(scopeOf(legacy)).toBe("all_requests");
	});

	it("lists the policies that could govern an action, in evaluation order", () => {
		const refund = policy({
			id: "refund",
			priority: 50,
			scope: "specific_action",
			match: {
				...policy({ id: "x" }).match,
				kind: "action",
				actionName: "refund_order",
			},
		});
		const other = policy({
			id: "other",
			scope: "specific_action",
			match: {
				...policy({ id: "x" }).match,
				kind: "action",
				actionName: "get_order",
			},
		});
		const broad = policy({ id: "broad", priority: 10 });
		const custom = policy({
			id: "custom",
			match: { ...policy({ id: "x" }).match, kind: "custom" },
		});
		expect(
			policiesForAction([refund, other, broad, custom], "refund_order").map(
				(p) => p.id,
			),
		).toEqual(["broad", "refund"]);
	});
});
