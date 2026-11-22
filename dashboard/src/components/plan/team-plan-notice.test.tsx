/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerExtension, resetExtensions } from "@/lib/extensions";
import { TeamPlanNotice } from "./team-plan-notice";

const state = vi.hoisted(() => ({ teamPlanRequired: true }));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "ws_1" } }),
}));
vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => true,
}));
vi.mock("@/hooks/use-plan-access", () => ({
	usePlanAccess: () => ({ teamPlanRequired: state.teamPlanRequired }),
}));

afterEach(() => {
	cleanup();
	resetExtensions();
	state.teamPlanRequired = true;
});

describe("TeamPlanNotice", () => {
	it("says what the feature needs, with nothing to buy, without an extension", () => {
		render(<TeamPlanNotice feature="Single sign-on" />);
		expect(screen.getByText("Single sign-on needs the Team plan")).toBeTruthy();
		expect(
			screen.getByText(
				"Single sign-on is included on the Team and Enterprise plans.",
			),
		).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("leaves room for an extension's way to Team, in the card and in the strip", () => {
		registerExtension({
			id: "fixture",
			PlanAction: ({ site, canManageBilling }) => (
				<span>
					{site}:{String(canManageBilling)}
				</span>
			),
		});
		render(<TeamPlanNotice feature="Audit streaming" hasConfiguration />);
		expect(screen.getByText(/Your current setup keeps working/)).toBeTruthy();
		expect(screen.getByText("team-notice:true")).toBeTruthy();
		expect(screen.getByText("team-notice-aside:true")).toBeTruthy();
		cleanup();
		render(<TeamPlanNotice feature="Audit streaming" variant="inline" />);
		expect(screen.getByText("team-notice-inline:true")).toBeTruthy();
	});

	it("renders nothing when the plan has Team features", () => {
		state.teamPlanRequired = false;
		render(<TeamPlanNotice feature="Single sign-on" />);
		expect(screen.queryByTestId("team-plan-notice")).toBeNull();
	});
});
