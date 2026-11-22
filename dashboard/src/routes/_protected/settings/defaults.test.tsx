/* @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDefaults } from "@/lib/types";

const state = vi.hoisted(() => ({
	defaults: null as unknown as WorkspaceDefaults,
	canEdit: true,
	mutate: vi.fn(),
	saveOptions: undefined as unknown,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "ws_1" } }),
}));
vi.mock("@/components/defaults/use-defaults-sources", () => ({
	useDefaultsSources: () => ({
		defaults: state.defaults,
		preferences: {
			emailEnabled: true,
			slackEnabled: false,
			emailRecipients: ["ops@acme.dev"],
			enabledTypes: ["approval_requested", "outcome_unknown"],
			updatedAt: "2026-10-01T00:00:00.000Z",
		},
		environment: {
			id: "env_1",
			name: "Production",
			isDefault: true,
			defaultRedirectUrl: "https://app.acme.dev/connected",
			allowedRedirectUrls: ["https://app.acme.dev/connected"],
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

import { DefaultsSettingsPage } from "./defaults";

const answered = (): WorkspaceDefaults => ({
	actingFor: "users",
	endUserDecider: "end_user",
	approvalWindowHours: 4,
	effective: { endUserDecider: "end_user", approvalWindowHours: 4 },
	recommended: {
		actingFor: "both",
		endUserDecider: "team",
		approvalWindowHours: 24,
	},
	setup: { status: "completed", at: "2026-10-01T00:00:00.000Z" },
	updatedAt: "2026-10-01T00:00:00.000Z",
});

const section = (name: string) =>
	screen.getByRole("region", { name }) as HTMLElement;
const checked = (scope: HTMLElement, name: RegExp) =>
	within(scope).getByRole("radio", { name }).getAttribute("aria-checked") ===
	"true";

describe("Settings, Defaults", () => {
	beforeEach(() => {
		state.defaults = answered();
		state.canEdit = true;
		state.mutate.mockReset();
	});
	afterEach(cleanup);

	it("shows each current answer, with the recommended one marked", () => {
		render(<DefaultsSettingsPage />);
		const who = section("Who your agent acts for");
		expect(checked(who, /^My users/)).toBe(true);
		expect(
			within(who).getByRole("radio", { name: /^Both/ }).closest("label")
				?.textContent,
		).toContain("Recommended");
		expect((within(who).getByRole("textbox") as HTMLInputElement).value).toBe(
			"https://app.acme.dev/connected",
		);

		const decide = section("Who decides");
		expect(checked(decide, /^The user decides/)).toBe(true);
		expect(
			within(decide)
				.getByRole("radio", { name: /^Your team decides/ })
				.closest("label")?.textContent,
		).toContain("Recommended");
		expect(checked(decide, /^4 hours/)).toBe(true);

		const wrong = section("When something goes wrong");
		expect(checked(wrong, /^Tell your team.*check the provider/)).toBe(true);
		expect(checked(wrong, /^Cancel quietly/)).toBe(true);
		expect(
			within(wrong).queryByText(/one of your connected accounts/),
		).toBeNull();
	});

	it("saves one section at a time", () => {
		render(<DefaultsSettingsPage />);
		const decide = section("Who decides");
		const save = within(decide).getByRole("button", { name: "Save" });
		expect(save.hasAttribute("disabled")).toBe(true);

		fireEvent.click(
			within(decide).getByRole("radio", { name: /^Your team decides/ }),
		);
		fireEvent.click(within(decide).getByRole("radio", { name: "24 hours" }));
		fireEvent.click(
			within(section("When something goes wrong")).getByRole("radio", {
				name: /^Cancel and tell your team/,
			}),
		);
		fireEvent.click(save);
		expect(state.saveOptions).toMatchObject({ source: "defaults_page" });
		expect(state.mutate).toHaveBeenCalledTimes(1);
		expect(state.mutate.mock.calls[0][0]).toEqual({
			defaults: { endUserDecider: null, approvalWindowHours: null },
		});
	});

	it("saves the alerts for when something goes wrong", () => {
		render(<DefaultsSettingsPage />);
		const wrong = section("When something goes wrong");
		fireEvent.click(
			within(wrong).getByRole("radio", { name: /^Cancel and tell your team/ }),
		);
		fireEvent.click(within(wrong).getByRole("button", { name: "Save" }));
		expect(state.mutate.mock.calls[0][0].preferences.enabledTypes).toEqual(
			expect.arrayContaining([
				"approval_requested",
				"outcome_unknown",
				"approval_expired",
			]),
		);
	});

	it("is read-only for a member", () => {
		state.canEdit = false;
		render(<DefaultsSettingsPage />);
		expect(screen.getByText(/An admin changes these/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		for (const radio of screen
			.getAllByRole("radio")
			.filter((element) => element.getAttribute("data-slot") === "radio"))
			expect(radio.hasAttribute("data-disabled")).toBe(true);
	});
});
