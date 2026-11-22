/* @vitest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@/lib/types";

const mocks = vi.hoisted(() => ({
	environments: [] as unknown[],
	apps: {} as Record<string, unknown>,
	saveSettings: vi.fn(),
	saveApp: vi.fn(),
	deleteApp: vi.fn(),
	canManage: true,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: Record<string, unknown>) => options,
	Link: ({ children }: { children: React.ReactNode }) => (
		<a href="/">{children}</a>
	),
}));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "workspace-1" } }),
}));

vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({ data: mocks.environments, isLoading: false }),
}));

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => mocks.canManage,
}));

vi.mock("@/components/effects/environment-select", () => ({
	EnvironmentSelect: () => null,
}));

vi.mock("@/hooks/api/use-end-users", () => ({
	useSaveConnectSettings: () => ({
		mutate: mocks.saveSettings,
		isPending: false,
	}),
	useEnvironmentOAuthApp: (_w: string, _e: string, integration: string) => ({
		data: mocks.apps[integration] ?? {
			integration,
			configured: false,
			clientId: null,
			redirectUri: `https://api.anlyon.com/oauth/${integration}/callback`,
			updatedAt: null,
		},
		isLoading: false,
		isError: false,
	}),
	useSaveEnvironmentOAuthApp: () => ({
		mutate: mocks.saveApp,
		isPending: false,
	}),
	useDeleteEnvironmentOAuthApp: () => ({
		mutate: mocks.deleteApp,
		isPending: false,
	}),
}));

import { ConnectSettingsPage } from "./settings";

const production: Environment = {
	id: "env-prod",
	name: "Production",
	slug: "production",
	kind: "production",
	isDefault: true,
	isProtected: true,
	halted: false,
	haltedAt: null,
	haltedReason: null,
	allowedRedirectUrls: [],
	defaultRedirectUrl: null,
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
};

const development: Environment = {
	...production,
	id: "env-dev",
	name: "Development",
	slug: "development",
	kind: "development",
	isDefault: false,
	isProtected: false,
};

const renderPage = (environmentId?: string) =>
	render(
		<ConnectSettingsPage
			environmentId={environmentId}
			onEnvironmentChange={vi.fn()}
		/>,
	);

const section = (title: string) =>
	screen
		.getByRole("heading", { name: title })
		.closest("section") as HTMLElement;

beforeEach(() => {
	mocks.environments = [production, development];
	mocks.apps = {};
	mocks.canManage = true;
	mocks.saveSettings.mockReset();
	mocks.saveApp.mockReset();
	mocks.deleteApp.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe("Default redirect URL", () => {
	it("warns that connect links are refused until one is set", () => {
		renderPage();
		expect(screen.getByText("No default redirect URL")).toBeTruthy();
	});

	it("refuses a URL that is not https, and saves one that is, allowing it too", () => {
		renderPage();
		const card = section("Default redirect URL");
		const input = within(card).getByLabelText("URL");
		fireEvent.change(input, { target: { value: "http://app.acme.com" } });
		fireEvent.click(within(card).getByRole("button", { name: "Save" }));
		expect(
			within(card).getByText("Use an https URL (http only for localhost)."),
		).toBeTruthy();
		expect(mocks.saveSettings).not.toHaveBeenCalled();

		fireEvent.change(input, {
			target: { value: "https://app.acme.com/settings/" },
		});
		expect(
			within(card).getByText(
				"Saving also adds it to the allowed redirect URLs.",
			),
		).toBeTruthy();
		fireEvent.click(within(card).getByRole("button", { name: "Save" }));
		expect(mocks.saveSettings.mock.calls[0][0]).toEqual({
			environmentId: "env-prod",
			defaultRedirectUrl: "https://app.acme.com/settings",
			allowedRedirectUrls: ["https://app.acme.com/settings"],
		});
	});
});

describe("Allowed redirect URLs", () => {
	it("adds an https URL with a path and refuses a query string", () => {
		renderPage();
		const card = section("Allowed redirect URLs");
		const input = within(card).getByLabelText("Redirect URL to allow");
		fireEvent.change(input, {
			target: { value: "https://app.acme.com/x?next=/y" },
		});
		fireEvent.click(within(card).getByRole("button", { name: "Add URL" }));
		expect(within(card).getByRole("alert").textContent).toMatch(/query/);
		fireEvent.change(input, { target: { value: "https://app.acme.com/x" } });
		fireEvent.click(within(card).getByRole("button", { name: "Add URL" }));
		expect(mocks.saveSettings.mock.calls[0][0]).toEqual({
			environmentId: "env-prod",
			allowedRedirectUrls: ["https://app.acme.com/x"],
		});
	});

	it("keeps the URL the default relies on, and removes another after a named confirm", async () => {
		mocks.environments = [
			{
				...production,
				allowedRedirectUrls: [
					"https://app.acme.com/settings",
					"https://staging.acme.com",
				],
				defaultRedirectUrl: "https://app.acme.com/settings",
			},
		];
		renderPage();
		const card = section("Allowed redirect URLs");
		expect(within(card).getByText("Used by the default")).toBeTruthy();
		expect(
			within(card).queryByRole("button", {
				name: "Remove https://app.acme.com/settings",
			}),
		).toBeNull();
		fireEvent.click(
			within(card).getByRole("button", {
				name: "Remove https://staging.acme.com",
			}),
		);
		expect(
			await screen.findByRole("heading", {
				name: "Remove https://staging.acme.com?",
			}),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Remove URL" }));
		expect(mocks.saveSettings.mock.calls[0][0]).toEqual({
			environmentId: "env-prod",
			allowedRedirectUrls: ["https://app.acme.com/settings"],
		});
	});
});

describe("Connect confirmation", () => {
	it("cannot be turned off in a protected environment", () => {
		renderPage("env-prod");
		const select = within(section("Connect confirmation")).getByLabelText(
			"Confirmation",
		) as HTMLSelectElement;
		expect(select.value).toBe("required");
		const off = within(select).getByRole("option", {
			name: "Off: connect at once",
		}) as HTMLOptionElement;
		expect(off.disabled).toBe(true);
		expect(
			screen.getByText("Off is only for environments that are not protected."),
		).toBeTruthy();
	});

	it("can be turned off in development, with a warning once it is", () => {
		renderPage("env-dev");
		const select = within(section("Connect confirmation")).getByLabelText(
			"Confirmation",
		);
		fireEvent.change(select, { target: { value: "off" } });
		expect(mocks.saveSettings).toHaveBeenCalledWith({
			environmentId: "env-dev",
			connectConfirmation: "off",
		});
	});

	it("warns while it is off", () => {
		mocks.environments = [{ ...development, connectConfirmation: "off" }];
		renderPage("env-dev");
		expect(screen.getByText(/without your server checking/)).toBeTruthy();
	});
});

describe("Without permission", () => {
	it("offers no changes without permission to manage connections", () => {
		mocks.canManage = false;
		renderPage();
		expect(screen.queryByRole("button", { name: "Add URL" })).toBeNull();
		expect(
			(screen.getByLabelText("Confirmation") as HTMLSelectElement).disabled,
		).toBe(true);
	});
});

describe("Your own OAuth apps", () => {
	it("are on each integration's page now, and this page says where", () => {
		renderPage();
		expect(
			screen.queryByRole("heading", { name: "Your own OAuth apps" }),
		).toBeNull();
		expect(
			screen.getByText(/Your own OAuth apps are on each integration/),
		).toBeTruthy();
	});
});
