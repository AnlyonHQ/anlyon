/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
	aiReviewNote,
	applyState,
	EMPTY_BUDGETS,
	functionPlanPayload,
	needsManualAllowList,
	type PublishDraft,
	parseNameList,
	parseRunInput,
	publishBody,
	runIsSettling,
	sourceWarnings,
} from "./functions";
import type { FunctionRun, FunctionSourceFindings } from "./types";

const draft = (patch: Partial<PublishDraft> = {}): PublishDraft => ({
	language: "javascript",
	source: "export default async function run() {}",
	allowedActions: "",
	budgets: { ...EMPTY_BUDGETS },
	straightThrough: { enabled: false, actions: "", maxWrites: "1" },
	...patch,
});

const findings = (
	patch: Partial<FunctionSourceFindings> = {},
): FunctionSourceFindings => ({
	language: "javascript",
	parsed: true,
	parseError: null,
	calls: [],
	proposedAllowedActions: [],
	computedActionNames: [],
	risky: [],
	writesInLoop: [],
	...patch,
});

const planRun = (patch: Partial<FunctionRun> = {}): FunctionRun => ({
	id: "frn_plan",
	functionId: "fn_1",
	functionName: "refund-with-checks",
	functionVersionId: "fnv_1",
	mode: "plan",
	status: "awaiting_approval",
	endUserId: null,
	input: { order: "ord_1" },
	inputDigest: "sha256:in",
	output: null,
	error: null,
	logs: [],
	budget: null,
	actionCalls: 1,
	calls: [],
	plan: {
		digest: "sha256:plan",
		writes: [{ sequence: 2, action: "refund", input: { order: "ord_1" } }],
		approval: { id: "apr_1", status: "pending", decider: "team" },
		appliedByRunId: null,
	},
	planRunId: null,
	planDigest: null,
	approvalId: null,
	receipt: null,
	durationMs: 12,
	createdAt: "2026-10-24T10:00:00.000Z",
	finishedAt: "2026-10-24T10:00:01.000Z",
	...patch,
});

