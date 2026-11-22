import { describe, expect, it } from "vitest";
import {
	defaultChoice,
	describeImpact,
	type ImportedOperation,
	importSelection,
	parseSpec,
	suggestedChoice,
} from "./openapi-import";

const op = (overrides: Partial<ImportedOperation>): ImportedOperation => ({
	name: "PostRefunds",
	method: "POST",
	path: "/v1/refunds",
	urlTemplate: "https://api.stripe.com/v1/refunds",
	warnings: [],
	governed: true,
	impact: { dimension: "resource_mutations", amount: "1", bound: "exact" },
	requiresApproval: false,
	customized: false,
	suggestion: {
		risk: "irreversible",
		reasons: [],
		requiresApproval: true,
		impact: {
			dimension: "money",
			unit: null,
			amount: "input.amount",
			bound: "exact",
		},
		impactNote: null,
	},
	proposedVerify: null,
	verifyNote: null,
	...overrides,
});

describe("parseSpec", () => {
	it("accepts an OpenAPI 3 JSON document and refuses anything else, saying why", () => {
		expect(parseSpec('{"openapi":"3.1.0","paths":{}}')).toEqual({
			spec: { openapi: "3.1.0", paths: {} },
		});
		expect(parseSpec("")).toEqual({ error: expect.stringMatching(/Paste/) });
		expect(parseSpec("openapi: 3.0.0")).toEqual({
			error: expect.stringMatching(/reads JSON/),
		});
		expect(parseSpec('{"swagger":"2.0"}')).toEqual({
			error: expect.stringMatching(/OpenAPI 3/),
		});
		expect(parseSpec("[]")).toEqual({ error: expect.stringMatching(/object/) });
	});
});

describe("importSelection", () => {
	const refunds = op({});
	const charges = op({
		name: "GetCharges",
		method: "GET",
		path: "/v1/charges",
		governed: false,
		impact: null,
	});

	it("names no operation left on its defaults", () => {
		const rows = {
			"POST /v1/refunds": defaultChoice(refunds),
			"GET /v1/charges": defaultChoice(charges),
		};
		expect(importSelection([refunds, charges], rows)).toEqual({
			only: ["POST /v1/refunds", "GET /v1/charges"],
			operations: {},
		});
	});

	it("leaves out an operation not included", () => {
		const rows = {
			"GET /v1/charges": { ...defaultChoice(charges), include: false },
		};
		expect(importSelection([refunds, charges], rows)).toEqual({
			only: ["POST /v1/refunds"],
			operations: {},
		});
	});

	it("needs a currency before money can be accepted, then sends the suggestion", () => {
		const accepted = suggestedChoice(refunds);
		expect(
			importSelection([refunds], { "POST /v1/refunds": accepted }),
		).toEqual({
			errors: { "POST /v1/refunds": expect.stringMatching(/currency/) },
		});
		expect(
			importSelection([refunds], {
				"POST /v1/refunds": { ...accepted, unit: "EUR" },
			}),
		).toEqual({
			only: ["POST /v1/refunds"],
			operations: {
				"POST /v1/refunds": {
					requiresApproval: true,
					impact: {
						dimension: "money",
						unit: "eur",
						amount: "input.amount",
						bound: "exact",
					},
				},
			},
		});
	});

	it("sends an ungoverned choice as impact null", () => {
		const row = {
			...defaultChoice(refunds),
			mode: "custom" as const,
			impactKind: "none" as const,
		};
		expect(importSelection([refunds], { "POST /v1/refunds": row })).toEqual({
			only: ["POST /v1/refunds"],
			operations: {
				"POST /v1/refunds": { requiresApproval: false, impact: null },
			},
		});
	});

	it("refuses a declared unit that is not a unit name", () => {
		const row = {
			...defaultChoice(refunds),
			mode: "custom" as const,
			impactKind: "declared" as const,
			unit: "E-mails",
		};
		expect(importSelection([refunds], { "POST /v1/refunds": row })).toEqual({
			errors: { "POST /v1/refunds": expect.stringMatching(/lowercase/) },
		});
	});
});

describe("describeImpact", () => {
	it("says what a row counts in a few words", () => {
		expect(describeImpact(defaultChoice(op({})))).toBe("1 change");
		expect(describeImpact({ ...suggestedChoice(op({})), unit: "usd" })).toBe(
			"input.amount USD",
		);
		expect(describeImpact(suggestedChoice(op({})))).toBe(
			"input.amount (choose a currency)",
		);
		expect(describeImpact(defaultChoice(op({ impact: null })))).toBe(
			"Not governed",
		);
		expect(
			describeImpact({
				...defaultChoice(op({})),
				impactKind: "declared",
				unit: "emails",
				amount: "count(input.to)",
				bound: "upper_bound",
			}),
		).toBe("up to count(input.to) emails");
	});
});
