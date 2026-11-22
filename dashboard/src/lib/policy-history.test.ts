import { describe, expect, it } from "vitest";
import { locateVersion, summarizeSnapshot } from "@/lib/policy-history";
import type { ApprovalPolicyVersion } from "@/lib/types";

const version = (n: number): ApprovalPolicyVersion => ({
	policyId: "apol_1",
	version: n,
	operation: "updated",
	snapshot: {},
	contentHash: "h",
	actor: null,
	changeNote: null,
	createdAt: "2026-09-27T00:00:00Z",
});

describe("summarizeSnapshot", () => {
	it("reads the stored snake_case row, including every restriction", () => {
		expect(
			summarizeSnapshot({
				name: "refunds",
				effect: "auto_deny",
				match_kind: "action",
				match_action_name: "refund_order",
				match_agent_id: "agt_finance",
				match_tags: null,
				min_amount: 50.01,
				conditions: { currency: "USD" },
				required_approvals: 2,
				priority: 10,
				enabled: false,
			}),
		).toEqual({
			name: "refunds",
			effect: "auto_deny",
			requiredApprovals: 2,
			priority: 10,
			enabled: false,
			appliesTo:
				'Action: refund_order · amount ≥ 50.01 · agent = agt_finance · payload["currency"] equals "USD"',
		});
	});

	it("accepts a numeric string threshold and treats zero as a real threshold", () => {
		expect(
			summarizeSnapshot({ match_kind: "custom", min_amount: "0" }).appliesTo,
		).toContain("amount ≥ 0");
	});

	it("reports missing fields as absent instead of guessing", () => {
		expect(summarizeSnapshot({})).toMatchObject({
			name: null,
			effect: null,
			requiredApprovals: null,
			priority: null,
			enabled: null,
		});
		expect(summarizeSnapshot({ effect: "allow_everything" }).effect).toBeNull();
	});
});

describe("locateVersion", () => {
	const loaded = [version(9), version(8), version(7)];
	it("distinguishes loaded, pre-history and not-yet-loaded versions", () => {
		expect(locateVersion(loaded, 3, 8)).toBe("loaded");
		expect(locateVersion(loaded, 3, 2)).toBe("before_history");
		expect(locateVersion(loaded, 3, 5)).toBe("elsewhere");
		expect(locateVersion(loaded, undefined, 1)).toBe("elsewhere");
	});
});
