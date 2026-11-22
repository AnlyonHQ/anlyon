/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import { ApprovalPoliciesPage } from "./approval-policies";

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

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => true,
}));

vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({
		data: [{ id: "env_dev", name: "Development" }],
		isLoading: false,
	}),
}));

vi.mock("@/hooks/api/use-actions", () => ({
	useEnvironmentActions: () => ({
		isLoading: false,
		data: [
			{ id: "a1", name: "refund_order" },
			{ id: "a2", name: "get_order" },
		],
	}),
}));

vi.mock("@/hooks/api/use-assistant", () => ({
	usePolicySuggestions: () => ({ data: [], isLoading: false }),
	useAcceptPolicySuggestion: () => ({ mutate: vi.fn(), isPending: false }),
}));

const LIST = "/api/v2/workspaces/workspace-1/approval-policies";

function storedPolicy(name: string, actionName: string, n: number) {
	return {
		id: `pol_${n}`,
		environmentId: "env_dev",
		name,
		priority: 100,
		enabled: true,
		scope: "specific_action",
		needsScopeReview: false,
		match: {
			kind: "action",
			actionName,
			agentId: null,
			userId: null,
			tags: null,
			minAmount: null,
			conditions: null,
			condition: null,
		},
		effect: "require_approval",
		requiredApprovals: 1,
		decidedBy: "team",
		version: 1,
		scopeReviewedAt: null,
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		managedBy: null,
	};
}

let stored: ReturnType<typeof storedPolicy>[] = [];

function reply(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function scheduler(input: RequestInfo | URL, init?: RequestInit) {
	const url = new URL(String(input));
	const method = init?.method ?? "GET";
	if (url.pathname === LIST && method === "GET") {
		return reply(200, { success: true, data: stored });
	}
	if (url.pathname === LIST && method === "POST") {
		const body = JSON.parse(String(init?.body));
		if (stored.some((policy) => policy.name === body.name)) {
			return reply(409, {
				success: false,
				error: {
					code: "CONFLICT",
					message: `A policy named "${body.name}" already exists in this environment.`,
				},
			});
		}
		const created = storedPolicy(
			body.name,
			body.matchActionName,
			stored.length + 1,
		);
		stored = [...stored, created];
		return reply(201, { success: true, data: created });
	}
	if (url.pathname === `${LIST}/condition-assist`) {
		return reply(200, {
			success: true,
			data: {
				check: null,
				sample: null,
				inputFields: [],
				facts: [],
				legacyCondition: null,
			},
		});
	}
	return reply(200, { success: true, data: [] });
}

beforeEach(() => {
	stored = [storedPolicy("Approve refund_order every time", "refund_order", 1)];
	vi.stubGlobal("fetch", vi.fn(scheduler));
});

function renderPage() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<ToastProvider position="top-right">
				<ApprovalPoliciesPage />
			</ToastProvider>
		</QueryClientProvider>,
	);
}

const toasts = () => within(screen.getByRole("region"));

const listRequests = () =>
	vi
		.mocked(fetch)
		.mock.calls.filter(
			([input, init]) =>
				new URL(String(input)).pathname === LIST &&
				(init?.method ?? "GET") === "GET",
		);

async function openNewPolicy(actionName: string) {
	fireEvent.click(await screen.findByRole("button", { name: "New policy" }));
	await screen.findByText("Create approval policy");
	await waitFor(() =>
		expect(screen.getByText(/In/).textContent).toContain("Development"),
	);
	fireEvent.change(screen.getByLabelText("Action"), {
		target: { value: actionName },
	});
}

describe("Policies page against the scheduler's responses", () => {
	it("lists the policies the API returns", async () => {
		renderPage();

		expect(
			await screen.findByText("Approve refund_order every time"),
		).toBeTruthy();
		expect(screen.queryByText("No policies yet")).toBeNull();
	});

	it("shows a created policy in the list, with a success toast, and closes the form", async () => {
		renderPage();
		await screen.findByText("Approve refund_order every time");
		const before = listRequests().length;

		await openNewPolicy("get_order");
		fireEvent.click(screen.getByRole("button", { name: "Create" }));

		expect(await toasts().findByText("Policy created")).toBeTruthy();
		await waitFor(() =>
			expect(screen.queryByText("Create approval policy")).toBeNull(),
		);
		expect(
			await screen.findByText("Approve get_order every time"),
		).toBeTruthy();
		expect(listRequests().length).toBeGreaterThan(before);
		expect(screen.getByText("2 policies")).toBeTruthy();
	});

	it("shows the API's message in an error toast for a duplicate name and keeps the form", async () => {
		renderPage();
		await screen.findByText("Approve refund_order every time");

		await openNewPolicy("refund_order");
		fireEvent.click(screen.getByRole("button", { name: "Create" }));

		const message =
			'A policy named "Approve refund_order every time" already exists in this environment.';
		expect(await toasts().findByText(message)).toBeTruthy();
		expect(toasts().queryByText("Policy created")).toBeNull();
		expect(screen.getByText("Create approval policy")).toBeTruthy();
		expect((screen.getByLabelText("Action") as HTMLSelectElement).value).toBe(
			"refund_order",
		);
		expect(screen.getByRole("alert").textContent).toContain(message);
		expect(screen.getByText("1 policy")).toBeTruthy();
	});
});
