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
import { ApiError } from "@/lib/api-client";
import type { AuditSink } from "@/lib/audit";
import { registerExtension, resetExtensions } from "@/lib/extensions";
import { AuditSettingsPage } from "./audit";

const sink: AuditSink = {
	sinkId: "asink_1",
	name: "Security SIEM",
	type: "webhook",
	config: { url: "https://siem.example.com/audit" },
	credentialsHint: "whsec_abcdef…",
	enabled: true,
	eventTypes: ["*"],
	environmentIds: null,
	includeHistory: true,
	status: "retrying",
	attempts: 2,
	nextAttemptAt: "2026-10-19T12:00:00.000Z",
	lastError: "HTTP 503",
	lastAttemptAt: "2026-10-19T11:59:00.000Z",
	lastSuccessAt: null,
	deliveredCount: 1200,
	openDeadLetters: 1,
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
};

const state = vi.hoisted(() => ({
	role: "admin" as string,
	settingsError: null as Error | null,
	privateAvailable: false,
	saveSettings: vi.fn(),
	test: vi.fn(),
	update: vi.fn(),
	create: vi.fn(),
	teamPlanRequired: false,
}));

vi.mock("@/hooks/use-plan-access", () => ({
	usePlanAccess: () => ({ teamPlanRequired: state.teamPlanRequired }),
}));
vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => true,
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
vi.mock("@/hooks/api/use-workspaces", () => ({
	useWorkspaceMembers: () => ({
		data: [{ userId: "user_1", role: state.role }],
	}),
}));
vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({ data: [{ id: "env_1", name: "production" }] }),
}));
vi.mock("@/hooks/api/use-audit", () => {
	const mutation = (mutate = vi.fn()) => ({
		mutate,
		isPending: false,
		error: null,
	});
	return {
		useAuditSettings: (workspaceId?: string) =>
			workspaceId
				? {
						isLoading: false,
						error: state.settingsError,
						data: {
							retentionDays: null,
							allowPrivateDestinations: false,
							privateDestinationsAvailable: state.privateAvailable,
							minRetentionDays: 30,
							maxRetentionDays: 3650,
							schema: "anlyon.audit.v1",
							updatedAt: null,
						},
					}
				: { isLoading: false, error: null, data: undefined },
		useUpdateAuditSettings: () => mutation(state.saveSettings),
		useAuditSinks: () => ({ isLoading: false, data: [sink] }),
		useCreateAuditSink: () => ({ ...mutation(state.create), reset: vi.fn() }),
		useUpdateAuditSink: () => mutation(state.update),
		useDeleteAuditSink: () => mutation(),
		useTestAuditSink: () => mutation(state.test),
		useAuditDeadLetters: () => ({ isLoading: false, data: [] }),
		useRedeliverDeadLetter: () => mutation(),
		useRecentAuditEvents: () => ({
			isLoading: false,
			data: {
				data: [
					{
						id: "aud_1",
						type: "approval.vote",
						actor: { type: "user", id: "user_9" },
						outcome: "approve",
						occurredAt: "2026-10-19T10:00:00.000Z",
					},
				],
			},
		}),
	};
});

afterEach(() => {
	cleanup();
	resetExtensions();
	state.role = "admin";
	state.settingsError = null;
	state.privateAvailable = false;
	state.saveSettings.mockReset();
	state.test.mockReset();
	state.update.mockReset();
	state.create.mockReset();
	state.teamPlanRequired = false;
});

