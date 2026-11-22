import { describe, expect, it } from "vitest";
import {
	destinationHost,
	formatAgo,
	formatTimeLeft,
	groupForInbox,
	msLeft,
	payloadFields,
	sortForInbox,
	summarizePayload,
	urgencyOf,
} from "./approvals";
import type { Approval } from "./types";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function approval(over: Partial<Approval> & { id: string }): Approval {
	return {
		kind: "custom",
		status: "pending",
		title: "Do the thing",
		description: null,
		payload: {},
		decisionNote: null,
		requiredApprovals: 1,
		approvedCount: 0,
		matchedPolicyId: null,
		matchedPolicyVersion: null,
		policyExplanation: null,
		expiresAt: new Date(NOW + 3_600_000).toISOString(),
		decidedAt: null,
		createdAt: new Date(NOW).toISOString(),
		...over,
	};
}

const inMinutes = (m: number) => new Date(NOW + m * 60_000).toISOString();

describe("urgencyOf", () => {
	it("calls a pending approval past its expiry overdue", () => {
		expect(
			urgencyOf(approval({ id: "a", expiresAt: inMinutes(-1) }), NOW),
		).toBe("overdue");
	});

	it("tiers by time remaining", () => {
		const at = (m: number) =>
			urgencyOf(approval({ id: "a", expiresAt: inMinutes(m) }), NOW);
		expect(at(5)).toBe("critical");
		expect(at(15)).toBe("critical");
		expect(at(16)).toBe("soon");
		expect(at(120)).toBe("soon");
		expect(at(121)).toBe("later");
	});
});

describe("sortForInbox", () => {
	it("puts the soonest-expiring pending approval first, not the newest", () => {
		const urgent = approval({
			id: "urgent",
			expiresAt: inMinutes(2),
			createdAt: new Date(NOW - 3_600_000).toISOString(),
		});
		const roomy = approval({
			id: "roomy",
			expiresAt: inMinutes(20 * 60),
			createdAt: new Date(NOW).toISOString(),
		});

		expect(sortForInbox([roomy, urgent]).map((a) => a.id)).toEqual([
			"urgent",
			"roomy",
		]);
	});

	it("floats the most stale overdue approval to the very top", () => {
		const rows = [
			approval({ id: "fresh", expiresAt: inMinutes(30) }),
			approval({ id: "stale", expiresAt: inMinutes(-90) }),
			approval({ id: "justOver", expiresAt: inMinutes(-1) }),
		];
		expect(sortForInbox(rows).map((a) => a.id)).toEqual([
			"stale",
			"justOver",
			"fresh",
		]);
	});

	it("orders decided approvals most-recently-decided first", () => {
		const older = approval({
			id: "older",
			status: "approved",
			decidedAt: new Date(NOW - 7_200_000).toISOString(),
		});
		const newer = approval({
			id: "newer",
			status: "denied",
			decidedAt: new Date(NOW - 60_000).toISOString(),
		});
		expect(sortForInbox([older, newer]).map((a) => a.id)).toEqual([
			"newer",
			"older",
		]);
	});

	it("is stable across refetches so rows do not swap under the cursor", () => {
		const tie = (id: string) => approval({ id, expiresAt: inMinutes(10) });
		const rows = [tie("b"), tie("a"), tie("c")];
		expect(sortForInbox(rows).map((a) => a.id)).toEqual(["a", "b", "c"]);
		expect(
			sortForInbox([tie("c"), tie("b"), tie("a")]).map((a) => a.id),
		).toEqual(["a", "b", "c"]);
	});

	it("does not mutate its input", () => {
		const rows = [
			approval({ id: "b", expiresAt: inMinutes(60) }),
			approval({ id: "a", expiresAt: inMinutes(5) }),
		];
		sortForInbox(rows);
		expect(rows.map((a) => a.id)).toEqual(["b", "a"]);
	});
});

describe("formatTimeLeft", () => {
	it("reads as a countdown at every scale", () => {
		expect(formatTimeLeft(9_000)).toBe("9s");
		expect(formatTimeLeft(14 * 60_000)).toBe("14m");
		expect(formatTimeLeft(3 * 3_600_000 + 20 * 60_000)).toBe("3h 20m");
		expect(formatTimeLeft(5 * 3_600_000)).toBe("5h");
		expect(formatTimeLeft(50 * 3_600_000)).toBe("2d 2h");
		expect(formatTimeLeft(48 * 3_600_000)).toBe("2d");
	});

	it("says overdue rather than printing a negative", () => {
		expect(formatTimeLeft(-1)).toBe("overdue");
		expect(formatTimeLeft(0)).toBe("overdue");
	});
});

