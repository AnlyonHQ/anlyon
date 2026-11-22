/* @vitest-environment jsdom */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageSummary } from "./usage-summary";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => (
		<a href="/">{children}</a>
	),
}));

const GIB = 1024 ** 3;

const state = vi.hoisted(() => ({
	functionRuns: undefined as unknown,
}));

const usage = (used: number, included: number) => ({
	includedUnits: included,
	usedUnits: used,
	overageUnits: 0,
	projectedOverageCents: 0,
	reservedUnits: 0,
});

vi.mock("@/hooks/api/use-plan", () => ({
	useQuotaStatus: () => ({
		isPending: false,
		error: null,
		data: {
			plan: "starter",
			allowances: {
				actionInvokes: usage(10, 50_000),
				messages: usage(0, 0),
				storage: usage(0, GIB),
				bandwidth: usage(0, 10 * GIB),
				monthlyFeeCents: 1900,
				projectedOverageCents: 0,
			},
			functionRuns: state.functionRuns,
		},
	}),
	useCurrentUsage: () => ({ data: undefined }),
}));

afterEach(() => {
	cleanup();
	state.functionRuns = undefined;
});

describe("UsageSummary function runs", () => {
	it("shows this month's runs and the runs going now once functions are served", () => {
		state.functionRuns = {
			used: 140,
			running: 1,
			available: true,
			limits: { runsPerMonth: 2000, concurrentRuns: 2, runStartsPerMinute: 30 },
		};
		render(<UsageSummary workspaceId="ws_1" />);
		const runs = screen.getByTestId("function-runs");
		expect(within(runs).getByText("140 of 2,000 runs")).toBeTruthy();
		expect(
			within(runs).getByText(/1 running now · 2 at once on your plan/),
		).toBeTruthy();
	});

	it("leaves function runs out while functions are not served and none ran", () => {
		state.functionRuns = {
			used: 0,
			running: 0,
			available: false,
			limits: { runsPerMonth: 2000, concurrentRuns: 2, runStartsPerMinute: 30 },
		};
		render(<UsageSummary workspaceId="ws_1" />);
		expect(screen.queryByTestId("function-runs")).toBeNull();
	});
});

describe("UsageSummary without an extension", () => {
	it("shows the meters with no way to buy more", () => {
		render(<UsageSummary workspaceId="ws_1" />);
		expect(screen.getByText("Monthly usage")).toBeTruthy();
		expect(screen.getByText("No surprise bills")).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
	});
});
