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
import type { ImportedOperation, ImportResult } from "@/lib/openapi-import";

const api = vi.hoisted(() => ({
	posts: [] as Array<Record<string, unknown>>,
	puts: [] as Array<{ path: string; body: Record<string, unknown> }>,
	secrets: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/ui/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const declares = (
	impact: ImportedOperation["impact"],
): Pick<ImportedOperation, "governed" | "impact" | "requiresApproval"> => ({
	governed: impact !== null,
	impact,
	requiresApproval: false,
});

const ONE = {
	dimension: "resource_mutations",
	amount: "1",
	bound: "exact" as const,
};

const OPERATIONS: ImportedOperation[] = [
	{
		name: "GetCharges",
		method: "GET",
		path: "/v1/charges",
		urlTemplate: "https://api.stripe.com/v1/charges",
		warnings: [],
		...declares(null),
		customized: false,
		suggestion: {
			risk: "read",
			reasons: ["GET reads and changes nothing."],
			requiresApproval: false,
			impact: null,
			impactNote: null,
		},
		proposedVerify: null,
		verifyNote: null,
	},
	{
		name: "PostRefunds",
		method: "POST",
		path: "/v1/refunds",
		urlTemplate: "https://api.stripe.com/v1/refunds",
		warnings: [],
		...declares(ONE),
		customized: false,
		suggestion: {
			risk: "irreversible",
			reasons: [
				'The path segment "refunds" says "refund": it usually moves money, which cannot be taken back.',
			],
			requiresApproval: true,
			impact: {
				dimension: "money",
				unit: null,
				amount: "input.amount",
				bound: "exact",
			},
			impactNote: "Counts input.amount as minor units (cents for usd).",
		},
		proposedVerify: null,
		verifyNote: null,
	},
	{
		name: "PostCustomers",
		method: "POST",
		path: "/v1/customers",
		urlTemplate: "https://api.stripe.com/v1/customers",
		warnings: [],
		...declares(ONE),
		customized: false,
		suggestion: {
			risk: "write",
			reasons: ["POST changes something."],
			requiresApproval: false,
			impact: { ...ONE, unit: "resource_mutations" },
			impactNote: null,
		},
		proposedVerify: null,
		verifyNote: null,
	},
];

vi.mock("@/lib/api-client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api-client")>()),
	apiClient: {
		get: async (path: string) => (path === "/secrets" ? api.secrets : []),
		post: async (
			_path: string,
			body: Record<string, unknown>,
		): Promise<ImportResult> => {
			api.posts.push(body);
			const only = body.only as string[] | undefined;
			const operations = (body.operations ?? {}) as Record<string, unknown>;
			const created = OPERATIONS.filter(
				(op) => !only || only.includes(`${op.method} ${op.path}`),
			).map((op) => ({
				...op,
				customized: `${op.method} ${op.path}` in operations,
			}));
			return {
				created,
				skipped: [
					{
						path: "/v1/files",
						method: "POST",
						reason: "request body is not application/json",
					},
				],
				dryRun: body.dryRun === true,
				suggestedAllowedHosts: ["api.stripe.com"],
			};
		},
		put: async (path: string, body: Record<string, unknown>) => {
			api.puts.push({ path, body });
			return { name: path.split("/").pop() };
		},
	},
}));

import { ImportOpenApiDialog } from "./import-openapi-dialog";

const SPEC = JSON.stringify({
	openapi: "3.0.0",
	servers: [{ url: "https://api.stripe.com" }],
	paths: {},
});

async function review() {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<ImportOpenApiDialog workspaceId="workspace-1" />
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Import OpenAPI" }));
	fireEvent.change(await screen.findByLabelText("OpenAPI 3 spec (JSON)"), {
		target: { value: SPEC },
	});
}

const lastPost = () => api.posts.at(-1)!;

