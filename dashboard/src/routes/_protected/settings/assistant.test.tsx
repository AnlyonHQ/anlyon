/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantSettings } from "@/lib/types";
import { AssistantSettingsPage } from "./assistant";

const mutate = vi.hoisted(() => vi.fn());
const blocker = vi.hoisted(() => ({
	status: "idle" as "idle" | "blocked",
	reset: vi.fn(),
	proceed: vi.fn(),
	lastDisabled: true as boolean | undefined,
}));

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => true,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useBlocker: (opts: { disabled?: boolean }) => {
		blocker.lastDisabled = opts.disabled;
		return blocker;
	},
}));
const settings = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "ws_1" } }),
}));
vi.mock("@/hooks/api/use-actions", () => ({
	useActions: () => ({
		data: [{ name: "refund_order" }, { name: "send_receipt" }],
	}),
}));
const recent = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/hooks/api/use-approvals", () => ({
	useApprovals: () => ({ data: { data: recent.rows }, isLoading: false }),
}));
vi.mock("@/hooks/api/use-assistant", () => ({
	useAssistantSettings: () => ({
		data: settings.current,
		isLoading: false,
		error: null,
	}),
	useUpdateAssistantSettings: () => ({ mutate, isPending: false }),
}));

afterEach(() => {
	cleanup();
	mutate.mockReset();
	recent.rows = [];
	blocker.status = "idle";
	blocker.reset.mockReset();
	blocker.proceed.mockReset();
});

const base: AssistantSettings = {
	available: true,
	enabled: false,
	consentVersion: null,
	currentConsentVersion: "2026-09-24",
	consentedAt: null,
	excludedFields: [],
	autoApprove: {
		enabled: false,
		actions: [],
		minConfidence: 0.9,
		maxRisk: 1,
		minHistory: 20,
	},
	auditSampleRate: 0.1,
	model: "vigil-1",
	usage: {
		reviews: { used: 12, cap: 1000, period: "2026-09" },
		autoApprovals: { used: 0, cap: 100, period: "2026-09-24" },
	},
};

