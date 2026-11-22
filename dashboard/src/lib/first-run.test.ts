import { describe, expect, it } from "vitest";
import {
	agentSnippet,
	DEMO_ACTION,
	DEMO_SECRET,
	demoAction,
	demoToken,
	firstRunState,
	formatElapsed,
	isStepDone,
	sandboxHost,
	sandboxReceipt,
	sandboxUrl,
	tokenWasRedacted,
} from "./first-run";
import type { Invocation } from "./types";

const invocation = (over: Partial<Invocation> = {}): Invocation => ({
	id: "inv_1",
	actionName: DEMO_ACTION,
	status: "pending_approval",
	responseStatus: null,
	body: null,
	error: null,
	durationMs: null,
	approvalId: "apr_1",
	createdAt: "2026-09-25T10:00:00Z",
	completedAt: null,
	...over,
});

const secret = [{ name: DEMO_SECRET }];
const action = [{ name: DEMO_ACTION }];

describe("first-run progress comes from what the server holds", () => {
	it("walks vault, action, call, approve, done", () => {
		expect(
			firstRunState({ secrets: [], actions: [], invocations: [] }).step,
		).toBe("vault");
		expect(
			firstRunState({ secrets: secret, actions: [], invocations: [] }).step,
		).toBe("action");
		expect(
			firstRunState({ secrets: secret, actions: action, invocations: [] }).step,
		).toBe("call");
		expect(
			firstRunState({
				secrets: secret,
				actions: action,
				invocations: [invocation()],
			}).step,
		).toBe("approve");
		expect(
			firstRunState({
				secrets: secret,
				actions: action,
				invocations: [invocation({ status: "succeeded" })],
			}).step,
		).toBe("done");
	});

	it("ignores other secrets, actions and invocations", () => {
		expect(
			firstRunState({
				secrets: [{ name: "STRIPE_KEY" }],
				actions: [{ name: "refund_order" }],
				invocations: [
					invocation({ actionName: "refund_order", status: "succeeded" }),
				],
			}).step,
		).toBe("vault");
	});

	it("sends a denied, expired or failed call back to the call step", () => {
		for (const status of ["denied", "expired", "failed"] as const) {
			const state = firstRunState({
				secrets: secret,
				actions: action,
				invocations: [invocation({ status })],
			});
			expect(state.step).toBe("call");
			expect(state.invocation?.status).toBe(status);
		}
	});

	it("reads the newest invocation", () => {
		const state = firstRunState({
			secrets: secret,
			actions: action,
			invocations: [
				invocation({
					id: "old",
					status: "denied",
					createdAt: "2026-09-25T09:00:00Z",
				}),
				invocation({
					id: "new",
					status: "pending_approval",
					createdAt: "2026-09-25T10:00:00Z",
				}),
			],
		});
		expect(state).toMatchObject({ step: "approve", invocation: { id: "new" } });
	});

	it("marks earlier steps done", () => {
		expect(isStepDone("call", "vault")).toBe(true);
		expect(isStepDone("call", "call")).toBe(false);
		expect(isStepDone("done", "approve")).toBe(true);
	});
});

describe("the demo definitions", () => {
	it("pins the token to the sandbox host and the header", () => {
		expect(sandboxUrl("https://api.anlyon.com/")).toBe(
			"https://api.anlyon.com/api/v2/public/sandbox/echo",
		);
		expect(sandboxHost("https://api.anlyon.com")).toBe("api.anlyon.com");
		const definition = demoAction("https://api.anlyon.com");
		expect(definition.headers.Authorization).toBe(
			`Bearer {{secret:${DEMO_SECRET}}}`,
		);
		expect(definition.requiresApproval).toBe(true);
		expect(definition.urlTemplate).toBe(
			"https://api.anlyon.com/api/v2/public/sandbox/echo",
		);
	});

	it("generates a single-use token", () => {
		const token = demoToken((n) => new Uint8Array(n));
		expect(token).toMatch(/^demo_sk_[a-z2-9]{24}$/);
		expect(demoToken()).not.toBe(demoToken());
	});

	it("shows the agent a name and an input, never a URL or key", () => {
		for (const language of ["typescript", "python"] as const) {
			const snippet = agentSnippet(language);
			expect(snippet).toContain(DEMO_ACTION);
			expect(snippet).not.toMatch(/sandbox|secret|Bearer/);
		}
		expect(agentSnippet("curl")).toContain("$ANLYON_AGENT_KEY");
	});
});

describe("the receipt", () => {
	it("reads the stored sandbox reply and sees the token was scrubbed", () => {
		const body = JSON.stringify({
			success: true,
			data: {
				authorization: "Bearer [REDACTED]",
				body: { orderId: "ord_1042" },
				receivedAt: "2026-09-25T10:00:01Z",
			},
		});
		const receipt = sandboxReceipt(body);
		expect(receipt).toMatchObject({ authorization: "Bearer [REDACTED]" });
		expect(tokenWasRedacted(receipt)).toBe(true);
		expect(
			tokenWasRedacted(
				sandboxReceipt(
					JSON.stringify({ data: { authorization: "Bearer demo_sk_x" } }),
				),
			),
		).toBe(false);
		expect(sandboxReceipt("not json")).toBeNull();
		expect(sandboxReceipt(null)).toBeNull();
	});

	it("formats the clock", () => {
		expect(formatElapsed(0)).toBe("0:00");
		expect(formatElapsed(134_000)).toBe("2:14");
		expect(formatElapsed(-5)).toBe("0:00");
	});
});
