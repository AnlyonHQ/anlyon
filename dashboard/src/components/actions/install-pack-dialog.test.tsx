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

const state = vi.hoisted(() => ({
	secrets: [] as Record<string, unknown>[],
	actions: [] as Record<string, unknown>[],
	policies: [] as Record<string, unknown>[],
	limits: [] as Record<string, unknown>[],
	writes: [] as string[],
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({ children }: { children: React.ReactNode }) => (
		<a href="/">{children}</a>
	),
}));

vi.mock("@/lib/packs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/packs")>();
	return {
		...actual,
		consoleTransport: () => ({
			getSecret: async (name: string) =>
				state.secrets.find((s) => s.name === name) ?? null,
			putSecret: async (name: string, request: Record<string, unknown>) => {
				state.writes.push(`secret:${name}`);
				state.secrets.push({ name, kind: "static", ...request });
			},
			getAction: async (name: string) =>
				state.actions.find((a) => a.name === name) ?? null,
			createAction: async (request: Record<string, unknown>) => {
				state.writes.push(`action:${request.name}`);
				state.actions.push(request);
			},
			updateAction: async () => undefined,
			listPolicies: async (actionName: string) =>
				state.policies.filter((p) => p.matchActionName === actionName),
			createPolicy: async (request: Record<string, unknown>) => {
				state.writes.push(`policy:${request.name}`);
				state.policies.push(request);
			},
			listLimits: async () => state.limits,
			createLimit: async (request: Record<string, unknown>) => {
				state.writes.push(`limit:${request.name}`);
				state.limits.push(request);
			},
		}),
	};
});

import { InstallPackDialog } from "./install-pack-dialog";

const connected = (name: string, integrationId: string, host: string) => ({
	name,
	kind: "connection",
	connection: { integrationId, status: "active" },
	allowedHosts: [host],
});

function open() {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<InstallPackDialog workspaceId="workspace-1" />
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Install a pack" }));
}

async function choosePack(id: string) {
	fireEvent.click(
		await screen.findByRole("radio", { name: new RegExp(`${id}\\b`) }),
	);
}

describe("Install a pack", () => {
	beforeEach(() => {
		state.secrets = [];
		state.actions = [];
		state.policies = [];
		state.limits = [];
		state.writes = [];
	});
	afterEach(cleanup);

	it("installs with no account connected: each call chooses its user's account, or this environment's", async () => {
		open();
		await choosePack("anlyon/outbound-sales");
		fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
		expect(await screen.findByText("connection:hubspot")).toBeTruthy();
		expect(screen.getAllByText("At each call").length).toBe(3);
		expect(screen.queryByText("Connect these accounts first")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		expect(
			await screen.findByText("Installed anlyon/outbound-sales"),
		).toBeTruthy();
		expect(state.writes.some((w) => w.startsWith("secret:"))).toBe(false);
		expect(
			(state.actions[0]?.headers as Record<string, string>).Authorization,
		).toBe("Bearer {{connection:hubspot}}");
	});

	it("offers a catalogue pack too", async () => {
		open();
		await choosePack("anlyon/github");
		fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
		expect(await screen.findByText("github-create-issue")).toBeTruthy();
		expect(state.writes).toEqual([]);
	});

	it("bound to accounts by name, plans, refuses to install until they are connected, and writes nothing", async () => {
		open();
		await choosePack("anlyon/outbound-sales");
		fireEvent.click(
			screen.getByRole("radio", { name: "Connected accounts by name" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
		expect(
			await screen.findByText("Connect these accounts first"),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Install" })).toHaveProperty(
			"disabled",
			true,
		);
		expect(state.writes).toEqual([]);
	});

	it("installs outbound-sales with policies off and limits only when asked", async () => {
		state.secrets = [
			connected("HUBSPOT", "hubspot", "api.hubapi.com"),
			connected("GOOGLE_CALENDAR", "google-calendar", "www.googleapis.com"),
			connected("SLACK", "slack", "slack.com"),
		];
		open();
		await choosePack("anlyon/outbound-sales");
		fireEvent.click(
			screen.getByRole("radio", { name: "Connected accounts by name" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
		expect(await screen.findByText("outbound-sales-announce-win")).toBeTruthy();
		expect(screen.getAllByText("Suggested only").length).toBe(3);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		expect(
			await screen.findByText("Installed anlyon/outbound-sales"),
		).toBeTruthy();
		expect(state.writes.filter((w) => w.startsWith("action:"))).toEqual([
			"action:outbound-sales-update-contact",
			"action:outbound-sales-book-meeting",
			"action:outbound-sales-announce-win",
		]);
		expect(state.policies.every((p) => p.enabled === false)).toBe(true);
		expect(state.limits).toEqual([]);
	});

	it("takes parameters and a stored secret for support-refunds, and shows a refusal", async () => {
		state.secrets = [
			connected("HUBSPOT", "hubspot", "api.hubapi.com"),
			connected("SLACK", "slack", "slack.com"),
		];
		open();
		await choosePack("anlyon/support-refunds");
		fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
		expect(
			await screen.findByText(/Parameter stripe_account is required/),
		).toBeTruthy();

		fireEvent.change(screen.getByLabelText("stripe_account"), {
			target: { value: "acct_1PackTest00000000" },
		});
		fireEvent.change(screen.getByLabelText("slack_channel"), {
			target: { value: "C0123456789" },
		});
		fireEvent.change(screen.getByLabelText(/STRIPE_KEY/), {
			target: { value: "stripe-fixture-value" },
		});
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
		await screen.findByRole("button", { name: "Install" });
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		await waitFor(() => expect(state.writes).toContain("secret:STRIPE_KEY"));
		expect(state.limits).toHaveLength(3);
		expect(document.body.textContent).not.toContain("stripe-fixture-value");
	});
});
