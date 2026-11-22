/* @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { cataloguePack, type OperationsApi } from "@/lib/packs";
import type { ConnectionIntegration } from "@/lib/types";

const mocks = vi.hoisted(() => ({ createKey: vi.fn() }));

vi.mock("@/hooks/api/use-workspaces", () => ({
	useCreateApiKey: () => ({ mutateAsync: mocks.createKey, isPending: false }),
}));

import { OperationsFlow } from "./operations-flow";

const hubspot: ConnectionIntegration = {
	id: "hubspot",
	name: "HubSpot",
	hosts: ["api.hubapi.com"],
	hostsFromAccount: false,
	scopes: ["crm.objects.contacts.write"],
	operationsPack: "anlyon/hubspot",
	workflowPacks: [],
};

type Row = Record<string, unknown>;

function fakeWorkspace(
	options: { limitsForbidden?: boolean } = {},
): OperationsApi & {
	actions: Row[];
	policies: Row[];
	limits: Row[];
	calls: string[];
} {
	const actions: Row[] = [];
	const policies: Row[] = [];
	const limits: Row[] = [];
	const calls: string[] = [];
	return {
		actions,
		policies,
		limits,
		calls,
		getSecret: async (name) =>
			name === "HUBSPOT_SALES"
				? ({
						name,
						kind: "connection",
						connection: { integrationId: "hubspot", status: "active" },
						allowedHosts: ["api.hubapi.com"],
					} as never)
				: null,
		putSecret: async () => {
			throw new Error("no secret is written from the operations screen");
		},
		getAction: async (name) =>
			(actions.find((a) => a.name === name) as never) ?? null,
		createAction: async (request) => {
			calls.push(`create:${request.name}`);
			actions.push({ ...request, enabled: true });
		},
		updateAction: async (name, request) => {
			calls.push(`update:${name}:${JSON.stringify(request)}`);
			Object.assign(actions.find((a) => a.name === name) ?? {}, request);
		},
		listPolicies: async (actionName) =>
			policies.filter((p) => p.matchActionName === actionName) as never,
		createPolicy: async (request) => {
			calls.push(`policy:${request.name}`);
			policies.push({ ...request, id: `pol_${policies.length + 1}` });
		},
		updatePolicy: async (id, request) => {
			calls.push(`policy-update:${id}:${JSON.stringify(request)}`);
			Object.assign(policies.find((p) => p.id === id) ?? {}, request);
		},
		listLimits: async () => limits as never,
		createLimit: async (request) => {
			if (options.limitsForbidden)
				throw new ApiError(
					"Missing scope impact-limits:write",
					403,
					"FORBIDDEN",
				);
			calls.push(`limit:${request.name}:${request.amount}`);
			limits.push(request as unknown as Row);
		},
	};
}

function renderFlow(api: OperationsApi, initialStep?: "operations" | "agent") {
	render(
		<OperationsFlow
			workspaceId="workspace-1"
			workspaceName="Acme"
			environmentName="Production"
			environmentId="env_1"
			integration={hubspot}
			secretName="HUBSPOT_SALES"
			initialStep={initialStep}
			api={api}
		/>,
	);
}

async function toggle(name: string) {
	const control = await screen.findByRole("switch", { name });
	fireEvent.click(control);
	return control;
}

describe("Operations after connect", () => {
	beforeEach(() => mocks.createKey.mockReset());
	afterEach(cleanup);

	it("lists the pack's operations, all off, with their limitations behind a disclosure", async () => {
		renderFlow(fakeWorkspace());
		const list = await screen.findByRole("list", { name: "Writes" });
		const switches = within(list).getAllByRole("switch");
		expect(switches).toHaveLength(
			cataloguePack("anlyon/hubspot")!.actions.filter((a) => a.kind !== "read")
				.length,
		);
		for (const s of switches)
			expect(s.getAttribute("aria-checked")).toBe("false");
		expect(within(list).getAllByText("Limitations").length).toBeGreaterThan(0);
	});

	it("toggling on installs that one action with the connection's secret, its policy off, and shows on only after", async () => {
		const api = fakeWorkspace();
		renderFlow(api);
		const control = await toggle("hubspot-update-contact-stage");

		await waitFor(() =>
			expect(control.getAttribute("aria-checked")).toBe("true"),
		);
		expect(api.calls).toEqual([
			"create:hubspot-update-contact-stage",
			"policy:hubspot: approve a stage change to customer",
		]);
		expect(api.actions[0]?.headers).toMatchObject({
			Authorization: "Bearer {{secret:HUBSPOT_SALES}}",
		});
		expect(api.policies[0]?.enabled).toBe(false);
		expect(api.limits).toEqual([]);
	});

	it("toggling off disables the action and keeps it", async () => {
		const api = fakeWorkspace();
		renderFlow(api);
		const control = await toggle("hubspot-add-note");
		await waitFor(() =>
			expect(control.getAttribute("aria-checked")).toBe("true"),
		);

		fireEvent.click(control);
		await waitFor(() =>
			expect(control.getAttribute("aria-checked")).toBe("false"),
		);
		expect(api.calls.at(-1)).toBe('update:hubspot-add-note:{"enabled":false}');
		expect(api.actions.map((a) => a.name)).toEqual(["hubspot-add-note"]);

		fireEvent.click(control);
		await waitFor(() =>
			expect(control.getAttribute("aria-checked")).toBe("true"),
		);
		expect(api.calls.at(-1)).toBe('update:hubspot-add-note:{"enabled":true}');
		expect(api.actions).toHaveLength(1);
	});

	it("enables an installed policy only when asked", async () => {
		const api = fakeWorkspace();
		renderFlow(api);
		await toggle("hubspot-update-deal-stage");
		const enable = await screen.findByRole("switch", {
			name: "Enable hubspot: approve closing a deal",
		});
		fireEvent.click(enable);
		await screen.findByText("On", { selector: "[data-slot=badge]" });
		expect(api.calls.at(-1)).toBe(
			'policy-update:pol_1:{"enabled":true,"changeNote":"Enabled from the operations screen of anlyon/hubspot"}',
		);
	});

	it("creates a limit with the amount entered", async () => {
		const api = fakeWorkspace();
		renderFlow(api);
		await toggle("hubspot-create-deal");
		const amount = await screen.findByLabelText(
			"hubspot: deals created per day",
		);
		fireEvent.change(amount, { target: { value: "20" } });
		fireEvent.click(screen.getByRole("button", { name: "Create limit" }));
		await screen.findByText("Created");
		expect(api.limits).toEqual([
			{
				name: "hubspot: deals created per day",
				dimension: "resource_mutations",
				period: "day",
				amount: 20,
				actionName: "hubspot-create-deal",
			},
		]);
	});

	it("explains a limit refused for a missing scope, and creates nothing", async () => {
		const api = fakeWorkspace({ limitsForbidden: true });
		renderFlow(api);
		await toggle("hubspot-create-deal");
		fireEvent.click(
			await screen.findByRole("button", { name: "Create limit" }),
		);
		expect((await screen.findByRole("alert")).textContent).toContain(
			"impact-limits:write",
		);
		expect(api.limits).toEqual([]);
	});

	it("Add to your agent: names the enabled tools and gives each client's snippet", async () => {
		const api = fakeWorkspace();
		renderFlow(api);
		await toggle("hubspot-create-company");
		await waitFor(() => expect(api.actions).toHaveLength(1));
		await waitFor(() =>
			expect(
				screen
					.getByRole("switch", { name: "hubspot-create-company" })
					.getAttribute("aria-checked"),
			).toBe("true"),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Next: add to your agent" }),
		);

		const tools = await screen.findByRole("list", { name: "Tools" });
		expect(tools.textContent).toBe("hubspot-create-company");

		const code = () =>
			Array.from(document.querySelectorAll("pre"))
				.map((p) => p.textContent)
				.join("\n");
		expect(code()).toContain(
			"claude mcp add --transport http anlyon https://api.anlyon.com/mcp",
		);
		expect(code()).toContain("Workspace Acme, environment Production");
		expect(screen.getByText(/action_hubspot-create-company/)).toBeTruthy();

		const picker = screen.getByLabelText("Your agent runs in");
		fireEvent.change(picker, { target: { value: "cursor" } });
		expect(code()).toContain('"url": "https://api.anlyon.com/mcp"');
		fireEvent.change(picker, { target: { value: "codex" } });
		expect(code()).toContain("codex mcp login anlyon");
		fireEvent.change(picker, { target: { value: "ai-sdk" } });
		expect(code()).toContain("const tools = createAnlyonTools(client);");
		fireEvent.change(picker, { target: { value: "langchain" } });
		expect(code()).toContain(
			'tools = action_tools(client, names=["hubspot-create-company"])',
		);
		fireEvent.change(picker, { target: { value: "curl" } });
		expect(code()).toContain(
			"https://api.anlyon.com/api/v2/actions/hubspot-create-company/invoke",
		);
		expect(screen.getByText(/is not governed by Anlyon/)).toBeTruthy();
	});

	it("creates an agent key with only the agent scopes, shown once", async () => {
		mocks.createKey.mockResolvedValue({ key: "anlyon_live_example" });
		renderFlow(fakeWorkspace(), "agent");
		fireEvent.change(await screen.findByLabelText("Your agent runs in"), {
			target: { value: "ai-sdk" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Create an agent key" }),
		);
		const key = await screen.findByLabelText("Agent key");
		expect((key as HTMLInputElement).value).toBe("anlyon_live_example");
		expect(mocks.createKey).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			data: {
				name: "Agent key (connected account)",
				environmentId: "env_1",
				scopes: ["actions:invoke", "actions:read", "approvals:read"],
			},
		});
		expect(
			screen.queryByRole("button", { name: "Create an agent key" }),
		).toBeNull();
	});

	it("an MCP client signs in, so no key is offered", async () => {
		renderFlow(fakeWorkspace(), "agent");
		await screen.findByLabelText("Your agent runs in");
		expect(
			screen.queryByRole("button", { name: "Create an agent key" }),
		).toBeNull();
	});
});
