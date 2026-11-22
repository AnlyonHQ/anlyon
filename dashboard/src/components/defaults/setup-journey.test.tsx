/* @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDefaults } from "@/lib/types";

const state = vi.hoisted(() => ({
	defaults: null as unknown as WorkspaceDefaults,
	canEdit: true,
	mutate: vi.fn(),
	toast: vi.fn(),
	saveOptions: undefined as unknown,
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock("@/components/ui/toast", () => ({
	toast: { success: state.toast, error: vi.fn() },
}));
vi.mock("./use-defaults-sources", () => ({
	useDefaultsSources: () => ({
		defaults: state.defaults,
		preferences: {
			emailEnabled: true,
			slackEnabled: false,
			emailRecipients: ["ops@acme.dev"],
			enabledTypes: ["approval_requested"],
		},
		environment: {
			id: "env_1",
			name: "Production",
			isDefault: true,
			defaultRedirectUrl: null,
			allowedRedirectUrls: [],
		},
		slack: undefined,
		canEdit: state.canEdit,
		roleKnown: true,
		asksRedirect: true,
		isLoading: false,
		isError: false,
		refetch: vi.fn(),
	}),
}));
vi.mock("@/hooks/api/use-workspace-defaults", () => ({
	useSaveWorkspaceDefaults: (_workspaceId: string, options: unknown) => {
		state.saveOptions = options;
		return { mutate: state.mutate, isPending: false };
	},
}));

import { SetupJourney } from "./setup-journey";

const unanswered = (): WorkspaceDefaults => ({
	actingFor: null,
	endUserDecider: null,
	approvalWindowHours: null,
	effective: { endUserDecider: "team", approvalWindowHours: 24 },
	recommended: {
		actingFor: "both",
		endUserDecider: "team",
		approvalWindowHours: 24,
	},
	setup: { status: null, at: null },
	updatedAt: null,
});

const radio = (name: RegExp) => screen.getByRole("radio", { name });
const checked = (name: RegExp) =>
	radio(name).getAttribute("aria-checked") === "true";
const next = () =>
	fireEvent.click(screen.getByRole("button", { name: /^Continue/ }));

function renderJourney() {
	const onDone = vi.fn();
	render(
		<SetupJourney onDone={onDone} workspaceId="ws_1" workspaceName="Acme" />,
	);
	return onDone;
}

describe("setup journey", () => {
	beforeEach(() => {
		state.defaults = unanswered();
		state.canEdit = true;
		state.mutate.mockReset();
		state.mutate.mockImplementation((_input, options) =>
			options?.onSuccess?.(),
		);
		state.toast.mockReset();
	});
	afterEach(cleanup);

	it("starts every question on its recommended answer", () => {
		renderJourney();
		expect(checked(/^Both/)).toBe(true);
		expect(screen.getByText("Recommended")).toBeTruthy();
		next();
		expect(screen.getByRole("heading", { name: "Who decides" })).toBeTruthy();
		expect(checked(/^Your team decides/)).toBe(true);
		expect(
			screen
				.getByRole("radio", { name: "24 hours" })
				.getAttribute("aria-checked"),
		).toBe("true");
		next();
		expect(checked(/^Tell your team.*check the provider/)).toBe(true);
		expect(checked(/^Cancel and tell your team/)).toBe(true);
		expect(screen.getByText("Always on")).toBeTruthy();
	});

	it("recommends the team decides, whoever the agent acts for", () => {
		renderJourney();
		fireEvent.click(radio(/^Me and my team/));
		next();
		expect(
			screen.queryByRole("radio", { name: /^The user decides/ }),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /Back/ }));
		fireEvent.click(radio(/^My users/));
		next();
		expect(checked(/^Your team decides/)).toBe(true);
		expect(radio(/^Your team decides/).closest("label")?.textContent).toContain(
			"Recommended",
		);
	});

	it("says a user deciding needs an approval screen in your app", () => {
		renderJourney();
		next();
		const row = radio(/^The user decides/).closest("label") as HTMLElement;
		expect(row.textContent).toContain(
			"Their requests appear only in your app, so your app needs an approval screen.",
		);
		expect(
			within(row)
				.getByRole("link", { name: "How to add one" })
				.getAttribute("href"),
		).toBe(
			"https://docs.anlyon.com/guides/act-for-your-users#8-approve-in-your-own-ui",
		);
	});

	it("keeps answers going back and forward", () => {
		renderJourney();
		fireEvent.click(radio(/^My users/));
		next();
		fireEvent.click(radio(/^The user decides/));
		fireEvent.click(screen.getByRole("button", { name: /Back/ }));
		expect(checked(/^My users/)).toBe(true);
		next();
		expect(checked(/^The user decides/)).toBe(true);
	});

	it("saves every recommendation and finishes with Use recommended", () => {
		const onDone = renderJourney();
		fireEvent.click(radio(/^Me and my team/));
		fireEvent.click(screen.getByRole("button", { name: "Use recommended" }));
		expect(state.saveOptions).toMatchObject({ source: "setup_journey" });
		expect(state.mutate).toHaveBeenCalledTimes(1);
		const [input] = state.mutate.mock.calls[0];
		expect(input.defaults).toEqual({
			actingFor: "both",
			setupStatus: "completed",
		});
		expect(input.preferences.enabledTypes).toEqual(
			expect.arrayContaining([
				"outcome_unknown",
				"connection_broken",
				"approval_expired",
			]),
		);
		expect(onDone).toHaveBeenCalled();
		expect(state.toast).toHaveBeenCalled();
	});

	it("saves the answers given when the last screen is finished", () => {
		const onDone = renderJourney();
		fireEvent.click(radio(/^Me and my team/));
		next();
		fireEvent.click(screen.getByRole("radio", { name: "4 hours" }));
		next();
		fireEvent.click(radio(/^Leave it in Receipts/));
		fireEvent.click(screen.getByRole("button", { name: /^Save and finish/ }));
		const [input] = state.mutate.mock.calls[0];
		expect(input.defaults).toEqual({
			actingFor: "team",
			approvalWindowHours: 4,
			setupStatus: "completed",
		});
		expect(input.preferences.enabledTypes).not.toContain("outcome_unknown");
		expect(onDone).toHaveBeenCalled();
	});

	it("continues on Enter and does nothing on Escape", () => {
		renderJourney();
		const both = radio(/^Both/);
		fireEvent.keyDown(both, { key: "Escape" });
		expect(screen.getByRole("heading", { name: "Who it's for" })).toBeTruthy();
		fireEvent.keyDown(both, { key: "Enter" });
		expect(screen.getByRole("heading", { name: "Who decides" })).toBeTruthy();
		expect(state.mutate).not.toHaveBeenCalled();
	});

	it("moves between options with the arrow keys", async () => {
		renderJourney();
		const both = radio(/^Both/);
		both.focus();
		fireEvent.keyDown(both, { key: "ArrowUp" });
		await waitFor(() => expect(checked(/^My users/)).toBe(true));
	});

	it("holds on a redirect URL that is not valid", () => {
		renderJourney();
		fireEvent.change(
			screen.getByRole("textbox", {
				name: "Where do users land after connecting an account?",
			}),
			{ target: { value: "not a url" } },
		);
		next();
		expect(screen.getByRole("alert")).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Who it's for" })).toBeTruthy();
	});

	it("tells a member an admin sets the defaults", () => {
		state.canEdit = false;
		renderJourney();
		expect(
			screen.getByRole("heading", {
				name: "An admin sets this workspace's defaults",
			}),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Use recommended" }),
		).toBeNull();
	});
});
