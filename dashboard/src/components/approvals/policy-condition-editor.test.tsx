import { describe, expect, it } from "vitest";
import type { ConditionAssist } from "@/lib/types";
import {
	appendClause,
	conditionTemplates,
	describeSample,
} from "./policy-condition-editor";

const assist = (over: Partial<ConditionAssist>): ConditionAssist => ({
	check: { valid: true },
	sample: null,
	inputFields: [],
	facts: [],
	legacyCondition: null,
	...over,
});

describe("sample trial messages", () => {
	it("says whether the policy would apply", () => {
		expect(
			describeSample("x", "{}", null, assist({ sample: { result: true } })),
		).toMatch(/would apply/);
		expect(
			describeSample("x", "{}", null, assist({ sample: { result: false } })),
		).toMatch(/would not apply/);
	});
	it("explains that an unevaluable condition requires approval", () => {
		expect(
			describeSample(
				"x",
				"{}",
				null,
				assist({ sample: { error: "No such key: amount" } }),
			),
		).toBe(
			"Would require approval: the condition could not be evaluated (No such key: amount).",
		);
	});
	it("guides the user before there is anything to try", () => {
		expect(describeSample("", "{}", null)).toMatch(/Write a condition/);
		expect(describeSample("x", "", null)).toMatch(/Paste an input/);
		expect(
			describeSample("x", "{", "The sample input is not valid JSON."),
		).toBe("The sample input is not valid JSON.");
		expect(
			describeSample(
				"x",
				"{}",
				null,
				assist({ check: { valid: false, message: "bad" } }),
			),
		).toBe("Fix the condition first.");
	});
});

describe("templates", () => {
	it("use the action's own fields, guarding optional ones with has()", () => {
		const templates = conditionTemplates([
			{
				path: "input.replicas",
				type: "double",
				optional: false,
				description: null,
			},
			{
				path: "input.region",
				type: "string",
				optional: true,
				description: null,
			},
		]);
		expect(templates.map((t) => t.source)).toEqual([
			"input.replicas >= 500",
			'has(input.region) && input.region in ["prod", "staging"]',
			'agent.id == "agt_…"',
			"has(input.region)",
		]);
	});
	it("append rather than replace", () => {
		expect(appendClause("", "a")).toBe("a");
		expect(appendClause(" x || y ", "a")).toBe("(x || y) && a");
	});
});
