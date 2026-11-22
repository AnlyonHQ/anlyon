/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationsApi } from "@/lib/packs";
import type { ConnectionIntegration, Invocation, Secret } from "@/lib/types";

const mocks = vi.hoisted(() => ({
	integrations: [] as unknown[],
	connections: [] as unknown[],
	calls: [] as unknown[],
	connect: vi.fn(),
	decide: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({ children }: { children: React.ReactNode }) => (
		<a href="/">{children}</a>
	),
}));

vi.mock("@/hooks/api/use-connections", () => ({
	useConnections: () => ({ data: mocks.connections, isLoading: false }),
	useConnectionIntegrations: () => ({
		data: mocks.integrations,
		isLoading: false,
	}),
	useConnectWithApiKey: () => ({
		mutate: mocks.connect,
		isPending: false,
		error: null,
	}),
}));

vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({
		data: [{ id: "env-1", name: "production", isDefault: true }],
	}),
}));

vi.mock("@/hooks/api/use-approvals", () => ({
	useDecideApproval: () => ({ mutate: mocks.decide, isPending: false }),
}));

vi.mock("@/hooks/api/use-workspaces", () => ({
	useCreateApiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
	useAuth: () => ({ user: { email: "dev@example.com" } }),
}));

vi.mock("@/lib/api-client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api-client")>()),
	apiClient: {
		get: async () => ({ data: mocks.calls, pagination: {} }),
	},
}));

import { Quickstart } from "./quickstart";

const github: ConnectionIntegration = {
	id: "github",
	name: "GitHub",
	auth: {
		kind: "api_key",
		instructions: "Create a fine-grained personal access token.",
		instructionsUrl: "https://github.com/settings/personal-access-tokens",
	} as ConnectionIntegration["auth"],
	hosts: ["api.github.com"],
	hostsFromAccount: false,
	scopes: [],
	operationsPack: "anlyon/github",
	workflowPacks: [],
};

const account: Secret = {
	id: "sec_1",
	name: "GITHUB",
	description: null,
	kind: "static",
	integrationId: "github",
	lastUsedAt: null,
	createdAt: "2026-10-16T00:00:00.000Z",
	updatedAt: "2026-10-16T00:00:00.000Z",
};

function memoryWorkspace() {
	const actions = new Map<string, Record<string, unknown>>();
	const policies: Array<Record<string, unknown>> = [];
	const api = {
		getSecret: async (name: string) => ({
			name,
			integrationId: "github",
			allowedHosts: ["api.github.com"],
		}),
		putSecret: async () => ({}),
		getAction: async (name: string) => actions.get(name) ?? null,
		createAction: async (request: Record<string, unknown>) => {
			actions.set(request.name as string, { ...request, enabled: true });
			return {};
		},
		updateAction: async (name: string, request: Record<string, unknown>) => {
			actions.set(name, { ...actions.get(name), ...request });
			return {};
		},
		listPolicies: async (actionName: string) =>
			policies.filter((p) => p.matchActionName === actionName),
		createPolicy: async (request: Record<string, unknown>) => {
			policies.push({ ...request, id: `pol_${policies.length + 1}` });
			return {};
		},
		listLimits: async () => [],
		createLimit: async () => ({}),
		updatePolicy: async (id: string, request: Record<string, unknown>) => {
			const policy = policies.find((p) => p.id === id);
			if (policy) Object.assign(policy, request);
			return {};
		},
	};
	return { api: api as unknown as OperationsApi, actions, policies };
}

const call = (over: Partial<Invocation>): Invocation => ({
	id: "inv_1",
	actionName: "github-list-issues",
	status: "succeeded",
	responseStatus: 200,
	body: null,
	error: null,
	durationMs: 90,
	approvalId: null,
	createdAt: new Date(Date.now() + 1000).toISOString(),
	completedAt: null,
	...over,
});

