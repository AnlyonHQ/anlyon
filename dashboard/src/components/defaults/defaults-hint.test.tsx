/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "@/lib/types";

const state = vi.hoisted(() => ({ enabledTypes: [] as string[] }));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, hash }: { children: ReactNode; hash?: string }) => (
		<a href={`/settings/defaults#${hash}`}>{children}</a>
	),
}));
vi.mock("@/hooks/api/use-workspace-defaults", () => ({
	useWorkspaceDefaults: () => ({
		data: { effective: { endUserDecider: "team", approvalWindowHours: 24 } },
	}),
}));
vi.mock("@/hooks/api/use-notifications", () => ({
	useNotificationPreferences: () => ({
		data: { enabledTypes: state.enabledTypes },
	}),
}));

import {
	ApprovalsDefaultsHint,
	ConnectionBrokenHint,
	OutcomeUnknownHint,
} from "./defaults-hint";

const approval = (over: Partial<Approval>): Approval =>
	({
		id: "apr_1",
		status: "pending",
		matchedPolicyId: null,
		endUserId: null,
		...over,
	}) as Approval;

describe("defaults hints", () => {
	beforeEach(() => {
		localStorage.clear();
		state.enabledTypes = ["approval_expired"];
	});
	afterEach(cleanup);

	it("says a user's call with no policy came to the team, with a link to change it", () => {
		render(
			<ApprovalsDefaultsHint
				approvals={[approval({ endUserId: "user_42" })]}
				workspaceId="ws_1"
			/>,
		);
		expect(screen.getByText(/no policy saying who decides/)).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Change" }).getAttribute("href"),
		).toBe("/settings/defaults#who-decides");
	});

	it("stays away until the situation happens", () => {
		const { container } = render(
			<ApprovalsDefaultsHint
				approvals={[
					approval({ endUserId: "user_42", matchedPolicyId: "pol_1" }),
				]}
				workspaceId="ws_1"
			/>,
		);
		expect(container.textContent).toBe("");
	});

	it("says what an expired request does, with the current choice", () => {
		render(
			<ApprovalsDefaultsHint
				approvals={[approval({ status: "expired" })]}
				workspaceId="ws_1"
			/>,
		);
		expect(
			screen.getByText(/nobody answers in 24 hours.*your team is told/),
		).toBeTruthy();
	});

	it("is dismissed once per workspace and situation", () => {
		render(<OutcomeUnknownHint show workspaceId="ws_1" />);
		expect(screen.getByText(/waits here without an alert/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByText(/waits here/)).toBeNull();
		cleanup();
		render(<OutcomeUnknownHint show workspaceId="ws_1" />);
		expect(screen.queryByText(/waits here/)).toBeNull();
		render(<ConnectionBrokenHint show workspaceId="ws_1" />);
		expect(screen.getByText(/stops working, it shows here/)).toBeTruthy();
	});
});
