/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEMO_ACTION,
	DEMO_SECRET,
	type FirstRunStep,
	firstRunState,
} from "@/lib/first-run";
import type { Invocation, InvocationStatus } from "@/lib/types";
import { FirstRunTour } from "./first-run-tour";

const tour = vi.hoisted(() => ({
	step: "vault" as FirstRunStep,
	invocation: null as Invocation | null,
}));
const calls = vi.hoisted(() => ({
	storeSecret: vi.fn(),
	defineAction: vi.fn(),
	callAsAgent: vi.fn(),
	decide: vi.fn(),
	reset: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to }: { children: ReactNode; to: string }) => (
		<a href={to}>{children}</a>
	),
}));
vi.mock("@/hooks/api/use-first-run", () => ({
	useFirstRun: () => ({ ...tour, loading: false, error: null }),
	useSandboxToken: () => ({ token: "demo_sk_v1.d3NfMQ.nonce.signature" }),
	useFirstRunMutations: () =>
		Object.fromEntries(
			Object.entries(calls).map(([key, mutate]) => [
				key,
				{ mutate, isPending: false, error: null },
			]),
		),
}));

afterEach(() => {
	cleanup();
	for (const fn of Object.values(calls)) fn.mockReset();
	tour.step = "vault";
	tour.invocation = null;
});

const invocation = (over: Partial<Invocation> = {}): Invocation => ({
	id: "inv_7Qk2",
	actionName: "demo-refund-order",
	status: "pending_approval",
	responseStatus: null,
	body: null,
	error: null,
	durationMs: null,
	approvalId: "apr_91",
	createdAt: "2026-09-25T10:00:00Z",
	completedAt: null,
	...over,
});

