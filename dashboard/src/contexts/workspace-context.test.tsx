/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/lib/types";
import { useWorkspace, WorkspaceProvider } from "./workspace-context";

const useWorkspacesMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/api/use-workspaces", () => ({
	useWorkspaces: useWorkspacesMock,
}));

const workspace = (id: string, name: string): Workspace => ({
	id,
	name,
	slug: id,
	plan: "free",
	subscriptionStatus: "active",
	monthlyMessageQuota: 1_000,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
});

function WorkspaceControls() {
	const { currentWorkspace, switchWorkspace } = useWorkspace();
	return (
		<>
			<p>{currentWorkspace?.name}</p>
			<button onClick={() => switchWorkspace("workspace-b")} type="button">
				Switch workspace
			</button>
		</>
	);
}

describe("WorkspaceProvider", () => {
	beforeEach(() => {
		localStorage.clear();
		useWorkspacesMock.mockReturnValue({
			data: [
				workspace("workspace-a", "Workspace A"),
				workspace("workspace-b", "Workspace B"),
			],
			isLoading: false,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("clears previous-scope cached resources before showing the next workspace", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(["runs", "list"], {
			data: ["from-workspace-a"],
		});

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceProvider>
					<WorkspaceControls />
				</WorkspaceProvider>
			</QueryClientProvider>,
		);

		await screen.findByText("Workspace A");
		fireEvent.click(screen.getByRole("button", { name: "Switch workspace" }));

		await waitFor(() => expect(screen.getByText("Workspace B")).toBeTruthy());
		expect(queryClient.getQueryData(["runs", "list"])).toBeUndefined();
		expect(localStorage.getItem("anlyon_current_workspace_id")).toBe(
			"workspace-b",
		);
	});
});
