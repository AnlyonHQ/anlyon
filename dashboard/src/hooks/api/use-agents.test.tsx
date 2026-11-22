/* @vitest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Agent, Environment } from "@/lib/types";
import { AgentsPage } from "@/routes/_protected/agents";

const useAgentsMock = vi.hoisted(() => vi.fn());
const useEnvironmentsMock = vi.hoisted(() =>
	vi.fn((): { data: Environment[]; isLoading: boolean } => ({
		data: [],
		isLoading: false,
	})),
);

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => true,
}));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "workspace-1" } }),
}));

vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: useEnvironmentsMock,
}));

vi.mock("@/hooks/api/use-agents", () => ({
	useAgents: useAgentsMock,
	useCreateAgent: () => ({ mutate: vi.fn(), isPending: false }),
	usePromoteAgent: () => ({ mutate: vi.fn(), isPending: false }),
	useAgentVersions: () => ({ data: [], isLoading: false }),
}));

const agents = [
	{
		id: "agt_EB_Q7jPIBajXO-T9W7Om5",
		environmentId: "fdd784f8-9dfb-42b2-8a2e-ebd614e2d243",
		name: "support-agent",
		description: "Handle customer queries help refunds",
		currentVersion: 1,
		archived: false,
		createdAt: "2026-09-16T21:22:00.849Z",
		updatedAt: "2026-09-16T21:22:00.856Z",
	},
] as unknown as Agent[];

describe("AgentsPage", () => {
	it("renders the agents returned by the unwrapped API client response", () => {
		useAgentsMock.mockReturnValue({ data: agents, isLoading: false });

		render(<AgentsPage />);

		expect(screen.getByText("support-agent")).toBeTruthy();
		expect(screen.queryByText("No agents yet")).toBeNull();
	});

	it("still shows the empty state when the workspace has no agents", () => {
		useAgentsMock.mockReturnValue({ data: [], isLoading: false });

		render(<AgentsPage />);

		expect(screen.getByText("No agents yet")).toBeTruthy();
	});
});

const productionId = "fdd784f8-9dfb-42b2-8a2e-ebd614e2d243";

const production = {
	id: productionId,
	name: "Production",
	slug: "production",
	isDefault: true,
	isProtected: true,
	halted: false,
} as unknown as Environment;

const staging = {
	id: "6b1f0c02-0000-4000-8000-000000000000",
	name: "Staging",
	slug: "staging",
	isDefault: false,
	isProtected: false,
	halted: false,
} as unknown as Environment;

describe("PromoteAgentDialog", () => {
	it("explains itself when the agent's environment is the only one", async () => {
		useAgentsMock.mockReturnValue({ data: agents, isLoading: false });
		useEnvironmentsMock.mockReturnValue({
			data: [production],
			isLoading: false,
		});

		render(<AgentsPage />);
		fireEvent.click(screen.getByRole("button", { name: "Promote" }));

		expect(
			await screen.findByText(/no other environment to promote into/i),
		).toBeTruthy();
		expect(
			within(screen.getByRole("dialog")).getByText(/Production/),
		).toBeTruthy();
		expect(screen.queryByLabelText("Target environment")).toBeNull();
		expect(screen.queryByRole("button", { name: "Promote" })).toBeNull();
	});

	it("offers the other environments as targets when they exist", async () => {
		useAgentsMock.mockReturnValue({ data: agents, isLoading: false });
		useEnvironmentsMock.mockReturnValue({
			data: [production, staging],
			isLoading: false,
		});

		render(<AgentsPage />);
		fireEvent.click(screen.getByRole("button", { name: "Promote" }));

		expect(await screen.findByLabelText("Target environment")).toBeTruthy();
		expect(screen.getByRole("option", { name: "Staging" })).toBeTruthy();
		expect(screen.queryByRole("option", { name: /^Production/ })).toBeNull();
		expect(
			screen.queryByText(/no other environment to promote into/i),
		).toBeNull();
		expect(screen.getByRole("button", { name: "Promote" })).toBeTruthy();
	});
});
