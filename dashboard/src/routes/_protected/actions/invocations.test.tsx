/* @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	search: {} as Record<string, string | undefined>,
	navigate: vi.fn(),
	params: [] as unknown[],
	rows: [] as unknown[],
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useSearch: () => mocks.search,
		useNavigate: () => mocks.navigate,
	}),
	Link: ({ children }: { children: React.ReactNode }) => (
		<a href="/">{children}</a>
	),
}));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "workspace-1" } }),
}));

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => true,
}));

vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({ data: [] }),
}));

vi.mock("@/hooks/api/use-actions", () => ({
	useInvocations: (_w: string, params: unknown) => {
		mocks.params.push(params);
		return { data: { data: mocks.rows }, isLoading: false };
	},
	useInvocation: () => ({ data: undefined }),
}));

import { InvocationsPage as Page } from "./invocations";

afterEach(cleanup);

beforeEach(() => {
	mocks.search = { invocation: undefined, status: undefined };
	mocks.navigate.mockReset();
	mocks.params = [];
	mocks.rows = [];
});

describe("Invocations and users", () => {
	it("names the user on a row that acted for one", () => {
		mocks.rows = [
			{
				id: "inv_1",
				actionName: "send-email",
				status: "succeeded",
				responseStatus: 200,
				durationMs: 120,
				createdAt: "2026-10-24T08:00:00.000Z",
				endUserId: "user_42",
			},
			{
				id: "inv_2",
				actionName: "refund-order",
				status: "succeeded",
				responseStatus: 200,
				durationMs: 80,
				createdAt: "2026-10-24T08:00:00.000Z",
				endUserId: null,
			},
		];
		render(<Page />);
		const forUser = screen.getByText("send-email").closest("tr") as HTMLElement;
		expect(within(forUser).getByText("user_42")).toBeTruthy();
		const forWorkspace = screen
			.getByText("refund-order")
			.closest("tr") as HTMLElement;
		expect(within(forWorkspace).getByText("Workspace")).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: "For" })).toBeTruthy();
	});

	it("switches between all calls, the workspace's and the users', in the URL", () => {
		mocks.search = { actingFor: "workspace" };
		render(<Page />);
		expect(mocks.params[0]).toMatchObject({ actingFor: "workspace" });
		const toolbar = document.querySelector(
			'[data-slot="page-toolbar"]',
		) as HTMLElement;
		expect(toolbar.firstElementChild?.getAttribute("role")).toBe("radiogroup");
		expect(
			screen
				.getByRole("radio", { name: "Your workspace" })
				.getAttribute("aria-checked"),
		).toBe("true");
		fireEvent.click(screen.getByRole("radio", { name: "Your users" }));
		const update = mocks.navigate.mock.calls[0][0].search;
		expect(update({ actingFor: "workspace", offset: 50 })).toEqual({
			actingFor: "end_users",
			invocation: undefined,
			offset: undefined,
		});
		fireEvent.click(screen.getByRole("radio", { name: "All" }));
		const cleared = mocks.navigate.mock.calls[1][0].search;
		expect(cleared({ actingFor: "workspace" }).actingFor).toBeUndefined();
	});

	it("reads only the user in the URL, and filters from the toolbar", () => {
		mocks.search = { endUser: "user_42" };
		render(<Page />);
		expect(mocks.params[0]).toMatchObject({ endUserId: "user_42" });
		expect(screen.getByText("No invocations for this user")).toBeTruthy();
		const input = screen.getByLabelText("User");
		fireEvent.change(input, { target: { value: "user_7" } });
		fireEvent.submit(input.closest("form") as HTMLFormElement);
		const update = mocks.navigate.mock.calls[0][0].search;
		expect(update({ status: "unknown", invocation: "inv_1" })).toEqual({
			status: "unknown",
			invocation: undefined,
			endUser: "user_7",
		});
	});
});
