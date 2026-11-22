import { describe, expect, it } from "vitest";
import { conditionInWords } from "./action-summary";
import {
	buildCondition,
	builderFields,
	parseCondition,
} from "./policy-builder";
import type { Action } from "./types";

const refund = {
	impact: {
		dimension: "money",
		unit: "usd",
		amount: "input.amount",
		bound: "exact",
	},
	inputSchema: {
		type: "object",
		properties: {
			amount: { type: "integer" },
			attempts: { type: "integer" },
			orderId: { type: "string" },
			reason: { type: "string", enum: ["duplicate", "fraud"] },
			to: { type: "array", items: { type: "string" } },
			urgent: { type: "boolean" },
			meta: { type: "object" },
		},
	},
} as unknown as Action;

const fields = builderFields(refund);
const field = (name: string) => {
	const found = fields.find((f) => f.name === name);
	if (!found) throw new Error(name);
	return found;
};

describe("builderFields", () => {
	it("offers each comparable input with its kind, and skips objects", () => {
		expect(fields.map((f) => [f.name, f.kind])).toEqual([
			["amount", "money"],
			["attempts", "number"],
			["orderId", "text"],
			["reason", "choice"],
			["to", "list"],
			["urgent", "flag"],
		]);
		expect(field("reason").options).toEqual(["duplicate", "fraud"]);
		expect(builderFields(undefined)).toEqual([]);
	});
});

describe("buildCondition", () => {
	it("stores money in minor units", () => {
		expect(buildCondition(field("amount"), ">", "100")).toBe(
			"input.amount > 10000",
		);
		expect(buildCondition(field("amount"), ">=", "99.95")).toBe(
			"input.amount >= 9995",
		);
		expect(buildCondition(field("amount"), ">", "1.234")).toBeNull();
	});
	it("writes numbers, counts, flags and text", () => {
		expect(buildCondition(field("attempts"), "<=", "3")).toBe(
			"input.attempts <= 3",
		);
		expect(buildCondition(field("attempts"), ">", "1.5")).toBeNull();
		expect(buildCondition(field("to"), ">", "3")).toBe("size(input.to) > 3");
		expect(buildCondition(field("urgent"), "==", "true")).toBe(
			"input.urgent == true",
		);
		expect(buildCondition(field("reason"), "!=", "fraud")).toBe(
			'input.reason != "fraud"',
		);
	});
	it("refuses what it cannot write safely", () => {
		expect(buildCondition(field("orderId"), "==", "")).toBeNull();
		expect(buildCondition(field("orderId"), "==", 'a"b')).toBeNull();
		expect(buildCondition(field("orderId"), ">", "x")).toBeNull();
	});
});

describe("parseCondition", () => {
	it("reads back what it writes", () => {
		for (const [name, op, value] of [
			["amount", ">", "100.00"],
			["attempts", "<=", "3"],
			["to", ">", "3"],
			["urgent", "==", "false"],
			["reason", "==", "fraud"],
		] as const) {
			const condition = buildCondition(field(name), op, value);
			expect(parseCondition(condition, fields)).toEqual({
				field: name,
				op,
				value,
			});
		}
	});
	it("reads single-quoted text, and leaves anything else to the editor", () => {
		expect(parseCondition("input.reason == 'fraud'", fields)).toEqual({
			field: "reason",
			op: "==",
			value: "fraud",
		});
		expect(
			parseCondition("input.amount > 1 && input.urgent", fields),
		).toBeNull();
		expect(parseCondition("input.unknown > 1", fields)).toBeNull();
		expect(parseCondition("agent.id == 'a'", fields)).toBeNull();
		expect(parseCondition("", fields)).toBeNull();
	});
	it("what the builder writes reads as a plain sentence", () => {
		expect(
			conditionInWords(buildCondition(field("amount"), ">", "100"), refund),
		).toBe("amount is more than $100.00");
	});
});
