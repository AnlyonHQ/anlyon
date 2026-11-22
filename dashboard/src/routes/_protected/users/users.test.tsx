/* @vitest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EndUser, EndUserConnection } from "@/lib/types";

const mocks = vi.hoisted(() => ({
	page: undefined as unknown,
	connections: [] as unknown[],
	invocations: [] as unknown[],
	approvals: [] as unknown[],
	limits: [] as unknown[],
	limitArgs: [] as unknown[][],
	revoke: vi.fn(),
	erase: vi.fn(),
	canManage: true,
	endUsersArgs: [] as unknown[][],
	invocationParams: [] as unknown[],
	approvalParams: [] as unknown[],
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: Record<string, unknown>) => options,
	Link: ({
		to,
		params,
		search,
		children,
		...rest
	}: {
		to: string;
		params?: Record<string, string>;
		search?: Record<string, string | undefined>;
		children: React.ReactNode;
	}) => {
		const path = to.replace(
			"$endUserId",
			encodeURIComponent(params?.endUserId ?? ""),
		);
		const query = new URLSearchParams(
			Object.entries(search ?? {}).flatMap(([k, v]) =>
				v === undefined ? [] : [[k, v]],
			),
		).toString();
		return (
			<a href={query ? `${path}?${query}` : path} {...rest}>
				{children}
			</a>
		);
	},
}));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "workspace-1" } }),
}));

vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({
		data: [
			{ id: "env-prod", name: "Production", isDefault: true },
			{ id: "env-dev", name: "Development", isDefault: false },
		],
		isLoading: false,
	}),
}));

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => mocks.canManage,
}));

vi.mock("@/hooks/api/use-end-users", () => ({
	useEndUsers: (...args: unknown[]) => {
		mocks.endUsersArgs.push(args);
		return {
			data: mocks.page,
			isLoading: false,
			isError: false,
			isFetching: false,
		};
	},
	useEndUserConnections: () => ({
		data: mocks.connections,
		isLoading: false,
		isError: false,
	}),
	useEndUserLimits: (...args: unknown[]) => {
		mocks.limitArgs.push(args);
		return { data: mocks.limits, isLoading: false, isError: false };
	},
	useRevokeEndUserConnection: () => ({
		mutate: mocks.revoke,
		isPending: false,
	}),
	useEraseEndUser: () => ({ mutate: mocks.erase, isPending: false }),
}));

vi.mock("@/hooks/api/use-actions", () => ({
	useInvocations: (_w: string, params: unknown) => {
		mocks.invocationParams.push(params);
		return {
			data: { data: mocks.invocations },
			isLoading: false,
		};
	},
}));

vi.mock("@/hooks/api/use-approvals", () => ({
	useApprovals: (_w: string, params: { decider?: string }) => {
		mocks.approvalParams.push(params);
		const rows = (mocks.approvals as Array<{ decider?: string }>).filter(
			(row) => (row.decider ?? "team") === (params.decider ?? "team"),
		);
		return {
			data: { data: rows, pagination: { total: rows.length } },
			isLoading: false,
		};
	},
}));

vi.mock("@/components/effects/environment-select", () => ({
	EnvironmentSelect: () => null,
}));

import { UserPage } from "./$endUserId";
import { UsersPage } from "./index";

const ada: EndUser = {
	endUserId: "user_42",
	connections: 2,
	invocations: 1_234,
	pendingApprovals: 1,
};

const TEN_DAYS_AGO = new Date(
	Date.now() - 10 * 24 * 60 * 60 * 1000,
).toISOString();

const gmail: EndUserConnection = {
	integration: "gmail",
	status: "active",
	scopes: ["https://www.googleapis.com/auth/gmail.send"],
	connectedAt: TEN_DAYS_AGO,
	updatedAt: TEN_DAYS_AGO,
};

beforeEach(() => {
	mocks.page = { data: [ada], pagination: { nextCursor: "cur_2" } };
	mocks.connections = [];
	mocks.invocations = [];
	mocks.approvals = [];
	mocks.limits = [];
	mocks.limitArgs = [];
	mocks.canManage = true;
	mocks.endUsersArgs = [];
	mocks.invocationParams = [];
	mocks.approvalParams = [];
	mocks.revoke.mockReset();
	mocks.erase.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe("Users list", () => {
	const renderList = (props: Partial<Parameters<typeof UsersPage>[0]> = {}) => {
		const onNavigate = vi.fn();
		render(
			<UsersPage
				cursor={undefined}
				environmentId="env-prod"
				onNavigate={onNavigate}
				query={undefined}
				{...props}
			/>,
		);
		return { onNavigate };
	};

	it("lists users with their counts, linked to their page", () => {
		renderList();
		const row = screen.getByText("user_42").closest("tr") as HTMLElement;
		expect(within(row).getByText("2")).toBeTruthy();
		expect(within(row).getByText((1_234).toLocaleString())).toBeTruthy();
		expect(screen.getByText("user_42").getAttribute("href")).toBe(
			"/users/user_42?environmentId=env-prod",
		);
		expect(mocks.endUsersArgs[0]).toEqual([
			"workspace-1",
			"env-prod",
			undefined,
			undefined,
		]);
	});

	it("pages forward with the cursor and back to the first page, keeping the search", () => {
		const { onNavigate } = renderList({ cursor: "cur_1", query: "user_" });
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		expect(onNavigate).toHaveBeenCalledWith({
			environmentId: "env-prod",
			q: "user_",
			cursor: "cur_2",
		});
		fireEvent.click(screen.getByRole("button", { name: "Back to the start" }));
		expect(onNavigate).toHaveBeenLastCalledWith({
			environmentId: "env-prod",
			q: "user_",
		});
	});

	it("searches by id from the first page, and refuses what cannot be an id", () => {
		const { onNavigate } = renderList({ cursor: "cur_1" });
		const input = screen.getByLabelText("Search users by id");
		fireEvent.change(input, { target: { value: "user 42" } });
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(screen.getByRole("alert").textContent).toMatch(/1 to 128/);
		expect(onNavigate).not.toHaveBeenCalled();
		fireEvent.change(input, { target: { value: "  org:7@acme  " } });
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(onNavigate).toHaveBeenCalledWith({
			environmentId: "env-prod",
			q: "org:7@acme",
		});
	});

	it("passes the search to the API and says when nothing matches", () => {
		mocks.page = { data: [], pagination: { nextCursor: null } };
		renderList({ query: "zed" });
		expect(mocks.endUsersArgs[0]).toEqual([
			"workspace-1",
			"env-prod",
			undefined,
			"zed",
		]);
		expect(screen.getByRole("status").textContent).toBe(
			"No user id starts with “zed”.",
		);
	});

	it("explains how a user appears when there are none", () => {
		mocks.page = { data: [], pagination: { nextCursor: null } };
		renderList();
		expect(screen.getByText("No users yet")).toBeTruthy();
	});
});

describe("User page", () => {
	const renderPage = () => {
		const onErased = vi.fn();
		render(
			<UserPage
				endUserId="user_42"
				environmentId="env-prod"
				onErased={onErased}
			/>,
		);
		return { onErased };
	};

	it("shows connections with status, scopes and when they were connected", () => {
		mocks.connections = [
			gmail,
			{ ...gmail, integration: "slack", status: "needs_reconnect" },
		];
		renderPage();
		const row = screen.getByText("Gmail").closest("tr") as HTMLElement;
		expect(within(row).getByText("Active")).toBeTruthy();
		expect(
			within(row).getByText("https://www.googleapis.com/auth/gmail.send"),
		).toBeTruthy();
		expect(within(row).getByText(/ago|yesterday|in /)).toBeTruthy();
		expect(screen.getByText("Needs reconnecting")).toBeTruthy();
	});

	it("revokes a connection after a confirm that names it", async () => {
		mocks.connections = [gmail];
		renderPage();
		fireEvent.click(
			screen.getByRole("button", { name: "Revoke Gmail for user_42" }),
		);
		expect(
			await screen.findByRole("heading", { name: "Revoke Gmail for user_42?" }),
		).toBeTruthy();
		expect(mocks.revoke).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Revoke Gmail" }));
		expect(mocks.revoke).toHaveBeenCalledWith({
			endUserId: "user_42",
			integration: "gmail",
		});
	});

	it("reads invocations and pending approvals for this user only", () => {
		mocks.invocations = [
			{
				id: "inv_1",
				actionName: "send-email",
				status: "succeeded",
				createdAt: "2026-10-24T08:00:00.000Z",
			},
		];
		mocks.approvals = [
			{
				id: "apr_1",
				title: "Send an email",
				decider: "end_user",
				createdAt: "2026-10-24T09:00:00.000Z",
				expiresAt: "2099-10-24T08:00:00.000Z",
			},
			{
				id: "apr_2",
				title: "Delete a contact",
				createdAt: "2026-10-24T08:00:00.000Z",
				expiresAt: "2099-10-24T08:00:00.000Z",
			},
		];
		renderPage();
		expect(mocks.invocationParams[0]).toMatchObject({
			endUserId: "user_42",
			environmentId: "env-prod",
		});
		expect(mocks.approvalParams[0]).toMatchObject({
			endUserId: "user_42",
			status: "pending",
		});
		expect(mocks.approvalParams[1]).toMatchObject({
			endUserId: "user_42",
			status: "pending",
			decider: "end_user",
		});
		expect(screen.getByText("send-email").getAttribute("href")).toBe(
			"/actions/invocations?invocation=inv_1&endUser=user_42&environmentId=env-prod",
		);
		expect(screen.getByText("Send an email").getAttribute("href")).toBe(
			"/approvals?id=apr_1&endUser=user_42&tab=users",
		);
		expect(screen.getByText("The user")).toBeTruthy();
		expect(screen.getByText("Your team")).toBeTruthy();
		expect(screen.getByText("Delete a contact").getAttribute("href")).toBe(
			"/approvals?id=apr_2",
		);
		expect(
			screen.getByText("Waiting on a decision").nextSibling?.textContent,
		).toBe("2");
	});

	it("shows this user's own figures on the limits each user gets", () => {
		mocks.limits = [
			{
				id: "lim_1",
				name: "Daily email cap",
				dimension: "emails",
				currency: null,
				unit: "emails",
				scope: {
					environmentId: "env-prod",
					actionName: "send-email",
					resourcePrefix: null,
					kind: "end_user",
				},
				period: "day",
				limit: 50,
				currentPeriod: "2026-10-25",
				consumed: 12,
				reserved: 0,
				unknownExposure: 0,
				available: 38,
				archived: false,
				createdAt: "2026-10-20T08:00:00.000Z",
				updatedAt: "2026-10-20T08:00:00.000Z",
			},
		];
		renderPage();
		expect(mocks.limitArgs[0]).toEqual(["workspace-1", "env-prod", "user_42"]);
		const row = screen
			.getByText("Daily email cap")
			.closest("tr") as HTMLElement;
		expect(row.textContent).toContain("12 emails used");
		expect(row.textContent).toContain("38 emails");
		expect(row.textContent).toContain("of 50 emails");
	});

	it("says when no limit applies to each user", () => {
		renderPage();
		expect(screen.getByText("No per-user limits")).toBeTruthy();
	});

	it("erases only once the id is typed, and says receipts are kept hashed", async () => {
		const { onErased } = renderPage();
		fireEvent.click(screen.getByRole("button", { name: "Erase user" }));
		expect(
			await screen.findByRole("heading", { name: "Erase user_42?" }),
		).toBeTruthy();
		expect(screen.getByText(/one-way hash/)).toBeTruthy();
		const erase = screen.getByRole("button", {
			name: "Erase user_42",
		}) as HTMLButtonElement;
		expect(erase.disabled).toBe(true);
		fireEvent.change(screen.getByLabelText(/to confirm/), {
			target: { value: "user_42" },
		});
		expect(erase.disabled).toBe(false);
		fireEvent.click(erase);
		expect(mocks.erase).toHaveBeenCalledTimes(1);
		expect(mocks.erase.mock.calls[0][0]).toEqual({ endUserId: "user_42" });
		mocks.erase.mock.calls[0][1].onSuccess();
		expect(onErased).toHaveBeenCalled();
	});

	it("offers no revoke or erase without permission to manage connections", () => {
		mocks.canManage = false;
		mocks.connections = [gmail];
		renderPage();
		expect(screen.queryByRole("button", { name: /Revoke/ })).toBeNull();
		expect(screen.queryByRole("button", { name: "Erase user" })).toBeNull();
	});
});
