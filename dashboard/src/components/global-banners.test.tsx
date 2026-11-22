/* @vitest-environment jsdom */

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	pathname: "/analytics",
	environments: [] as unknown[],
	twoFactorEnabled: false,
	license: null as unknown,
	role: "admin" as string,
	billing: { paidPlansAvailable: false } as Record<string, unknown>,
	usage: undefined as unknown,
	feedback: null as unknown,
	canSetDefaults: false,
	setupStatus: "completed" as string | null,
	saveDefaults: vi.fn(),
	saveOptions: undefined as unknown,
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => (
		<a href="/">{children}</a>
	),
	useRouterState: ({
		select,
	}: {
		select: (s: { location: { pathname: string } }) => unknown;
	}) => select({ location: { pathname: mocks.pathname } }),
}));
vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "ws_1" } }),
}));
vi.mock("@/hooks/use-auth", () => ({
	useAuth: () => ({ user: { twoFactorEnabled: mocks.twoFactorEnabled } }),
}));
vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({ data: mocks.environments }),
}));
vi.mock("@/hooks/api/use-permissions", () => ({
	useWorkspacePermissions: () => ({
		data: {
			role: mocks.role,
			permissions:
				mocks.role === "admin"
					? [
							"billing.manage",
							...(mocks.canSetDefaults ? ["workspace.update"] : []),
						]
					: [],
		},
	}),
}));
vi.mock("@/hooks/api/use-plan", () => ({
	useQuotaStatus: () => ({ data: undefined }),
	useCurrentUsage: () => ({ data: mocks.usage }),
}));
vi.mock("@/hooks/api/use-workspace-defaults", () => ({
	useWorkspaceDefaults: () => ({
		data: { setup: { status: mocks.setupStatus, at: null } },
	}),
	useSaveWorkspaceDefaults: (_workspaceId: string, options: unknown) => {
		mocks.saveOptions = options;
		return { mutate: mocks.saveDefaults, isIdle: true };
	},
}));
vi.mock("@/hooks/api/use-edition", () => ({
	useEdition: () => ({ data: { edition: "team", license: mocks.license } }),
}));
vi.mock("@/hooks/use-plan-access", () => ({
	usePlanAccess: () => mocks.billing,
}));
vi.mock("@/lib/quota-feedback", () => ({
	useQuotaFeedback: () => mocks.feedback,
	clearQuotaFeedback: () => {},
}));

import { registerExtension, resetExtensions } from "@/lib/extensions";
import { GlobalBanners } from "./global-banners";

const beta = /Anlyon is in early beta/;
const gate = /The SDK approval gate/;
const twoFactor = /Protect your account/;

