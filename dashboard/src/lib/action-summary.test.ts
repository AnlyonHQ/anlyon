import { describe, expect, it } from "vitest";
import {
	actionHost,
	approvalLines,
	conditionInWords,
	formatAmount,
	gateSummary,
	inputRows,
	limitLines,
} from "./action-summary";
import type { Action, ApprovalPolicy, ImpactLimit } from "./types";

const refund = {
	name: "refund-order",
	requiresApproval: false,
	impact: {
		dimension: "money",
		unit: "usd",
		amount: "input.amount",
		bound: "exact",
	},
	inputSchema: {
		type: "object",
		properties: {
			orderId: { type: "string", pattern: "^ord_[a-z0-9]{4,20}$" },
			amount: { type: "integer" },
			reason: { type: "string", enum: ["duplicate", "fraud"] },
			note: { type: "string", description: "Shown to the reviewer" },
		},
		required: ["orderId", "amount"],
	},
} as unknown as Action;

function policy(
	over: Partial<ApprovalPolicy> & { condition?: string | null },
): ApprovalPolicy {
	const { condition, ...rest } = over;
	const base = {
		id: "apol_1",
		environmentId: "env_1",
		name: "Approve refunds over $100",
		priority: 100,
		enabled: true,
		scope: "specific_action",
		needsScopeReview: false,
		match: {
			kind: "action",
			actionName: "refund-order",
			agentId: null,
			userId: null,
			tags: null,
			minAmount: null,
			conditions: null,
			condition: null,
		},
		effect: "require_approval",
		requiredApprovals: 1,
		version: 1,
		scopeReviewedAt: null,
		createdAt: "",
		updatedAt: "",
		...rest,
	} as ApprovalPolicy;
	if (condition !== undefined) base.match = { ...base.match, condition };
	return base;
}

function limit(over: Partial<ImpactLimit>): ImpactLimit {
	return {
		id: "lim_1",
		name: "Refunds per day",
		dimension: "money",
		currency: "usd",
		unit: "usd",
		scope: { environmentId: "env_1", actionName: null, resourcePrefix: null },
		period: "day",
		limit: 50000,
		currentPeriod: "day:2026-10-12",
		consumed: 2500,
		reserved: 0,
		unknownExposure: 0,
		available: 47500,
		archived: false,
		createdAt: "",
		updatedAt: "",
		...over,
	} as ImpactLimit;
}

describe("conditionInWords", () => {
	it("reads a money comparison in the action's currency", () => {
		expect(conditionInWords("input.amount > 10000", refund)).toBe(
			"amount is more than $100.00",
		);
	});
	it("reads other numbers, list sizes and text as written", () => {
		expect(conditionInWords("input.priority >= 3", refund)).toBe(
			"priority is at least 3",
		);
		expect(conditionInWords("size(input.to) > 3", refund)).toBe(
			"to has more than 3 entries",
		);
		expect(conditionInWords("input.reason == 'fraud'", refund)).toBe(
			"reason is “fraud”",
		);
	});
	it("gives up on anything more than one comparison", () => {
		expect(
			conditionInWords("input.amount > 1 && input.reason == 'x'", refund),
		).toBeNull();
		expect(conditionInWords("agent.id == 'agt_1'", refund)).toBeNull();
		expect(conditionInWords("", refund)).toBeNull();
	});
});

describe("approvalLines and gateSummary", () => {
	it("a conditional policy is a plain sentence and makes the action sometimes need approval", () => {
		const policies = [policy({ condition: "input.amount > 10000" })];
		expect(approvalLines(policies, refund)).toEqual([
			{
				text: "A person approves calls where amount is more than $100.00",
				source: "From the policy “Approve refunds over $100”",
				code: null,
				policyId: "apol_1",
			},
		]);
		expect(gateSummary(policies, refund)).toBe("sometimes");
	});

	it("an unconditional policy, or the action's own flag, means always", () => {
		expect(gateSummary([policy({})], refund)).toBe("always");
		expect(gateSummary([], { ...refund, requiresApproval: true })).toBe(
			"always",
		);
		expect(approvalLines([policy({})], refund)[0]?.text).toBe(
			"A person approves every call",
		);
	});

	it("ignores disabled policies, other actions and custom requests", () => {
		const policies = [
			policy({ enabled: false }),
			policy({
				match: { ...policy({}).match, actionName: "close-ticket" },
			}),
			policy({
				match: { ...policy({}).match, kind: "custom", actionName: null },
			}),
		];
		expect(approvalLines(policies, refund)).toEqual([]);
		expect(gateSummary(policies, refund)).toBe("never");
	});

	it("keeps a condition it cannot put into words, and names a broad policy", () => {
		const [line] = approvalLines(
			[
				policy({
					condition: "agent.id == 'agt_1'",
					match: { ...policy({}).match, actionName: null },
				}),
			],
			refund,
		);
		expect(line?.text).toBe("A person approves some calls");
		expect(line?.code).toBe("agent.id == 'agt_1'");
		expect(line?.source).toContain("which covers every action");
	});

	it("a refusing policy says so", () => {
		expect(
			approvalLines([policy({ effect: "auto_deny" })], refund)[0]?.text,
		).toBe("Anlyon refuses every call");
	});
});

describe("limitLines", () => {
	it("lists limits that count this action's impact, with usage in words", () => {
		const limits = [
			limit({}),
			limit({
				id: "lim_2",
				dimension: "emails",
				currency: null,
				unit: "emails",
			}),
			limit({ id: "lim_3", archived: true }),
			limit({
				id: "lim_4",
				scope: {
					environmentId: "env_1",
					actionName: "other",
					resourcePrefix: null,
				},
			}),
		];
		expect(limitLines(limits, refund)).toEqual([
			{
				id: "lim_1",
				name: "Refunds per day",
				usage: "$25.00 of $500.00 used today",
			},
		]);
	});
	it("an action without an impact counts against nothing", () => {
		expect(limitLines([limit({})], { ...refund, impact: null })).toEqual([]);
	});
	it("formats counts with a singular", () => {
		const emails = { dimension: "emails", currency: null, unit: "emails" };
		expect(formatAmount(1, emails)).toBe("1 email");
		expect(formatAmount(3, emails)).toBe("3 emails");
		expect(
			formatAmount(1, {
				dimension: "resource_mutations",
				currency: null,
				unit: "resource_mutations",
			}),
		).toBe("1 change");
	});
});

describe("inputRows and actionHost", () => {
	it("describes each input in plain words", () => {
		expect(inputRows(refund)).toEqual([
			{ name: "orderId", required: true, hint: "Text" },
			{
				name: "amount",
				required: true,
				hint: "An amount in the smallest unit of the currency: 2500 is $25.00",
			},
			{ name: "reason", required: false, hint: "One of: duplicate, fraud" },
			{ name: "note", required: false, hint: "Shown to the reviewer" },
		]);
	});
	it("reads the host from a URL template", () => {
		expect(
			actionHost("https://api.hubapi.com/crm/v3/objects/{{input.id}}"),
		).toBe("api.hubapi.com");
		expect(actionHost("not a url")).toBeNull();
	});
});
