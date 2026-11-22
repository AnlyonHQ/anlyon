/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Secret } from "@/lib/types";

const api = vi.hoisted(() => ({
	puts: [] as Array<{ path: string; body: Record<string, unknown> }>,
	secrets: [] as unknown[],
}));

vi.mock("@/components/ui/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api-client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api-client")>()),
	apiClient: {
		get: async (path: string) => (path === "/secrets" ? api.secrets : null),
		put: async (path: string, body: Record<string, unknown>) => {
			api.puts.push({ path, body });
			return { name: path.split("/").pop() };
		},
		delete: async () => undefined,
	},
}));

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => true,
}));

vi.mock("@/hooks/use-plan-access", () => ({
	usePlanAccess: () => ({ teamPlanRequired: false }),
}));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "workspace-1" } }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useSearch: () => ({}),
		useNavigate: () => vi.fn(),
	}),
}));

import { SecretsPage } from "./secrets";

async function renderPage() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<SecretsPage />
		</QueryClientProvider>,
	);
	await waitFor(() => {
		expect(client.isFetching()).toBe(0);
		expect(
			screen.queryAllByText(/No secrets yet|STRIPE_KEY|LEGACY_KEY/).length,
		).toBeGreaterThan(0);
	});
	await act(async () => {});
}

const stripeKey: Secret = {
	id: "sec_1",
	name: "STRIPE_KEY",
	description: "Live Stripe key",
	allowedHosts: ["api.stripe.com", ".stripe.network"],
	allowedPlacements: ["header"],
	kind: "static",
	connection: null,
	integrationId: null,
	lastUsedAt: null,
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
} as Secret;

const legacyKey: Secret = {
	...stripeKey,
	id: "sec_2",
	name: "LEGACY_KEY",
	description: null,
	allowedHosts: null,
	allowedPlacements: null,
} as Secret;

async function openStoreDialog() {
	fireEvent.click(await screen.findByRole("button", { name: "Add secret" }));
	await screen.findByRole("dialog");
	fireEvent.change(screen.getByLabelText("Name"), {
		target: { value: "github_token" },
	});
	fireEvent.change(screen.getByLabelText("Value"), {
		target: { value: "ghp-fixture-value" },
	});
}

const store = () =>
	fireEvent.click(screen.getByRole("button", { name: "Store secret" }));