describe("publishBody", () => {
	it("leaves out what the API defaults: an empty allow-list and empty budgets", () => {
		const result = publishBody(draft());
		expect(result).toEqual({
			ok: true,
			body: {
				language: "javascript",
				source: "export default async function run() {}",
				straightThrough: null,
			},
		});
	});

	it("sends the accepted allow-list, the budgets set and a straight-through policy", () => {
		const result = publishBody(
			draft({
				allowedActions: "lookup-order, refund\nsend-receipt, refund",
				budgets: { ...EMPTY_BUDGETS, maxActionCalls: "10", timeoutMs: "5000" },
				straightThrough: {
					enabled: true,
					actions: "send-receipt",
					maxWrites: "1",
				},
			}),
		);
		expect(result.ok && result.body).toEqual({
			language: "javascript",
			source: "export default async function run() {}",
			allowedActions: ["lookup-order", "refund", "send-receipt"],
			budgets: { maxActionCalls: 10, timeoutMs: 5000 },
			straightThrough: { actions: ["send-receipt"], maxWrites: 1 },
		});
	});

	it("refuses an empty source, a budget out of range and a straight-through action off the list", () => {
		const result = publishBody(
			draft({
				source: "  ",
				allowedActions: "refund",
				budgets: { ...EMPTY_BUDGETS, maxCpuMs: "30001", timeoutMs: "1.5" },
				straightThrough: { enabled: true, actions: "cancel", maxWrites: "0" },
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(Object.keys(result.errors).sort()).toEqual([
			"maxCpuMs",
			"source",
			"straightThroughActions",
			"straightThroughMaxWrites",
			"timeoutMs",
		]);
	});

	it("refuses an action name the API would refuse", () => {
		const result = publishBody(draft({ allowedActions: "refund, bad.name" }));
		expect(result.ok).toBe(false);
	});
});

describe("parseNameList and parseRunInput", () => {
	it("splits on commas and whitespace and drops repeats", () => {
		expect(parseNameList(" a, b\n\na ,c ")).toEqual(["a", "b", "c"]);
	});

	it("takes an object, or empty for {}", () => {
		expect(parseRunInput("")).toEqual({ ok: true, value: {} });
		expect(parseRunInput('{"order":"ord_1"}')).toEqual({
			ok: true,
			value: { order: "ord_1" },
		});
		expect(parseRunInput("[1]").ok).toBe(false);
		expect(parseRunInput("{nope").ok).toBe(false);
	});
});

describe("source findings", () => {
	it("warns about computed names, risky APIs and writes in a loop, in line order", () => {
		const warnings = sourceWarnings(
			findings({
				computedActionNames: [{ kind: "invoke", line: 7 }],
				risky: [{ api: "fetch", category: "network", line: 3 }],
				writesInLoop: [{ action: "refund", line: 10 }],
			}),
		);
		expect(warnings.map((w) => [w.kind, w.line])).toEqual([
			["risky", 3],
			["computed", 7],
			["loop", 10],
		]);
		expect(warnings[0].message).toContain("fetch");
	});

	it("needs a typed allow-list when a name is computed or the source does not parse", () => {
		expect(needsManualAllowList(findings())).toBe(false);
		expect(
			needsManualAllowList(
				findings({ computedActionNames: [{ kind: "read", line: 1 }] }),
			),
		).toBe(true);
		expect(
			needsManualAllowList(findings({ parsed: false, parseError: "x" })),
		).toBe(true);
	});
});

describe("aiReviewNote", () => {
	it("says plainly when there is no AI review", () => {
		expect(aiReviewNote(null)).toMatch(/No AI review/);
		expect(
			aiReviewNote({
				status: "skipped",
				reason: "assistant_disabled",
				model: null,
				summary: null,
				purpose: null,
				riskyPatterns: [],
				suggestedRiskTier: null,
				confidence: null,
				truncated: false,
				reviewedAt: "2026-10-24T10:00:00.000Z",
			}),
		).toMatch(/Vigil is off/);
	});

	it("is null for a finished review", () => {
		expect(
			aiReviewNote({
				status: "reviewed",
				reason: null,
				model: "vigil-1",
				summary: "Refunds one order.",
				purpose: "refunds",
				riskyPatterns: [],
				suggestedRiskTier: "moderate",
				confidence: 0.8,
				truncated: false,
				reviewedAt: "2026-10-24T10:00:00.000Z",
			}),
		).toBeNull();
	});
});

describe("applyState", () => {
	const withApproval = (status: "pending" | "approved" | "denied") =>
		planRun({
			plan: {
				digest: "sha256:plan",
				writes: [{ sequence: 2, action: "refund", input: {} }],
				approval: { id: "apr_1", status, decider: "team" },
				appliedByRunId: null,
			},
		});

	it("opens once the plan is approved, and not before", () => {
		expect(applyState(withApproval("approved"))).toEqual({ canApply: true });
		expect(applyState(withApproval("pending")).canApply).toBe(false);
		expect(applyState(withApproval("denied")).canApply).toBe(false);
	});

	it("is closed for an applied plan, a plan with no writes and an apply run", () => {
		const applied = withApproval("approved");
		if (applied.plan) applied.plan.appliedByRunId = "frn_apply";
		expect(applyState(applied).canApply).toBe(false);
		expect(applyState(planRun({ mode: "apply", plan: null })).canApply).toBe(
			false,
		);
	});

	it("keeps reading a run that can still change", () => {
		expect(runIsSettling(planRun())).toBe(true);
		expect(runIsSettling(planRun({ status: "running" }))).toBe(true);
		expect(runIsSettling(withApproval("approved"))).toBe(false);
		expect(runIsSettling(planRun({ status: "diverged" }))).toBe(false);
	});
});

describe("functionPlanPayload", () => {
	it("reads a function plan approval's writes in order and its review summary", () => {
		expect(
			functionPlanPayload({
				kind: "function_plan",
				payload: {
					writes: [
						{ sequence: 2, action: "refund", input: { order: "ord_1" } },
						{ sequence: 3, action: "send-email", input: { to: "a@b.c" } },
					],
					review: { summary: "Refunds one order." },
				},
			}),
		).toEqual({
			writes: [
				{ action: "refund", input: { order: "ord_1" } },
				{ action: "send-email", input: { to: "a@b.c" } },
			],
			summary: "Refunds one order.",
		});
	});

	it("is null for another kind", () => {
		expect(functionPlanPayload({ kind: "action", payload: {} })).toBeNull();
	});
});