describe("Import an OpenAPI spec", () => {
	beforeEach(() => {
		api.posts = [];
		api.puts = [];
		api.secrets = [];
	});
	afterEach(cleanup);

	it("reviews every operation with its suggestion, and imports with the defaults when nothing is accepted", async () => {
		await review();
		fireEvent.click(screen.getByRole("button", { name: "Review operations" }));
		expect(await screen.findByText("Irreversible")).toBeTruthy();
		expect(screen.getByText("Read")).toBeTruthy();
		expect(screen.getByText("Write")).toBeTruthy();
		expect(lastPost()).toMatchObject({ dryRun: true });
		expect(screen.getByText(/Not imported \(1\)/)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Import 3 actions" }));
		expect(await screen.findByText("Imported 3 actions")).toBeTruthy();
		expect(lastPost().dryRun).toBeUndefined();
		expect(lastPost().only).toEqual([
			"GET /v1/charges",
			"POST /v1/refunds",
			"POST /v1/customers",
		]);
		expect(lastPost().operations).toBeUndefined();
	});

	it("applies an accepted suggestion only to its own operation, once its currency is chosen", async () => {
		await review();
		fireEvent.click(screen.getByRole("button", { name: "Review operations" }));
		fireEvent.change(await screen.findByLabelText("Settings for PostRefunds"), {
			target: { value: "suggested" },
		});
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Import GetCharges" }),
		);

		fireEvent.click(screen.getByRole("button", { name: "Import 2 actions" }));
		expect(await screen.findByText(/Choose the currency/)).toBeTruthy();
		expect(api.posts.filter((p) => !p.dryRun)).toEqual([]);

		fireEvent.change(screen.getByLabelText("Currency"), {
			target: { value: "usd" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Import 2 actions" }));
		expect(await screen.findByText("Imported 2 actions")).toBeTruthy();
		expect(lastPost().only).toEqual(["POST /v1/refunds", "POST /v1/customers"]);
		expect(lastPost().operations).toEqual({
			"POST /v1/refunds": {
				requiresApproval: true,
				impact: {
					dimension: "money",
					unit: "usd",
					amount: "input.amount",
					bound: "exact",
				},
			},
		});
	});

	it("overrides a suggestion with custom values", async () => {
		await review();
		fireEvent.click(screen.getByRole("button", { name: "Review operations" }));
		fireEvent.change(
			await screen.findByLabelText("Settings for PostCustomers"),
			{ target: { value: "custom" } },
		);
		fireEvent.click(
			screen.getByRole("checkbox", { name: "A person approves every call" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Import 3 actions" }));
		await screen.findByText("Imported 3 actions");
		expect(lastPost().operations).toEqual({
			"POST /v1/customers": {
				requiresApproval: true,
				impact: {
					dimension: "resource_mutations",
					unit: "resource_mutations",
					amount: "1",
					bound: "exact",
				},
			},
		});
	});

	it("stores a new key bound to the suggested hosts, always, then imports with it", async () => {
		await review();
		fireEvent.change(screen.getByLabelText("Credential"), {
			target: { value: "__new__" },
		});
		fireEvent.change(screen.getByLabelText("Key name"), {
			target: { value: "stripe_key" },
		});
		fireEvent.change(screen.getByLabelText("Value"), {
			target: { value: "sk-fixture-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Review operations" }));
		await screen.findByText("Irreversible");
		expect(lastPost().auth).toBeUndefined();

		expect(
			screen.getByText("STRIPE_KEY is only sent to api.stripe.com"),
		).toBeTruthy();
		expect(screen.queryByRole("checkbox", { name: /Only send/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Import 3 actions" }));
		await screen.findByText("Imported 3 actions");
		expect(api.puts).toEqual([
			{
				path: "/secrets/STRIPE_KEY",
				body: { value: "sk-fixture-value", allowedHosts: ["api.stripe.com"] },
			},
		]);
		expect(lastPost().auth).toEqual({
			headerName: "Authorization",
			secretName: "STRIPE_KEY",
			valueTemplate: "Bearer {{secret}}",
		});
		expect(document.body.textContent).not.toContain("sk-fixture-value");
	});

	it("says what is wrong with a spec it cannot read", async () => {
		await review();
		fireEvent.change(screen.getByLabelText("OpenAPI 3 spec (JSON)"), {
			target: { value: "openapi: 3.0.0" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Review operations" }));
		expect(await screen.findByText(/The console reads JSON/)).toBeTruthy();
		expect(api.posts).toEqual([]);
	});

	it("offers no import before a review", async () => {
		await review();
		expect(screen.queryByRole("button", { name: /^Import \d/ })).toBeNull();
		await waitFor(() => expect(api.posts).toEqual([]));
	});
});