describe("global banners", () => {
	beforeEach(() => {
		localStorage.clear();
		mocks.pathname = "/analytics";
		mocks.environments = [];
		mocks.twoFactorEnabled = false;
		mocks.license = null;
		mocks.role = "admin";
		mocks.billing = { paidPlansAvailable: false };
		mocks.usage = undefined;
		mocks.feedback = null;
		mocks.canSetDefaults = false;
		mocks.setupStatus = "completed";
		mocks.saveDefaults.mockReset();
	});
	afterEach(() => {
		cleanup();
		resetExtensions();
	});

	const standard = (plan: Record<string, unknown>, over = {}) => ({
		paidPlansAvailable: true,
		noPlan: false,
		access: { betaAllowancesApply: false },
		plan: { plan: "production", status: "active", ...plan },
		...over,
	});

	it("alerts at 80% and at 100% of governed actions with no way to buy one, without an extension", () => {
		mocks.pathname = "/actions";
		mocks.billing = standard({ plan: "starter" });
		mocks.usage = {
			actionAllowance: {
				included: 50_000,
				credits: 0,
				graceCap: 55_000,
				used: 50_000,
			},
		};
		render(<GlobalBanners />);
		expect(
			screen.getByText(
				/have reached this month's allowance. A 10% buffer runs/,
			),
		).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("offers an extension's plan action where the rail leaves room for one", () => {
		registerExtension({
			id: "fixture",
			PlanAction: ({ site, canManageBilling }) =>
				site === "paid-usage-banner" && canManageBilling ? (
					<a href="/plans">More allowance</a>
				) : null,
		});
		mocks.pathname = "/actions";
		mocks.billing = standard({ plan: "starter" });
		mocks.usage = {
			actionAllowance: {
				included: 50_000,
				credits: 0,
				graceCap: 55_000,
				used: 41_000,
			},
		};
		render(<GlobalBanners />);
		expect(screen.getByText(/at 82% of this month's allowance/)).toBeTruthy();
		expect(screen.getByText("More allowance")).toBeTruthy();
	});

	it("points a refused request at usage when no extension sells more", () => {
		mocks.pathname = "/actions";
		mocks.feedback = {
			code: "QUOTA_EXCEEDED",
			message: "This workspace has used its monthly allowance.",
			workspaceId: "ws_1",
			period: new Date().toISOString().slice(0, 7),
		};
		render(<GlobalBanners />);
		expect(screen.getByText("Workspace allowance reached")).toBeTruthy();
		expect(screen.getByText("Review usage")).toBeTruthy();
	});

	it("shows an extension's banners in the rail, and keeps Home's announcements back while one is up", () => {
		const banner = { quiet: true };
		registerExtension({
			id: "fixture",
			useBanners: ({ onHome }) => ({
				quiet: banner.quiet,
				node: onHome ? <p>Fixture notice</p> : null,
			}),
		});
		const { rerender } = render(<GlobalBanners />);
		expect(screen.getByText("Fixture notice")).toBeTruthy();
		expect(screen.queryByText(beta)).toBeNull();
		banner.quiet = false;
		mocks.pathname = "/actions";
		rerender(<GlobalBanners />);
		mocks.pathname = "/analytics";
		rerender(<GlobalBanners />);
		expect(screen.getByText(beta)).toBeTruthy();
	});

	it("tells a viewer and an approver why controls are missing, until dismissed", () => {
		mocks.pathname = "/actions";
		const { rerender } = render(<GlobalBanners />);
		expect(screen.queryByText(/view-only access/)).toBeNull();

		mocks.role = "viewer";
		rerender(<GlobalBanners />);
		expect(screen.getByText(/view-only access/)).toBeTruthy();

		mocks.role = "approver";
		rerender(<GlobalBanners />);
		expect(screen.getByText(/decide approvals/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByText(/decide approvals/)).toBeNull();
	});

	it("shows announcements and the two-factor reminder on Home only", () => {
		mocks.pathname = "/actions";
		const { rerender } = render(<GlobalBanners />);
		expect(screen.queryByText(beta)).toBeNull();
		expect(screen.queryByText(twoFactor)).toBeNull();

		mocks.pathname = "/analytics";
		rerender(<GlobalBanners />);
		expect(screen.getByText(beta)).toBeTruthy();
		expect(screen.getByText(twoFactor)).toBeTruthy();
	});

	it("shows each announcement once, and keeps it for that visit to Home", () => {
		const { rerender } = render(<GlobalBanners />);
		expect(screen.getByText(beta)).toBeTruthy();
		rerender(<GlobalBanners />);
		expect(screen.getByText(beta)).toBeTruthy();

		mocks.pathname = "/actions";
		rerender(<GlobalBanners />);
		mocks.pathname = "/analytics";
		rerender(<GlobalBanners />);
		expect(screen.queryByText(beta)).toBeNull();
		expect(screen.getByText(gate)).toBeTruthy();

		mocks.pathname = "/actions";
		rerender(<GlobalBanners />);
		mocks.pathname = "/analytics";
		rerender(<GlobalBanners />);
		expect(screen.queryByText(beta)).toBeNull();
		expect(screen.queryByText(gate)).toBeNull();
	});

	it("closing an announcement hides it at once", () => {
		render(<GlobalBanners />);
		const close = screen.getAllByRole("button", { name: "Dismiss" }).at(-1);
		if (!close) throw new Error("no dismiss button");
		act(() => fireEvent.click(close));
		expect(screen.queryByText(beta)).toBeNull();
	});

	it("a halted environment shows on every page", () => {
		mocks.pathname = "/actions";
		mocks.environments = [
			{ id: "env_1", name: "Production", halted: true, haltedReason: null },
		];
		render(<GlobalBanners />);
		expect(screen.getByText(/is halted/)).toBeTruthy();
		expect(screen.queryByText(beta)).toBeNull();
	});

	it("tells an admin when the install uses more seats than licensed", () => {
		mocks.pathname = "/actions";
		mocks.license = {
			state: "valid",
			message: "Licensed to Example Corp.",
			tier: "team",
			org: "Example Corp",
			seats: 5,
			seatsUsed: 7,
			overSeats: true,
			features: ["sso"],
			expiresAt: "2099-01-01T00:00:00Z",
			graceEndsAt: "2099-01-15T00:00:00Z",
		};
		render(<GlobalBanners />);
		expect(screen.getByText(/7 people in its workspaces/)).toBeTruthy();
		expect(screen.getByText(/Nothing is blocked/)).toBeTruthy();
	});

	it("shows nothing about the licence when it is valid and within its seats", () => {
		mocks.license = {
			state: "valid",
			message: "ok",
			tier: "team",
			org: "Example Corp",
			seats: 5,
			seatsUsed: 5,
			overSeats: false,
			features: [],
			expiresAt: null,
			graceEndsAt: null,
		};
		render(<GlobalBanners />);
		expect(screen.queryByText(/licence covers/)).toBeNull();
	});

	it("asks an admin once to review defaults a workspace never set, on Home", () => {
		mocks.canSetDefaults = true;
		mocks.setupStatus = null;
		render(<GlobalBanners />);
		expect(screen.getByText(/Choose who decides/)).toBeTruthy();
		expect(screen.queryByText(beta)).toBeNull();
		const prompt = screen
			.getByText(/Choose who decides/)
			.closest("[role=status]") as HTMLElement;
		fireEvent.click(within(prompt).getByRole("button", { name: "Dismiss" }));
		expect(mocks.saveDefaults).toHaveBeenCalledWith({
			defaults: { setupStatus: "skipped" },
		});
		expect(mocks.saveOptions).toMatchObject({ source: "home_prompt" });
	});

	it("does not ask once setup is done, off Home, or someone who cannot set defaults", () => {
		mocks.canSetDefaults = true;
		render(<GlobalBanners />);
		expect(screen.queryByText(/Choose who decides/)).toBeNull();
		cleanup();
		mocks.setupStatus = null;
		mocks.pathname = "/approvals";
		render(<GlobalBanners />);
		expect(screen.queryByText(/Choose who decides/)).toBeNull();
		cleanup();
		mocks.pathname = "/analytics";
		mocks.canSetDefaults = false;
		render(<GlobalBanners />);
		expect(screen.queryByText(/Choose who decides/)).toBeNull();
	});
});