describe("First-run tour", () => {
	it("opens on the vault and seals the server-minted single-use token", () => {
		render(<FirstRunTour workspaceId="ws_1" />);
		expect(
			screen.getByRole("heading", { level: 2, name: /governed action/ })
				.textContent,
		).toMatch(/One governed action, start to finish/);
		const current = screen.getByRole("listitem", { current: "step" });
		expect(current.textContent).toContain("The credential");
		fireEvent.click(screen.getByRole("button", { name: "Seal" }));
		expect(calls.storeSecret).toHaveBeenCalledWith(
			"demo_sk_v1.d3NfMQ.nonce.signature",
		);
	});

	it("shows the agent's call without a URL or key, and runs it", () => {
		tour.step = "call";
		render(<FirstRunTour workspaceId="ws_1" />);
		expect(screen.getByText(/No URL, no header, no key/)).toBeTruthy();
		fireEvent.click(screen.getByRole("tab", { name: "agent.py" }));
		expect(screen.getByText(/anlyon\.actions\.invoke/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Run" }));
		expect(calls.callAsAgent).toHaveBeenCalled();
	});

	it("explains a denied call and lets them run it again", () => {
		tour.step = "call";
		tour.invocation = invocation({ status: "denied" });
		render(<FirstRunTour workspaceId="ws_1" />);
		expect(screen.getByText(/Last run denied: nothing was sent/)).toBeTruthy();
	});

	it("approves the held request by its approval id", () => {
		tour.step = "approve";
		tour.invocation = invocation();
		render(<FirstRunTour workspaceId="ws_1" />);
		expect(screen.getByText(/Nothing has been sent/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		expect(calls.decide).toHaveBeenCalledWith({
			approvalId: "apr_91",
			decision: "approve",
		});
	});

	it("ends on a receipt that proves the token never came back", () => {
		tour.step = "done";
		tour.invocation = invocation({
			status: "succeeded",
			responseStatus: 200,
			durationMs: 212,
			body: JSON.stringify({
				success: true,
				data: { authorization: "Bearer [REDACTED]", body: {} },
			}),
		});
		render(<FirstRunTour workspaceId="ws_1" />);
		const receipt = screen.getByRole("region", {
			name: "What was sent and returned",
		});
		expect(receipt.textContent).toContain("Bearer [REDACTED]");
		expect(receipt.textContent).toContain("Anlyon scrubbed it");
		expect(screen.getByText("Write an approval policy")).toBeTruthy();
		expect(
			screen.getByText("Sent. Your agent never saw the key."),
		).toBeTruthy();
		expect(screen.getByText(/DEMO_API_TOKEN sealed/)).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: /Remove the demo and start over/ }),
		);
		expect(calls.reset).toHaveBeenCalled();
	});

	it("does not say an unknown outcome was sent", () => {
		tour.step = "done";
		tour.invocation = invocation({ status: "unknown" });
		render(<FirstRunTour workspaceId="ws_1" />);
		expect(
			screen.getByText("Outcome unknown. Your agent never saw the key."),
		).toBeTruthy();
		expect(
			screen.getByText(
				"No usable response. Anlyon does not send it again. It stays unknown until a read-back or an operator settles it.",
			),
		).toBeTruthy();
		expect(screen.queryByText(/^Sent\./)).toBeNull();
		expect(screen.queryByText("What the API received")).toBeNull();
		expect(screen.queryByText(/sent with the token attached/)).toBeNull();
		expect(screen.getByText(/outcome unknown/)).toBeTruthy();
	});

	it("does not say a running call was sent", () => {
		tour.step = "done";
		tour.invocation = invocation({ status: "running" });
		render(<FirstRunTour workspaceId="ws_1" />);
		expect(
			screen.getByText("Approved. Your agent never saw the key."),
		).toBeTruthy();
		expect(screen.queryByText(/^Sent\./)).toBeNull();
	});
});

const EVERY_STATUS: Record<InvocationStatus, true> = {
	pending_approval: true,
	running: true,
	succeeded: true,
	failed: true,
	unknown: true,
	denied: true,
	expired: true,
};

const CLAIMS_SENT = [
	/(^|[^\w])Sent\./,
	/sent with the token attached/i,
	/What the API received/,
	/\bsucceeded\b/i,
	/\bdelivered\b/i,
	/\bcompleted\b/i,
];

describe("First-run tour, for every invocation status", () => {
	const statuses = Object.keys(EVERY_STATUS) as InvocationStatus[];

	it.each(statuses)("%s: says sent only when the call succeeded", (status) => {
		const latest = invocation({ status });
		const state = firstRunState({
			secrets: [{ name: DEMO_SECRET }],
			actions: [{ name: DEMO_ACTION }],
			invocations: [latest],
		});
		tour.step = state.step;
		tour.invocation = state.invocation;
		const { container } = render(<FirstRunTour workspaceId="ws_1" />);
		const text = container.textContent ?? "";
		const headings = screen
			.getAllByRole("heading")
			.map((heading) => heading.textContent ?? "");

		if (status === "succeeded") {
			expect(headings).toContain("Sent. Your agent never saw the key.");
			expect(text).toContain("What the API received");
			return;
		}
		for (const heading of headings) {
			for (const claim of CLAIMS_SENT) expect(heading).not.toMatch(claim);
		}
		for (const claim of CLAIMS_SENT) expect(text).not.toMatch(claim);
	});

	it("finishes the tour on a call that ran, is running or is unknown, and on nothing else", () => {
		const done = statuses.filter(
			(status) =>
				firstRunState({
					secrets: [{ name: DEMO_SECRET }],
					actions: [{ name: DEMO_ACTION }],
					invocations: [invocation({ status })],
				}).step === "done",
		);
		expect(done.sort()).toEqual(["running", "succeeded", "unknown"]);
	});

	it("the claim matcher catches the sent heading and leaves the others alone", () => {
		const claims = (text: string) => CLAIMS_SENT.some((p) => p.test(text));
		expect(claims("Sent. Your agent never saw the key.")).toBe(true);
		expect(claims("approved by you · sent with the token attached")).toBe(true);
		expect(claims("Outcome unknown. Your agent never saw the key.")).toBe(
			false,
		);
		expect(claims("Approved. Your agent never saw the key.")).toBe(false);
		expect(claims("Last run denied: nothing was sent. Run it again.")).toBe(
			false,
		);
	});
});
