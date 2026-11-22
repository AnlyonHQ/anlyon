/* @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationsSettingsPage } from "./notifications";

const state = vi.hoisted(() => ({
	role: "member" as "member" | "admin" | undefined,
	muted: ["quota_warning"] as string[],
	updateWorkspace: vi.fn(),
	updateMine: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "ws_1" } }),
}));
vi.mock("@/hooks/use-auth", () => ({
	useAuth: () => ({ user: { id: "user_1" } }),
}));
vi.mock("@/hooks/api/use-permissions", () => ({
	useWorkspacePermissions: () => ({
		data:
			state.role === undefined
				? undefined
				: {
						role: state.role,
						permissions:
							state.role === "member"
								? ["workspace.read"]
								: ["workspace.read", "notifications.manage"],
						environmentRolesEnabled: false,
						environments: [],
					},
	}),
}));
vi.mock("@/hooks/api/use-notifications", () => ({
	useNotificationPreferences: () => ({
		isLoading: false,
		data: {
			inAppEnabled: true,
			emailEnabled: true,
			slackEnabled: false,
			discordEnabled: false,
			webhookEnabled: true,
			emailRecipients: ["oncall@example.com"],
			webhookUrl: "https://hooks.example.com/alerts",
			quotaAlertThresholds: [50, 75, 90, 100],
			enabledTypes: ["approval_requested", "security_alert"],
		},
	}),
	useUpdateNotificationPreferences: () => ({
		mutate: state.updateWorkspace,
		isPending: false,
	}),
	useMyNotificationPreferences: () => ({
		isLoading: false,
		isError: false,
		data: { mutedTypes: state.muted, updatedAt: null },
	}),
	useUpdateMyNotificationPreferences: () => ({
		mutate: state.updateMine,
		isPending: false,
	}),
}));

afterEach(() => {
	cleanup();
	state.role = "member";
	state.muted = ["quota_warning"];
	state.updateWorkspace.mockReset();
	state.updateMine.mockReset();
});

const WORKSPACE_SWITCHES = [
	"In-app",
	"Email",
	"Slack",
	"Discord",
	"Webhook",
	"Alert the workspace on Approval requests",
	"Alert the workspace on Security alerts",
	"Alert the workspace on Quota warnings",
];

describe("notification settings for a member", () => {
	it("says an admin changes the workspace routing", () => {
		render(<NotificationsSettingsPage />);
		expect(
			within(screen.getByTestId("workspace-alert-routing")).getByText(
				/An admin changes these\./,
			),
		).toBeTruthy();
	});

	it("renders no enabled control that changes workspace routing", () => {
		render(<NotificationsSettingsPage />);
		for (const name of WORKSPACE_SWITCHES) {
			const control = screen.getByRole("switch", { name });
			expect(control.hasAttribute("data-disabled"), name).toBe(true);
			fireEvent.click(control);
		}
		expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
		expect(screen.queryByLabelText("Add email recipient")).toBeNull();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(
			(screen.getByLabelText("Webhook URL") as HTMLInputElement).readOnly,
		).toBe(true);
		expect(state.updateWorkspace).not.toHaveBeenCalled();
	});

	it("still shows the member what the workspace routing is", () => {
		render(<NotificationsSettingsPage />);
		expect(screen.getByText("oncall@example.com")).toBeTruthy();
		expect(
			(screen.getByLabelText("Webhook URL") as HTMLInputElement).value,
		).toBe("https://hooks.example.com/alerts");
		expect(
			screen
				.getByRole("switch", { name: "Email" })
				.getAttribute("aria-checked"),
		).toBe("true");
	});

	it("lets the member change their own muted types", () => {
		render(<NotificationsSettingsPage />);
		const muted = screen.getByRole("switch", {
			name: "Show Quota warnings in my notifications",
		});
		expect(muted.getAttribute("aria-checked")).toBe("false");
		expect(muted.hasAttribute("data-disabled")).toBe(false);

		fireEvent.click(
			screen.getByRole("switch", {
				name: "Show Security alerts in my notifications",
			}),
		);
		expect(state.updateMine).toHaveBeenCalledWith({
			workspaceId: "ws_1",
			mutedTypes: ["quota_warning", "security_alert"],
		});

		fireEvent.click(muted);
		expect(state.updateMine).toHaveBeenLastCalledWith({
			workspaceId: "ws_1",
			mutedTypes: [],
		});
		expect(state.updateWorkspace).not.toHaveBeenCalled();
	});
});

describe("notification settings before the role is known", () => {
	it("keeps workspace routing read-only and does not claim the viewer is a member", () => {
		state.role = undefined;
		render(<NotificationsSettingsPage />);
		for (const name of WORKSPACE_SWITCHES) {
			expect(
				screen.getByRole("switch", { name }).hasAttribute("data-disabled"),
				name,
			).toBe(true);
		}
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(screen.queryByText(/An admin changes these\./)).toBeNull();
	});
});

describe.each(["admin"] as const)("notification settings for an %s", (role) => {
	it("renders workspace routing as editable, with no admin notice", () => {
		state.role = role;
		render(<NotificationsSettingsPage />);
		expect(screen.queryByText(/An admin changes these\./)).toBeNull();
		for (const name of WORKSPACE_SWITCHES) {
			expect(
				screen.getByRole("switch", { name }).hasAttribute("data-disabled"),
				name,
			).toBe(false);
		}
		expect(
			screen.getByRole("button", { name: "Remove oncall@example.com" }),
		).toBeTruthy();
		expect(screen.getByLabelText("Add email recipient")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
		expect(
			(screen.getByLabelText("Webhook URL") as HTMLInputElement).readOnly,
		).toBe(false);
	});

	it("saves a workspace change and the admin's own muted types separately", () => {
		state.role = role;
		render(<NotificationsSettingsPage />);
		fireEvent.click(screen.getByRole("switch", { name: "Slack" }));
		expect(state.updateWorkspace).toHaveBeenCalledWith({
			workspaceId: "ws_1",
			preferences: { slackEnabled: true },
		});
		fireEvent.click(
			screen.getByRole("switch", {
				name: "Show Quota warnings in my notifications",
			}),
		);
		expect(state.updateMine).toHaveBeenCalledWith({
			workspaceId: "ws_1",
			mutedTypes: [],
		});
	});
});