function renderQuickstart(api: OperationsApi) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<Quickstart
				operationsApi={api}
				workspaceId="workspace-1"
				workspaceName="acme"
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	window.localStorage.clear();
	mocks.integrations = [github];
	mocks.connections = [];
	mocks.calls = [];
	mocks.connect.mockReset();
	mocks.decide.mockReset();
});

afterEach(() => cleanup());

describe("Get started in two minutes", () => {
	it("starts by asking for a tool the developer uses", () => {
		renderQuickstart(memoryWorkspace().api);
		expect(
			screen.getByRole("heading", {
				name: "Your agent, working in a tool you already use.",
			}),
		).toBeTruthy();
		const list = screen.getByRole("list", { name: "Integrations" });
		expect(list.textContent).toContain("GitHub");
	});

	it("walks pick, connect, tools, agent and a decision to the outcome", async () => {
		const workspace = memoryWorkspace();
		mocks.connect.mockImplementation(
			(_vars: unknown, options: { onSuccess: () => void }) => {
				mocks.connections = [account];
				options.onSuccess();
			},
		);
		const view = renderQuickstart(workspace.api);

		fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
		expect(
			await screen.findByText("Create a fine-grained personal access token."),
		).toBeTruthy();

		fireEvent.change(screen.getByLabelText("GitHub key"), {
			target: { value: "github_pat_1234567890" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(mocks.connect.mock.calls[0]?.[0]).toMatchObject({
			integrationId: "github",
			secretName: "GITHUB",
			apiKey: "github_pat_1234567890",
		});

		const turnOn = await screen.findByRole(
			"button",
			{ name: "Turn them on" },
			{ timeout: 5000 },
		);
		expect(screen.getByText("github-create-issue")).toBeTruthy();
		expect(screen.getByText("github-close-issue")).toBeTruthy();
		fireEvent.click(turnOn);

		await screen.findByText(/Paste this into your agent/, undefined, {
			timeout: 5000,
		});
		const gate = workspace.policies.find(
			(p) => p.matchActionName === "github-close-issue",
		);
		expect(gate?.enabled).toBe(true);
		expect(workspace.actions.has("github-create-issue")).toBe(true);
		expect(workspace.actions.has("github-list-issues")).toBe(true);
		expect(workspace.actions.has("github-merge-pull-request")).toBe(false);

		fireEvent.change(screen.getByLabelText("Repository"), {
			target: { value: "acme/api" },
		});
		expect(
			screen.getByText(/list the open issues in acme\/api\./),
		).toBeTruthy();
		expect(screen.getByText(/Waiting for your agent/)).toBeTruthy();

		mocks.calls = [
			call({
				id: "inv_3",
				actionName: "github-close-issue",
				status: "pending_approval",
				approvalId: "apr_1",
			}),
			call({ id: "inv_2", actionName: "github-create-issue" }),
			call({ id: "inv_1", actionName: "github-list-issues" }),
		];
		const approve = await screen.findByRole(
			"button",
			{ name: "Approve" },
			{ timeout: 5000 },
		);
		expect(screen.getByText("Waiting for you")).toBeTruthy();
		fireEvent.click(approve);
		expect(mocks.decide.mock.calls[0]?.[0]).toMatchObject({
			approvalId: "apr_1",
			decision: "approve",
		});

		mocks.calls = [
			call({
				id: "inv_3",
				actionName: "github-close-issue",
				status: "succeeded",
				approvalId: "apr_1",
			}),
			...mocks.calls.slice(1),
		];
		await waitFor(
			() =>
				expect(
					screen.getByRole("heading", {
						name: "Your agent just worked in your GitHub, on your terms.",
					}),
				).toBeTruthy(),
			{ timeout: 5000 },
		);
		expect(view.container.textContent).toContain("approved by you, then sent");
	}, 30_000);

	it("offers the sandbox to a developer with no key at hand", () => {
		renderQuickstart(memoryWorkspace().api);
		expect(
			screen.getByText("No key at hand? Try it in the sandbox"),
		).toBeTruthy();
	});
});
