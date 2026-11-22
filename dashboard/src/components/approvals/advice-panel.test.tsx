/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Approval, AssistantAdvice } from "@/lib/types";
import { AdviceBadge, AdvicePanel } from "./advice-panel";

const auditMutate = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/api/use-assistant", () => ({
	useAuditAdvice: () => ({ mutate: auditMutate, isPending: false }),
}));
const role = vi.hoisted(() => ({ current: "admin" as string | undefined }));
vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => (permission: string) =>
		permission === "assistant.manage" && role.current === "admin",
}));

afterEach(() => {
	cleanup();
	auditMutate.mockReset();
	role.current = "admin";
});

const ready: AssistantAdvice = {
	status: "ready",
	statusReason: null,
	model: "vigil-1",
	recommendation: "approve",
	risk: 0.4,
	riskLevel: "routine",
	confidence: 0.93,
	reasons: [
		"Suggests approve (confidence 0.93)",
		"Risk: routine (0.40 on a 0–4 scale)",
	],
	flags: {
		injectionSuspected: 0.01,
		consistentWithHistory: 0.9,
		amountUnusual: null,
	},
	history: { approved: 25, denied: 0, maxAmount: 90, medianAmount: 30 },
	auditRequested: false,
	auditVerdict: null,
	createdAt: "2026-09-24T12:00:00Z",
	completedAt: "2026-09-24T12:00:01Z",
};

const approval = (over: Partial<Approval> = {}): Approval => ({
	id: "apr_1",
	kind: "action",
	status: "pending",
	title: "Run action refund_order",
	description: null,
	payload: {},
	decisionNote: null,
	requiredApprovals: 1,
	approvedCount: 0,
	matchedPolicyId: null,
	matchedPolicyVersion: null,
	policyExplanation: null,
	decisionOrigin: null,
	expiresAt: "2026-09-25T12:00:00Z",
	decidedAt: null,
	createdAt: "2026-09-24T12:00:00Z",
	advice: ready,
	...over,
});

describe("AdvicePanel", () => {
	it("renders nothing for a workspace without advice", () => {
		const { container } = render(
			<AdvicePanel
				approval={approval({ advice: undefined })}
				workspaceId="ws"
			/>,
		);
		expect(container.innerHTML).toBe("");
	});

	it("leads with a verdict in words, labelled as a second reader", () => {
		render(<AdvicePanel approval={approval()} workspaceId="ws" />);
		expect(screen.getByText("Vigil review")).toBeTruthy();
		expect(screen.getByText("A second reader. You decide.")).toBeTruthy();
		expect(screen.getByText("Looks routine")).toBeTruthy();
		expect(screen.getByText(/Suggests approving, 93% sure/)).toBeTruthy();
		expect(screen.getByText("vigil-1")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /agree/i })).toBeNull();
	});

	it("lists the checks behind it, each one expandable", () => {
		render(<AdvicePanel approval={approval()} workspaceId="ws" />);
		const risk = screen.getByRole("button", { name: /Risk if approved/ });
		expect(risk.getAttribute("aria-expanded")).toBe("false");
		expect(
			screen.getByRole("button", { name: /Matches this agent's history/ }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /Injected instructions/ }),
		).toBeTruthy();
		fireEvent.click(risk);
		expect(risk.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByRole("list", { name: "Risk scale" })).toBeTruthy();
	});

	it("places the amount among the amounts approvers approved", () => {
		render(
			<AdvicePanel
				approval={approval({ payload: { input: { amount: 40 } } })}
				workspaceId="ws"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Amount/ }));
		expect(
			screen.getByRole("img", {
				name: /This amount is 40\. Approvers approved up to 90, median 30/,
			}),
		).toBeTruthy();
	});

	it("says why a request stayed with a person", () => {
		render(
			<AdvicePanel
				approval={approval({
					advice: {
						...ready,
						reasons: [
							...ready.reasons,
							"Left for a person: Amount is above the auto-approve cap",
						],
					},
				})}
				workspaceId="ws"
			/>,
		);
		expect(
			screen.getByText(/Amount is above the auto-approve cap/),
		).toBeTruthy();
	});

	it("shows a pending state while the review runs", () => {
		render(
			<AdvicePanel
				approval={approval({
					advice: { ...ready, status: "pending", recommendation: null },
				})}
				workspaceId="ws"
			/>,
		);
		expect(screen.getByTestId("advice-pending")).toBeTruthy();
	});

	it("explains an unavailable suggestion without blocking review", () => {
		render(
			<AdvicePanel
				approval={approval({
					advice: {
						...ready,
						status: "skipped",
						statusReason: "quota_exceeded",
						recommendation: null,
					},
				})}
				workspaceId="ws"
			/>,
		);
		expect(screen.getByText(/Suggestion unavailable/)).toBeTruthy();
		expect(
			screen.getByText(/used its Vigil reviews for the month/),
		).toBeTruthy();
	});

	it("asks a person to audit an assistant approval and records the verdict", () => {
		render(
			<AdvicePanel
				approval={approval({
					status: "approved",
					decisionOrigin: "assistant",
					advice: { ...ready, auditRequested: true },
				})}
				workspaceId="ws"
			/>,
		);
		expect(screen.getByText(/Picked for audit/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /disagree/i }));
		expect(auditMutate).toHaveBeenCalledWith({
			approvalId: "apr_1",
			verdict: "disagree",
		});
	});

	it("does not offer the audit buttons to a member", () => {
		role.current = "member";
		render(
			<AdvicePanel
				approval={approval({
					status: "approved",
					decisionOrigin: "assistant",
					advice: { ...ready, auditRequested: true },
				})}
				workspaceId="ws"
			/>,
		);
		expect(
			screen.getByText(/A workspace admin can record a verdict/),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: /agree/i })).toBeNull();
	});

	it("offers no verdict on a decision that was not sampled for audit", () => {
		render(
			<AdvicePanel
				approval={approval({ status: "approved", decisionOrigin: "human" })}
				workspaceId="ws"
			/>,
		);
		expect(screen.queryByRole("button", { name: /agree/i })).toBeNull();
		expect(screen.queryByText(/Picked for audit/)).toBeNull();
	});

	it("shows a recorded verdict without buttons", () => {
		render(
			<AdvicePanel
				approval={approval({
					status: "approved",
					decisionOrigin: "assistant",
					advice: { ...ready, auditRequested: true, auditVerdict: "disagree" },
				})}
				workspaceId="ws"
			/>,
		);
		expect(screen.getByText(/Audited: disagreed with Vigil here/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /agree/i })).toBeNull();
	});
});

describe("AdviceBadge", () => {
	it("shows the verdict in words", () => {
		render(<AdviceBadge advice={ready} />);
		expect(screen.getByText("Looks routine")).toBeTruthy();
	});

	it("renders nothing without a finished review", () => {
		const { container } = render(
			<AdviceBadge advice={{ ...ready, status: "failed" }} />,
		);
		expect(container.innerHTML).toBe("");
	});
});
