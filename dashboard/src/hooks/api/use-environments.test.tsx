/* @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@/lib/types";
import { EnvironmentsPage } from "@/routes/_protected/environments";

const useEnvironmentsMock = vi.hoisted(() => vi.fn());
const updateEnvironmentMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "workspace-1" } }),
}));

vi.mock("@/hooks/api/use-plan", () => ({
	usePlanDetails: () => ({
		data: {
			plan: "production",
			limits: {
				maxEnvironments: 2,
			},
			features: { protectedProduction: true },
		},
	}),
}));

vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: useEnvironmentsMock,
	useCreateEnvironment: () => ({ mutate: vi.fn(), isPending: false }),
	useHaltEnvironment: () => ({ mutate: vi.fn(), isPending: false }),
	useResumeEnvironment: () => ({ mutate: vi.fn(), isPending: false }),
	useUpdateEnvironment: () => ({
		mutate: vi.fn(),
		mutateAsync: updateEnvironmentMock,
		isPending: false,
	}),
	useDeleteEnvironment: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => true,
}));

const environments: Environment[] = [
	{
		id: "44607683-2aa7-4574-88a0-d8df8512f388",
		name: "Production",
		slug: "production",
		kind: "production",
		isDefault: true,
		isProtected: true,
		halted: false,
		haltedAt: null,
		haltedReason: null,
		createdAt: "2026-07-18T18:36:53.148Z",
		updatedAt: "2026-07-18T18:36:53.148Z",
	},
];

describe("EnvironmentsPage", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});
	it("renders the environments returned by the unwrapped API client response", () => {
		useEnvironmentsMock.mockReturnValue({
			data: environments,
			isLoading: false,
		});

		render(<EnvironmentsPage />);

		expect(screen.getByText("Production")).toBeTruthy();
	});

	it("requires confirmation before removing protection and sends the override", async () => {
		useEnvironmentsMock.mockReturnValue({
			data: environments,
			isLoading: false,
		});
		render(<EnvironmentsPage />);
		fireEvent.click(
			screen.getByRole("switch", {
				name: "Production protection for Production",
			}),
		);
		expect(updateEnvironmentMock).not.toHaveBeenCalled();
		fireEvent.click(
			await screen.findByRole("button", { name: "Remove protection" }),
		);
		await waitFor(() =>
			expect(updateEnvironmentMock).toHaveBeenCalledWith({
				environmentId: environments[0].id,
				isProtected: false,
				confirmProtected: true,
			}),
		);
	});
});
