/* @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunWithSpans } from "@/lib/types";

const mocks = vi.hoisted(() => ({
	search: {} as Record<string, unknown>,
	navigate: vi.fn(),
	get: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useSearch: () => mocks.search,
		useNavigate: () => mocks.navigate,
	}),
}));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "workspace-1" } }),
}));

vi.mock("@/lib/api-client", () => ({
	apiClient: { get: mocks.get },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecentRunsPage } from "./recent-runs";

function makeRun(
	id: string,
	name: string,
	spanName: string,
	tokens: number,
): RunWithSpans {
	return {
		id,
		agentId: null,
		agentVersion: null,
		environmentId: "env_1",
		name,
		status: "succeeded",
		userId: null,
		application: "billing-bot",
		input: null,
		output: null,
		error: null,
		tokens,
		cost: null,
		tags: null,
		metadata: null,
		startedAt: "2026-10-26T08:00:00.000Z",
		endedAt: "2026-10-26T08:00:01.200Z",
		durationMs: 1200,
		spans: [
			{
				id: `${id}_span`,
				parentId: null,
				name: spanName,
				type: "model_call",
				status: "succeeded",
				startedAt: "2026-10-26T08:00:00.100Z",
				endedAt: "2026-10-26T08:00:01.000Z",
				durationMs: 900,
				model: null,
				provider: null,
				tokens: null,
				cost: null,
				input: null,
				output: null,
				error: null,
				attributes: null,
				children: [],
			},
		],
	};
}

const first = makeRun(
	"run_MgINLcS0tuXbjs7KyoLyV",
	"nightly-summary",
	"summarise.inbox",
	350,
);
const second = makeRun(
	"run_Q2xk0p9VbT3aWm7RzYc1D",
	"refund-check",
	"stripe.refunds.list",
	1234,
);

function answer(path: string) {
	if (path === "/runs") {
		const runs = [first, second].map(({ spans: _spans, ...run }) => run);
		return Promise.resolve({
			data: runs,
			pagination: { total: 2, limit: 50, offset: 0, hasMore: false },
		});
	}
	const run = [first, second].find((r) => path === `/runs/${r.id}`);
	return run
		? Promise.resolve(run)
		: Promise.reject(new Error("Run not found"));
}

function renderPage() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = () => (
		<QueryClientProvider client={client}>
			<RecentRunsPage />
		</QueryClientProvider>
	);
	const utils = render(view());
	mocks.navigate.mockImplementation(
		(options: { search: (previous: Record<string, unknown>) => unknown }) => {
			mocks.search = options.search(mocks.search) as Record<string, unknown>;
			utils.rerender(view());
		},
	);
	return utils;
}

beforeEach(() => {
	mocks.search = { view: "tree" };
	mocks.navigate.mockReset();
	mocks.get.mockReset();
	mocks.get.mockImplementation(answer);
});

describe("Agent runs detail drawer", () => {
	it("shows the chosen run's details, and follows a change of run", async () => {
		renderPage();

		fireEvent.click(
			await screen.findByRole("button", {
				name: "Inspect trace for nightly-summary",
			}),
		);
		expect(mocks.search.run).toBe(first.id);
		expect(await screen.findByText("summarise.inbox")).toBeTruthy();
		expect(screen.getByText("350")).toBeTruthy();
		expect(mocks.get).toHaveBeenCalledWith(`/runs/${first.id}`, {
			workspaceId: "workspace-1",
		});

		fireEvent.click(screen.getByRole("button", { name: /older/i }));
		expect(mocks.search.run).toBe(second.id);
		expect(await screen.findByText("stripe.refunds.list")).toBeTruthy();
		expect(screen.getByText("1,234")).toBeTruthy();
		expect(screen.queryByText("summarise.inbox")).toBeNull();
	});

	it("says so when the run cannot be loaded, rather than leaving the drawer blank", async () => {
		mocks.search = { view: "tree", run: "run_gone" };
		renderPage();

		expect(
			await screen.findByText("This run could not be loaded."),
		).toBeTruthy();
		expect(screen.getByText("Run not found")).toBeTruthy();
	});
});