describe("summarizePayload", () => {
	it("pulls the stakes out of a gated action payload", () => {
		const a = approval({
			id: "a",
			kind: "action",
			payload: {
				invocationId: "inv_1",
				actionId: "act_1",
				actionName: "refund-customer",
				method: "post",
				urlTemplate: "https://api.stripe.com/v1/refunds",
				input: { orderId: "ord_42", amount: 129.99 },
			},
		});
		expect(summarizePayload(a)).toEqual({
			method: "POST",
			target: "refund-customer",
			amount: 129.99,
			destructive: false,
		});
	});

	it("flags DELETE, and only DELETE, as destructive", () => {
		const del = approval({
			id: "d",
			payload: { method: "DELETE", urlTemplate: "https://api/volumes/{id}" },
		});
		expect(summarizePayload(del).destructive).toBe(true);

		const looksScary = approval({
			id: "s",
			payload: { method: "POST", urlTemplate: "https://api/delete-preview" },
		});
		expect(summarizePayload(looksScary).destructive).toBe(false);
	});

	it("falls back to the url template when there is no action name", () => {
		const a = approval({
			id: "a",
			payload: { method: "GET", urlTemplate: "https://api/things" },
		});
		expect(summarizePayload(a).target).toBe("https://api/things");
	});

	it("reads a top-level amount from a custom approval", () => {
		expect(
			summarizePayload(approval({ id: "a", payload: { amount: 5 } })).amount,
		).toBe(5);
	});

	it("survives an empty or shapeless payload", () => {
		expect(summarizePayload(approval({ id: "a", payload: {} }))).toEqual({
			method: undefined,
			target: undefined,
			amount: undefined,
			destructive: false,
		});
		expect(
			summarizePayload(
				approval({ id: "b", payload: { input: "not an object" } }),
			).amount,
		).toBeUndefined();
	});
});

describe("msLeft", () => {
	it("counts down from the expiry", () => {
		expect(msLeft(approval({ id: "a", expiresAt: inMinutes(2) }), NOW)).toBe(
			120_000,
		);
	});
});

describe("destinationHost", () => {
	it("returns only the host, never the path or query that can carry input", () => {
		expect(
			destinationHost(
				approval({
					id: "a",
					payload: {
						urlTemplate:
							"https://api.shop.test/v1/orders/{{input.id}}?t={{secret:TOKEN}}",
					},
				}),
			),
		).toBe("api.shop.test");
		expect(destinationHost(approval({ id: "b" }))).toBeUndefined();
		expect(
			destinationHost(
				approval({ id: "c", payload: { urlTemplate: "not a url" } }),
			),
		).toBeUndefined();
	});
});

describe("payloadFields", () => {
	it("flattens an action's input into dot paths", () => {
		const { fields, truncated } = payloadFields(
			approval({
				id: "a",
				kind: "action",
				payload: {
					actionName: "refund",
					input: {
						charge: "ch_1",
						amount: 40,
						meta: { ticket: "T-1" },
						tags: ["a", "b"],
					},
				},
			}),
		);
		expect(fields).toEqual([
			{ key: "charge", value: "ch_1" },
			{ key: "amount", value: "40" },
			{ key: "meta.ticket", value: "T-1" },
			{ key: "tags", value: '["a","b"]' },
		]);
		expect(truncated).toBe(false);
	});

	it("reads a custom approval's payload, and caps the number of rows", () => {
		const payload = Object.fromEntries(
			Array.from({ length: 50 }, (_, i) => [`k${i}`, i]),
		);
		const { fields, truncated } = payloadFields(
			approval({ id: "a", payload }),
			{ maxFields: 10 },
		);
		expect(fields).toHaveLength(10);
		expect(truncated).toBe(true);
	});
});

describe("groupForInbox", () => {
	it("groups pending work by how soon it runs out, in list order", () => {
		const groups = groupForInbox(
			[
				approval({ id: "a", expiresAt: inMinutes(5) }),
				approval({ id: "b", expiresAt: inMinutes(60) }),
				approval({ id: "c", expiresAt: inMinutes(600) }),
			],
			NOW,
		);
		expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
			["Expiring in 15 minutes", ["a"]],
			["Within 2 hours", ["b"]],
			["Later", ["c"]],
		]);
	});

	it("groups decided work by day", () => {
		const groups = groupForInbox(
			[
				approval({
					id: "a",
					status: "approved",
					decidedAt: new Date(NOW - 60_000).toISOString(),
				}),
			],
			NOW,
		);
		expect(groups[0].label).toBe("Today");
	});
});

describe("formatAgo", () => {
	it("reads as elapsed time", () => {
		expect(formatAgo(new Date(NOW - 30_000).toISOString(), NOW)).toBe(
			"just now",
		);
		expect(formatAgo(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe(
			"12m ago",
		);
		expect(formatAgo(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe(
			"3h ago",
		);
		expect(formatAgo(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe(
			"2d ago",
		);
	});
});