function pick(item: string) {
	fireEvent.click(
		screen.getByRole("button", { name: "Actions for Security SIEM" }),
	);
	fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

describe("AuditSettingsPage", () => {
	it("on a plan without Team, keeps existing sinks listed and working, and offers Team instead of Add sink", () => {
		state.teamPlanRequired = true;
		registerExtension({
			id: "fixture",
			PlanAction: ({ site }) =>
				site === "team-notice-inline" ? (
					<button type="button">Choose Team</button>
				) : null,
		});
		render(<AuditSettingsPage />);
		expect(
			screen.getByText("Audit streaming needs the Team plan"),
		).toBeTruthy();
		expect(screen.getByText(/Your current setup keeps working/)).toBeTruthy();
		expect(screen.getByText("Security SIEM")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Add sink" })).toBeNull();
		expect(screen.getByText("Choose Team")).toBeTruthy();
		pick("Delete");
		expect(screen.getByText("Delete Security SIEM?")).toBeTruthy();
	});

	it("shows no plan notice on Team, during the beta or self-hosted", () => {
		render(<AuditSettingsPage />);
		expect(screen.queryByTestId("team-plan-notice")).toBeNull();
		expect(screen.getByRole("button", { name: "Add sink" })).toBeTruthy();
	});

	it("shows an admin each sink as a row: health, host, human values, no secret hint", () => {
		render(<AuditSettingsPage />);
		expect(screen.getByText("Security SIEM")).toBeTruthy();
		expect(screen.getByText("Failing")).toBeTruthy();
		expect(screen.getByText("siem.example.com")).toBeTruthy();
		expect(screen.getByText("All records")).toBeTruthy();
		const row = screen.getByText("Security SIEM").closest("li") as HTMLElement;
		expect(within(row).getByText("All environments")).toBeTruthy();
		expect(screen.getByText("1 dead letter")).toBeTruthy();
		expect(screen.getByText(/Attempt 2 failed: HTTP 503/)).toBeTruthy();
		expect(screen.queryByText(/whsec_/)).toBeNull();
		expect(screen.queryByText("*")).toBeNull();
		expect(screen.getByText("Approval vote")).toBeTruthy();
		expect(screen.queryByText("approval.vote")).toBeNull();
	});

	it("sends a test event from the sink's menu", () => {
		render(<AuditSettingsPage />);
		pick("Send test event");
		expect(state.test).toHaveBeenCalledWith("asink_1");
	});

	it("pauses a sink from its menu", () => {
		render(<AuditSettingsPage />);
		pick("Pause");
		expect(state.update).toHaveBeenCalledWith(
			{ sinkId: "asink_1", patch: { enabled: false } },
			expect.anything(),
		);
	});

	it("rotates a webhook's signing secret only after a confirm that names the sink", () => {
		render(<AuditSettingsPage />);
		pick("Rotate signing secret");
		expect(state.update).not.toHaveBeenCalled();
		expect(
			screen.getByText("Rotate the signing secret of Security SIEM?"),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
		expect(state.update).toHaveBeenCalledWith(
			{ sinkId: "asink_1", patch: { rotateSigningSecret: true } },
			expect.anything(),
		);
	});

	it("deletes only after a confirm that names the sink", () => {
		render(<AuditSettingsPage />);
		pick("Delete");
		expect(screen.getByText("Delete Security SIEM?")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Delete Security SIEM" }),
		).toBeTruthy();
	});

	it("adds a sink for picked record categories, from a form that submits", () => {
		render(<AuditSettingsPage />);
		fireEvent.click(screen.getByRole("button", { name: "Add sink" }));
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Approvals only" },
		});
		fireEvent.change(screen.getByLabelText("URL"), {
			target: { value: "https://siem.example.com/hook" },
		});
		fireEvent.click(screen.getByRole("radio", { name: "Some categories" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Approvals" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Policies" }));
		const form = screen.getByRole("dialog").querySelector("form");
		fireEvent.submit(form as HTMLFormElement);
		expect(state.create).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Approvals only",
				type: "webhook",
				eventTypes: ["approval.*", "policy.*"],
				config: { url: "https://siem.example.com/hook" },
			}),
			expect.anything(),
		);
	});

	it("keeps an advanced free-text option for event types", () => {
		render(<AuditSettingsPage />);
		fireEvent.click(screen.getByRole("button", { name: "Add sink" }));
		fireEvent.click(
			screen.getByRole("radio", { name: "Event types (advanced)" }),
		);
		fireEvent.change(screen.getByLabelText("Event types"), {
			target: { value: "policy.updated, approval.*" },
		});
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Custom" },
		});
		fireEvent.submit(
			screen.getByRole("dialog").querySelector("form") as HTMLFormElement,
		);
		expect(state.create).toHaveBeenCalledWith(
			expect.objectContaining({ eventTypes: ["policy.updated", "approval.*"] }),
			expect.anything(),
		);
	});

	it("offers a member nothing to press", () => {
		state.role = "member";
		render(<AuditSettingsPage />);
		expect(
			screen.getByText("Only a workspace admin can manage audit streaming."),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Add sink/ })).toBeNull();
	});

	it("explains an edition without audit streaming instead of showing an error", () => {
		state.settingsError = new ApiError("Endpoint not found", 404);
		render(<AuditSettingsPage />);
		expect(screen.getByText("Not included in this edition")).toBeTruthy();
		expect(screen.queryByText("Security SIEM")).toBeNull();
	});

	it("hides the private network setting on cloud", () => {
		registerExtension({ id: "hosted", edition: "cloud" });
		render(<AuditSettingsPage />);
		expect(screen.queryByText("Private network destinations")).toBeNull();
		expect(screen.getByText("Includes records from history")).toBeTruthy();
	});

	it("says why on a self-hosted install whose instance admins turned private destinations off", () => {
		render(<AuditSettingsPage />);
		expect(
			screen.getAllByText("Private network destinations").length,
		).toBeGreaterThan(0);
		expect(
			screen.getByText(
				/An instance admin has turned off private network destinations/,
			),
		).toBeTruthy();
		expect(
			screen.queryByRole("switch", {
				name: "Allow private network destinations",
			}),
		).toBeNull();
	});

	it("offers the private network setting off cloud and saves it", () => {
		state.privateAvailable = true;
		render(<AuditSettingsPage />);
		fireEvent.click(
			screen.getByRole("switch", {
				name: "Allow private network destinations",
			}),
		);
		expect(state.saveSettings).toHaveBeenCalledWith(
			{ allowPrivateDestinations: true },
			expect.anything(),
		);
	});
});
