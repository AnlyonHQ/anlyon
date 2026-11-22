/* @vitest-environment jsdom */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalPolicy } from "@/lib/types";

const mocks = vi.hoisted(() => ({ policies: [] as unknown[] }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useSearch: () => ({}),
		useNavigate: () => vi.fn(),
	}),
}));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "ws_1" } }),
}));

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => false,
}));

vi.mock("@/hooks/api/use-approval-policies", () => ({
	useApprovalPolicies: () => ({
		data: mocks.policies,
		isLoading: false,
		isSuccess: true,
	}),
	useDeleteApprovalPolicy: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/approvals/policy-form-dialog", () => ({
	PolicyFormDialog: () => null,
}));
vi.mock("@/components/approvals/policy-history", () => ({
	PolicyHistory: () => null,
}));
vi.mock("@/components/approvals/policy-suggestions", () => ({
	PolicySuggestions: () => null,
}));

const { ApprovalPoliciesPage } = await import("./approval-policies");

afterEach(() => {
	cleanup();
	mocks.policies = [];
});

const base: ApprovalPolicy = {
	id: "apol_1",
	environmentId: "env_1",
	name: "Refunds need a person",
	priority: 10,
	enabled: true,
	scope: "specific_action",
	needsScopeReview: false,
	match: {
		kind: "action",
		actionName: "refund-payment",
		agentId: null,
		userId: null,
		tags: null,
		minAmount: null,
		conditions: null,
	},
	effect: "require_approval",
	requiredApprovals: 1,
	decidedBy: "team",
	version: 1,
	scopeReviewedAt: null,
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("Policies list", () => {
	it("says who decides what each policy holds", () => {
		mocks.policies = [
			base,
			{
				...base,
				id: "apol_2",
				name: "Emails the user approves",
				decidedBy: "end_user",
			},
			{
				...base,
				id: "apol_3",
				name: "Small refunds go through",
				effect: "auto_approve",
			},
		];
		render(<ApprovalPoliciesPage />);
		expect(
			screen.getByRole("columnheader", { name: "Decided by" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("columnheader", { name: "Applies to" }),
		).toBeNull();
		expect(screen.getByRole("columnheader", { name: "Matches" })).toBeTruthy();

		const row = (name: string) =>
			within(screen.getByText(name).closest("tr") as HTMLElement);
		expect(row("Refunds need a person").getByText("Your team")).toBeTruthy();
		expect(row("Emails the user approves").getByText("The user")).toBeTruthy();
		expect(
			row("Emails the user approves").getByText("Your team on workspace calls"),
		).toBeTruthy();
		expect(row("Small refunds go through").getByText("Automatic")).toBeTruthy();
	});
});
