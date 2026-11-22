/* @vitest-environment jsdom */

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerExtension, resetExtensions } from "@/lib/extensions";
import type { PlanDetails } from "@/lib/types";
import { usePlanAccess } from "./use-plan-access";

beforeEach(() => registerExtension({ id: "hosted", edition: "cloud" }));
afterEach(() => resetExtensions());

const state: {
	data?: Partial<PlanDetails>;
	isPending: boolean;
	error: Error | null;
} = {
	isPending: false,
	error: null,
};
vi.mock("@/hooks/api/use-plan", () => ({
	usePlanDetails: () => ({ ...state, refetch: vi.fn() }),
}));

const access = (over: Record<string, unknown> = {}) => ({
	mode: "early_beta",
	betaAllowancesApply: true,
	paidPlansAvailable: false,
	betaAllowancesEndAt: null,
	usageResetsAt: "2026-11-01T00:00:00.000Z",
	overageBilling: false,
	automaticCharges: false,
	...over,
});
const use = (
	data: Partial<PlanDetails> | undefined,
	over: Partial<typeof state> = {},
) => {
	Object.assign(state, { data, isPending: false, error: null, ...over });
	return renderHook(() => usePlanAccess("ws-1")).result.current;
};

describe("usePlanAccess", () => {
	it("offers nothing to buy until the API says so (loading and error)", () => {
		expect(use(undefined, { isPending: true }).paidPlansAvailable).toBe(false);
		expect(
			use(undefined, { error: new Error("boom") }).paidPlansAvailable,
		).toBe(false);
	});

	it("treats a free workspace on beta allowances, with purchases closed, as beta-only", () => {
		const result = use({
			plan: "free",
			access: access() as never,
			subscription: {
				status: "active",
				isCustomerConfigured: false,
				hasSubscription: false,
			},
		});
		expect(result.betaOnly).toBe(true);
		expect(result.paidPlansAvailable).toBe(false);
	});

	it("shows the normal plan choices once purchases open, even inside the beta transition window", () => {
		const result = use({
			plan: "free",
			access: access({ paidPlansAvailable: true, mode: "standard" }) as never,
		});
		expect(result.betaOnly).toBe(false);
		expect(result.paidPlansAvailable).toBe(true);
	});

	it("never treats a workspace with a subscription as beta-only, so its billing controls stay", () => {
		const result = use({
			plan: "free",
			access: access() as never,
			subscription: {
				status: "active",
				isCustomerConfigured: true,
				hasSubscription: true,
			},
		});
		expect(result.betaOnly).toBe(false);
	});

	it("never treats a paid plan as beta-only", () => {
		expect(
			use({ plan: "production", access: access() as never }).betaOnly,
		).toBe(false);
	});

	const standard = () =>
		access({
			mode: "standard",
			betaAllowancesApply: false,
			paidPlansAvailable: true,
		}) as never;

	it("says a workspace has no plan only once paid plans are on sale and it has no subscription", () => {
		expect(
			use({ plan: "free", status: "none", access: standard() }).noPlan,
		).toBe(true);
		expect(use({ plan: "free", access: access() as never }).noPlan).toBe(false);
		expect(
			use({
				plan: "free",
				access: access({ paidPlansAvailable: true }) as never,
			}).noPlan,
		).toBe(false);
		expect(
			use({ plan: "starter", status: "trialing", access: standard() }).noPlan,
		).toBe(false);
	});

	it("asks for Team on Starter and Pro once paid plans are on sale, never during the beta", () => {
		expect(
			use({ plan: "starter", status: "active", access: standard() })
				.teamPlanRequired,
		).toBe(true);
		expect(
			use({ plan: "production", status: "active", access: standard() })
				.teamPlanRequired,
		).toBe(true);
		expect(
			use({ plan: "growth", status: "trialing", access: standard() })
				.teamPlanRequired,
		).toBe(false);
		expect(
			use({ plan: "enterprise", access: standard() }).teamPlanRequired,
		).toBe(false);
		expect(
			use({ plan: "free", access: access() as never }).teamPlanRequired,
		).toBe(false);
	});

	it("never asks for Team on a self-hosted console, which keeps its licence gate", () => {
		resetExtensions();
		expect(
			use({ plan: "starter", status: "active", access: standard() })
				.teamPlanRequired,
		).toBe(false);
	});

	it("follows the API's own teamFeatures flag over the plan id", () => {
		expect(
			use({
				plan: "production",
				status: "active",
				access: standard(),
				features: { teamFeatures: true } as never,
			}).teamPlanRequired,
		).toBe(false);
	});
});
