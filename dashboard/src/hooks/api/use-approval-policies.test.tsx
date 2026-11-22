/* @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalPolicy } from "@/lib/types";
import { ApprovalPoliciesPage } from "@/routes/_protected/approval-policies";

const useApprovalPoliciesMock = vi.hoisted(() => vi.fn());
const deleteMutate = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => true,
}));

vi.mock("@tanstack/react-router", async (original) => ({
	...(await original<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useNavigate: () => vi.fn(),
		useSearch: () => ({}),
	}),
}));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "workspace-1" } }),
}));

vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/hooks/api/use-actions", () => ({
	useEnvironmentActions: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/hooks/api/use-assistant", () => ({
	usePolicySuggestions: () => ({ data: [], isLoading: false }),
	useAcceptPolicySuggestion: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/api/use-approval-policies", () => ({
	useApprovalPolicies: useApprovalPoliciesMock,
	useCreateApprovalPolicy: () => ({ mutate: vi.fn(), isPending: false }),
	useUpdateApprovalPolicy: () => ({ mutate: vi.fn(), isPending: false }),
	useDraftCondition: () => ({ mutate: vi.fn(), isPending: false }),
	useDeleteApprovalPolicy: () => ({ mutate: deleteMutate, isPending: false }),
	useConditionAssist: () => ({
		data: undefined,
		isFetching: false,
		error: null,
	}),
	useApprovalPolicyVersions: () => ({ data: [], isLoading: false }),
}));

const policies = [
	{
		id: "pol_1",
		name: "Require two approvers",
		priority: 100,
		enabled: true,
		effect: "require_approval",
		requiredApprovals: 2,
		scope: "all_requests",
		needsScopeReview: true,
		match: { kind: "any", actionName: null },
	},
] as unknown as ApprovalPolicy[];

describe("ApprovalPoliciesPage", () => {
	it("renders the policies returned by the unwrapped API client response", () => {
		useApprovalPoliciesMock.mockReturnValue({
			data: policies,
			isLoading: false,
		});

		render(<ApprovalPoliciesPage />);

		expect(screen.getByText("Require two approvers")).toBeTruthy();
		expect(screen.queryByText("No policies yet")).toBeNull();
	});

	it("still shows the empty state when the workspace has no policies", () => {
		useApprovalPoliciesMock.mockReturnValue({ data: [], isLoading: false });

		render(<ApprovalPoliciesPage />);

		expect(screen.getByText("No policies yet")).toBeTruthy();
	});

	it("flags a legacy broad policy for scope review and never reads scope from its name", () => {
		useApprovalPoliciesMock.mockReturnValue({
			data: policies,
			isLoading: false,
		});

		render(<ApprovalPoliciesPage />);

		expect(screen.getAllByText("Review scope").length).toBeGreaterThan(0);
		expect(
			screen.getAllByText("All requests (advanced)").length,
		).toBeGreaterThan(0);
	});

	it("marks file-managed policies and offers no console edit or delete for them", () => {
		useApprovalPoliciesMock.mockReturnValue({
			data: [
				{
					...policies[0],
					id: "pol_console",
					name: "Console rule",
					needsScopeReview: false,
				},
				{
					...policies[0],
					id: "pol_file",
					name: "File rule",
					needsScopeReview: false,
					managedBy: { file: "payments/refunds", key: "big-refunds" },
				},
			],
			isLoading: false,
		});

		render(<ApprovalPoliciesPage />);

		expect(screen.getByText("File: payments/refunds")).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
		expect(screen.getByText("Edit in file")).toBeTruthy();
	});

	it("asks before deleting a policy", async () => {
		deleteMutate.mockReset();
		useApprovalPoliciesMock.mockReturnValue({
			data: [{ ...policies[0], needsScopeReview: false }],
			isLoading: false,
		});

		render(<ApprovalPoliciesPage />);

		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(
			await screen.findByRole("heading", {
				name: "Delete Require two approvers?",
			}),
		).toBeTruthy();
		expect(deleteMutate).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Delete policy" }));
		expect(deleteMutate).toHaveBeenCalledWith("pol_1");
	});
});