describe("Secrets page", () => {
	afterEach(cleanup);
	beforeEach(() => {
		api.puts = [];
		api.secrets = [];
	});

	it("stores a secret bound to the hosts it names, in a header by default", async () => {
		await renderPage();
		await openStoreDialog();
		expect(
			screen
				.getByRole("checkbox", { name: "Header" })
				.getAttribute("aria-checked"),
		).toBe("true");
		expect(
			screen
				.getByRole("checkbox", { name: "URL" })
				.getAttribute("aria-checked"),
		).toBe("false");

		fireEvent.change(screen.getByLabelText("Allowed hosts"), {
			target: { value: "API.GitHub.com, .githubusercontent.com" },
		});
		store();

		await waitFor(() => expect(api.puts).toHaveLength(1));
		expect(api.puts[0]).toEqual({
			path: "/secrets/GITHUB_TOKEN",
			body: {
				value: "ghp-fixture-value",
				allowedHosts: ["api.github.com", ".githubusercontent.com"],
				allowedPlacements: ["header"],
			},
		});
		expect(document.body.textContent).not.toContain("ghp-fixture-value");
	});

	it("sends no placement limit when every placement is allowed", async () => {
		await renderPage();
		await openStoreDialog();
		fireEvent.change(screen.getByLabelText("Allowed hosts"), {
			target: { value: "api.github.com" },
		});
		fireEvent.click(screen.getByRole("checkbox", { name: "URL" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Body" }));
		store();

		await waitFor(() => expect(api.puts).toHaveLength(1));
		expect(api.puts[0].body.allowedPlacements).toBeNull();
	});

	it.each([
		["", "Name at least one host this secret may be sent to."],
		["   ,  ", "Name at least one host this secret may be sent to."],
		["https://api.github.com", "is not a bare hostname"],
		["api.github.com/v3", "is not a bare hostname"],
		["*.github.com", "start a host with a dot instead of *"],
		["api.github.com:443", "leave out the port"],
		["api_github.com", "is not a hostname"],
	])(
		"refuses hosts %j with a message, and sends nothing",
		async (hosts, message) => {
			await renderPage();
			await openStoreDialog();
			fireEvent.change(screen.getByLabelText("Allowed hosts"), {
				target: { value: hosts },
			});
			store();

			expect((await screen.findByRole("alert")).textContent).toContain(message);
			expect(screen.getByRole("dialog")).toBeTruthy();
			expect(api.puts).toEqual([]);
		},
	);

	it("refuses a secret allowed nowhere in a request", async () => {
		await renderPage();
		await openStoreDialog();
		fireEvent.change(screen.getByLabelText("Allowed hosts"), {
			target: { value: "api.github.com" },
		});
		fireEvent.click(screen.getByRole("checkbox", { name: "Header" }));
		store();

		expect((await screen.findByRole("alert")).textContent).toBe(
			"Choose where in a request the secret may appear.",
		);
		expect(api.puts).toEqual([]);
	});

	it("shows each secret's hosts on its row, and flags one bound to none", async () => {
		api.secrets = [stripeKey, legacyKey];
		await renderPage();
		expect(
			await screen.findByText("api.stripe.com, .stripe.network"),
		).toBeTruthy();
		expect(screen.getByText("Any public host")).toBeTruthy();
	});

	it("rotates a secret with its hosts, placements and description filled in", async () => {
		api.secrets = [stripeKey];
		await renderPage();
		fireEvent.click(
			await screen.findByRole("button", { name: "Rotate STRIPE_KEY" }),
		);
		await screen.findByRole("dialog");

		expect(
			(screen.getByLabelText("Allowed hosts") as HTMLInputElement).value,
		).toBe("api.stripe.com, .stripe.network");
		expect(
			screen
				.getByRole("checkbox", { name: "Header" })
				.getAttribute("aria-checked"),
		).toBe("true");
		expect(
			screen
				.getByRole("checkbox", { name: "Body" })
				.getAttribute("aria-checked"),
		).toBe("false");
		expect(
			(screen.getByLabelText("Description (optional)") as HTMLTextAreaElement)
				.value,
		).toBe("Live Stripe key");
		expect(screen.queryByLabelText("Name")).toBeNull();

		fireEvent.change(screen.getByLabelText("New value"), {
			target: { value: "sk-rotated-fixture" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));

		await waitFor(() => expect(api.puts).toHaveLength(1));
		expect(api.puts[0]).toEqual({
			path: "/secrets/STRIPE_KEY",
			body: {
				value: "sk-rotated-fixture",
				description: "Live Stripe key",
				allowedHosts: ["api.stripe.com", ".stripe.network"],
				allowedPlacements: ["header"],
			},
		});
	});

	it("asks for hosts when rotating a secret that was bound to none", async () => {
		api.secrets = [legacyKey];
		await renderPage();
		fireEvent.click(
			await screen.findByRole("button", { name: "Rotate LEGACY_KEY" }),
		);
		await screen.findByRole("dialog");
		expect(
			(screen.getByLabelText("Allowed hosts") as HTMLInputElement).value,
		).toBe("");
		expect(
			screen.getByText(/LEGACY_KEY may be sent to any public host now/),
		).toBeTruthy();
		for (const name of ["Header", "URL", "Body"])
			expect(
				screen.getByRole("checkbox", { name }).getAttribute("aria-checked"),
			).toBe("true");

		fireEvent.change(screen.getByLabelText("New value"), {
			target: { value: "sk-rotated-fixture" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Name at least one host this secret may be sent to.",
		);
		expect(api.puts).toEqual([]);

		fireEvent.change(screen.getByLabelText("Allowed hosts"), {
			target: { value: "api.example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
		await waitFor(() => expect(api.puts).toHaveLength(1));
		expect(api.puts[0].body).toEqual({
			value: "sk-rotated-fixture",
			allowedHosts: ["api.example.com"],
			allowedPlacements: null,
		});
	});
});
