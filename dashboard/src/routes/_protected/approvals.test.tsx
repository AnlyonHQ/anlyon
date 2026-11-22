/* @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalsSearch } from "./approvals";

const mocks = vi.hoisted(() => ({
	approvalParams: [] as Array<Record<string, unknown>>,
	team: [] as unknown[],
	users: [] as unknown[],
	detail: undefined as unknown,
	inboxProps: [] as Array<Record<string, unknown>>,
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
		const path = to.replace("$endUserId", params?.endUserId ?? "");
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
	useWorkspace: () => ({ currentWorkspace: { id: "ws_1" } }),
}));

vi.mock("@/hooks/api/use-approvals", () => ({
	useApprovals: (_w: string, params: Record<string, unknown>) => {
		mocks.approvalParams.push(params);
		const rows = params.decider === "end_user" ? mocks.users : mocks.team;
		return {
			data: { data: rows, pagination: { total: rows.length, hasMore: false } },
			isLoading: false,
			isError: false,
			isFetching: false,
		};
	},
	useApprovalDetail: (_w: string, id?: string) => ({
		data: id ? mocks.detail : undefined,
	}),
}));

vi.mock("@/components/defaults/defaults-hint", () => ({
	ApprovalsDefaultsHint: () => null,
}));
vi.mock("@/components/approvals/approval-inbox", () => ({
	ApprovalInbox: (props: Record<string, unknown>) => {
		mocks.inboxProps.push(props);
		return <div data-testid="team-inbox" />;
	},
}));

const { ApprovalsPage } = await import("./approvals");

afterEach(() => {
	cleanup();
	mocks.approvalParams = [];
	mocks.team = [];
	mocks.users = [];
	mocks.detail = undefined;
	mocks.inboxProps = [];
});

const waiting = {
	id: "apr_7",
	kind: "action",
	status: "pending",
	title: "Send an email",
	payload: { actionName: "gmail-send" },
	requiredApprovals: 1,
	approvedCount: 0,
	decider: "end_user",
	endUserId: "user_42",
	createdAt: "2026-10-24T10:00:00Z",
	expiresAt: "2099-10-25T10:00:00Z",
};

function renderPage(search: ApprovalsSearch = {}) {
	const onSearch = vi.fn();
	render(<ApprovalsPage onSearch={onSearch} search={search} />);
	return { onSearch };
}

describe("Approvals tabs", () => {
	it("opens on the team's inbox, with both tabs counting what waits", () => {
		mocks.team = [{ ...waiting, id: "apr_1", decider: "team" }];
		mocks.users = [waiting, { ...waiting, id: "apr_8" }];
		renderPage();
		const tabs = screen.getByRole("navigation", { name: "Who decides" });
		const team = within(tabs).getByRole("link", { name: /For your team/ });
		const users = within(tabs).getByRole("link", {
			name: /Waiting on your users/,
		});
		expect(team.getAttribute("aria-current")).toBe("page");
		expect(team.textContent).toContain("1");
		expect(users.textContent).toContain("2");
		expect(users.getAttribute("href")).toBe("/approvals?tab=users");
		expect(screen.getByTestId("team-inbox")).toBeTruthy();
	});

	it("lists what your users decide read-only: no approve or deny, and a line saying where", () => {
		mocks.users = [waiting];
		renderPage({ tab: "users" });
		expect(screen.queryByTestId("team-inbox")).toBeNull();
		expect(
			screen.getByText(/Your users decide these in your app/),
		).toBeTruthy();
		const row = screen.getByText("Send an email").closest("tr") as HTMLElement;
		expect(
			within(row).getByRole("link", { name: "user_42" }).getAttribute("href"),
		).toBe("/users/user_42");
		expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /deny/i })).toBeNull();
		const list = mocks.approvalParams.find(
			(params) => params.decider === "end_user" && params.limit === 50,
		);
		expect(list).toMatchObject({ status: "pending" });
	});

	it("filters the users' list by one user, and keeps the user on the tabs", () => {
		const { onSearch } = renderPage({ tab: "users", endUser: "user_42" });
		for (const params of mocks.approvalParams) {
			expect(params).toMatchObject({ endUserId: "user_42" });
		}
		const users = screen.getByRole("link", { name: /Waiting on your users/ });
		expect(users.getAttribute("href")).toBe(
			"/approvals?endUser=user_42&tab=users",
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Clear the user filter (user_42)" }),
		);
		expect(onSearch).toHaveBeenCalledWith({
			endUser: undefined,
			id: undefined,
		});
	});

	it("puts the three-way switch first, on the team's tab only, and keeps it in the URL", () => {
		const { onSearch } = renderPage({ actingFor: "workspace" });
		expect(mocks.inboxProps[0]).toMatchObject({ actingFor: "workspace" });
		const toolbar = document.querySelector(
			'[data-slot="page-toolbar"]',
		) as HTMLElement;
		expect(toolbar.firstElementChild?.getAttribute("role")).toBe("radiogroup");
		fireEvent.click(screen.getByRole("radio", { name: "Your users" }));
		expect(onSearch).toHaveBeenCalledWith({
			actingFor: "end_users",
			id: undefined,
		});
		cleanup();
		renderPage({ tab: "users" });
		expect(screen.queryByRole("radiogroup")).toBeNull();
	});

	it("keeps ?id= links working, opening the users' tab for one a user decides", () => {
		mocks.detail = { ...waiting };
		const { onSearch } = renderPage({ id: "apr_7" });
		expect(mocks.inboxProps[0]).toMatchObject({ deepLinkId: "apr_7" });
		expect(onSearch).toHaveBeenCalledWith({ tab: "users" }, true);
	});
});