describe("Anlyon Vigil settings", () => {
	it("does not turn on until the admin agrees in the consent dialog", async () => {
		settings.current = base;
		render(<AssistantSettingsPage />);
		fireEvent.click(
			screen.getByRole("switch", { name: /Vigil suggestions for approvals/i }),
		);
		expect(mutate).not.toHaveBeenCalled();

		expect(await screen.findByText(/upstream AI provider/)).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: /I agree, turn it on/i }),
		);
		expect(mutate).toHaveBeenCalledWith({
			enabled: true,
			consentVersion: "2026-09-24",
		});
	});

	it("cancelling the consent dialog changes nothing", async () => {
		settings.current = base;
		render(<AssistantSettingsPage />);
		fireEvent.click(
			screen.getByRole("switch", { name: /Vigil suggestions for approvals/i }),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		expect(mutate).not.toHaveBeenCalled();
	});

	it("shows plan usage against its hard caps, and hides auto-approve until opted in", () => {
		settings.current = base;
		render(<AssistantSettingsPage />);
		expect(screen.getByText("/ 1,000 reviews")).toBeTruthy();
		expect(screen.getByText("988 left")).toBeTruthy();
		expect(screen.getByText("/ 100 approvals")).toBeTruthy();
		expect(screen.queryByText("Auto-approve")).toBeNull();
	});

	it("auto-approve needs a second confirmation", async () => {
		settings.current = {
			...base,
			enabled: true,
			consentVersion: "2026-09-24",
			consentedAt: "2026-09-24T00:00:00Z",
		};
		render(<AssistantSettingsPage />);
		fireEvent.click(screen.getByRole("button", { name: "refund_order" }));
		fireEvent.click(
			screen.getByRole("switch", { name: /Approve inside these limits/i }),
		);
		expect(mutate).not.toHaveBeenCalled();
		fireEvent.click(
			await screen.findByRole("button", { name: /Turn on auto-approve/i }),
		);
		expect(mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				autoApprove: expect.objectContaining({
					enabled: true,
					actions: ["refund_order"],
				}),
			}),
		);
	});

	it("says so when the deployment has no assistant", () => {
		settings.current = { ...base, available: false };
		render(<AssistantSettingsPage />);
		expect(screen.getByText(/not available on this deployment/)).toBeTruthy();
	});

	it("edits excluded fields as chips and saves the list", () => {
		settings.current = { ...base, excludedFields: ["customer.email"] };
		render(<AssistantSettingsPage />);
		fireEvent.change(screen.getByLabelText("Field to exclude"), {
			target: { value: "shipping.address" },
		});
		fireEvent.click(screen.getByRole("button", { name: /Exclude/ }));
		fireEvent.click(
			screen.getByRole("button", { name: "Stop excluding customer.email" }),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Save excluded fields" }),
		);
		expect(mutate).toHaveBeenCalledWith({
			excludedFields: ["shipping.address"],
		});
	});

	it("replays the limits on recent requests and calls out any an approver denied", () => {
		const reviewed = (status: string) => ({
			id: `apr_${status}_${Math.random()}`,
			kind: "action",
			status,
			title: `refund (${status})`,
			payload: { actionName: "refund_order", input: { amount: 10 } },
			requiredApprovals: 1,
			decisionOrigin: "human",
			advice: {
				status: "ready",
				recommendation: "approve",
				risk: 0.4,
				confidence: 0.95,
				reasons: [],
				flags: {
					injectionSuspected: 0.01,
					consistentWithHistory: 0.9,
					amountUnusual: 0,
				},
				history: { approved: 40, denied: 0, maxAmount: 50, medianAmount: 20 },
			},
		});
		recent.rows = [
			reviewed("approved"),
			reviewed("approved"),
			reviewed("denied"),
		];
		settings.current = {
			...base,
			enabled: true,
			consentVersion: "2026-09-24",
			consentedAt: "2026-09-24T00:00:00Z",
			autoApprove: { ...base.autoApprove, actions: ["refund_order"] },
		};
		render(<AssistantSettingsPage />);
		const panel = screen.getByRole("complementary", {
			name: "What these limits would have done",
		});
		expect(panel.textContent).toContain("Would approve3");
		expect(panel.textContent).toContain(
			"Would have approved 1 request an approver denied",
		);
		fireEvent.click(screen.getByRole("button", { name: "refund_order" }));
		expect(panel.textContent).toContain("Would approve0");
	});
	it("guards navigation while a section has unsaved edits", () => {
		settings.current = { ...base, excludedFields: ["customer.email"] };
		render(<AssistantSettingsPage />);
		expect(blocker.lastDisabled).toBe(true);
		fireEvent.change(screen.getByLabelText("Field to exclude"), {
			target: { value: "shipping.address" },
		});
		expect(blocker.lastDisabled).toBe(false);
	});

	it("asks before leaving with unsaved edits", () => {
		settings.current = base;
		blocker.status = "blocked";
		render(<AssistantSettingsPage />);
		expect(screen.getByText("Leave without saving?")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Leave without saving" }),
		);
		expect(blocker.proceed).toHaveBeenCalled();
	});

	it("chooses the risk ceiling from a keyboard-operable radio group", () => {
		settings.current = {
			...base,
			enabled: true,
			consentVersion: "2026-09-24",
			consentedAt: "2026-09-24T00:00:00Z",
		};
		render(<AssistantSettingsPage />);
		const group = screen.getAllByRole("radiogroup")[0];
		const radios = Array.from(group.querySelectorAll('[role="radio"]'));
		const checked = radios.find(
			(r) => r.getAttribute("aria-checked") === "true",
		);
		expect(checked?.getAttribute("tabindex")).toBe("0");
		expect(
			radios.filter((r) => r.getAttribute("tabindex") === "0"),
		).toHaveLength(1);
		fireEvent.keyDown(checked as Element, { key: "ArrowRight" });
		const next = radios[radios.indexOf(checked as Element) + 1];
		expect(next.getAttribute("aria-checked")).toBe("true");
		expect(document.activeElement).toBe(next);
	});
});
