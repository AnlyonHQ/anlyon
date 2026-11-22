import { describe, expect, it } from "vitest";
import {
	adviceSignals,
	autoApproveNote,
	envelopeMisses,
	projectMonthly,
	replayLimits,
} from "@/lib/assistant";
import type {
	Approval,
	AssistantAdvice,
	AssistantAutoApprove,
} from "@/lib/types";

const advice = (over: Partial<AssistantAdvice> = {}): AssistantAdvice => ({
	status: "ready",
	statusReason: null,
	model: "vigil-1",
	recommendation: "approve",
	risk: 0.5,
	riskLevel: "low",
	confidence: 0.95,
	reasons: [],
	flags: {
		injectionSuspected: 0.02,
		consistentWithHistory: 0.9,
		amountUnusual: 0.1,
	},
	history: { approved: 30, denied: 0, maxAmount: 100, medianAmount: 40 },
	auditRequested: false,
	auditVerdict: null,
	createdAt: "2026-09-24T00:00:00Z",
	completedAt: "2026-09-24T00:00:01Z",
	...over,
});

const approval = (over: Partial<Approval> = {}): Approval => ({
	id: `apr_${Math.random().toString(36).slice(2)}`,
	kind: "action",
	status: "approved",
	title: "Run action refund_order",
	description: null,
	payload: { actionName: "refund_order", input: { amount: 40 } },
	decisionNote: null,
	requiredApprovals: 1,
	approvedCount: 1,
	matchedPolicyId: null,
	matchedPolicyVersion: null,
	policyExplanation: null,
	decisionOrigin: "human",
	expiresAt: "2026-09-25T00:00:00Z",
	decidedAt: "2026-09-24T00:00:00Z",
	createdAt: "2026-09-24T00:00:00Z",
	advice: advice(),
	...over,
});

const limits: AssistantAutoApprove = {
	enabled: true,
	actions: ["refund_order"],
	maxAmount: 100,
	minConfidence: 0.9,
	maxRisk: 1,
	minHistory: 20,
};

describe("adviceSignals", () => {
	it("passes a routine request on every check", () => {
		const signals = adviceSignals(advice(), 40);
		expect(signals.map((s) => [s.id, s.state])).toEqual([
			["risk", "pass"],
			["history", "pass"],
			["amount", "pass"],
			["injection", "pass"],
		]);
	});

	it("flags high risk, a prior denial, an amount above anything approved, and injected text", () => {
		const signals = adviceSignals(
			advice({
				risk: 3.2,
				riskLevel: "high",
				flags: {
					injectionSuspected: 0.7,
					consistentWithHistory: 0.9,
					amountUnusual: 0.2,
				},
				history: { approved: 30, denied: 1, maxAmount: 100, medianAmount: 40 },
			}),
			500,
		);
		expect(Object.fromEntries(signals.map((s) => [s.id, s.state]))).toEqual({
			risk: "fail",
			history: "warn",
			amount: "warn",
			injection: "fail",
		});
	});

	it("omits the amount check when the request has no amount", () => {
		expect(
			adviceSignals(advice(), undefined).some((s) => s.id === "amount"),
		).toBe(false);
	});
});

describe("envelopeMisses", () => {
	it("mirrors the server: all rules hold, nothing missed", () => {
		expect(envelopeMisses(approval(), advice(), limits)).toEqual([]);
	});

	it("names each rule that fails", () => {
		expect(
			envelopeMisses(approval({ requiredApprovals: 2 }), advice(), limits),
		).toContain("needs more than one approver");
		expect(
			envelopeMisses(
				approval({ payload: { actionName: "delete_customer", input: {} } }),
				advice(),
				limits,
			),
		).toContain("action not on the list");
		expect(
			envelopeMisses(approval(), advice({ confidence: 0.85 }), limits),
		).toContain("confidence too low");
		expect(
			envelopeMisses(approval(), advice(), { ...limits, minConfidence: 0.5 }),
		).toEqual([]);
		expect(
			envelopeMisses(
				approval({
					payload: { actionName: "refund_order", input: { amount: 101 } },
				}),
				advice(),
				limits,
			),
		).toContain("amount above the cap");
	});
});

describe("replayLimits", () => {
	it("counts what the limits would have approved, and any of those a person denied", () => {
		const rows = [
			approval(),
			approval(),
			approval({ status: "denied" }),
			approval({ payload: { actionName: "delete_customer", input: {} } }),
			approval({ status: "pending" }),
			approval({ advice: advice({ status: "failed" }) }),
		];
		const result = replayLimits(rows, limits);
		expect(result.considered).toBe(4);
		expect(result.wouldApprove).toHaveLength(3);
		expect(result.wouldApproveDenied).toHaveLength(1);
		expect(result.leftForPeople).toBe(1);
		expect(result.topMiss).toEqual({
			reason: "action not on the list",
			count: 1,
		});
	});
});

describe("autoApproveNote", () => {
	it("finds the reason the server left a request with a person", () => {
		expect(
			autoApproveNote(
				advice({
					reasons: [
						"Suggests approve",
						"Left for a person: Auto-approve is off",
					],
				}),
			),
		).toBe("Auto-approve is off");
		expect(
			autoApproveNote(advice({ reasons: ["Suggests approve"] })),
		).toBeNull();
	});
});

describe("projectMonthly", () => {
	it("projects month-end usage from the pace so far", () => {
		const { perDay, projected, daysInMonth } = projectMonthly(
			300,
			new Date(Date.UTC(2026, 8, 11)),
		);
		expect(daysInMonth).toBe(30);
		expect(perDay).toBe(30);
		expect(projected).toBe(900);
	});
});
