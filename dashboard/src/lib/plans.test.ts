import { describe, expect, it } from "vitest";
import {
	daysUntil,
	hasLiveSubscription,
	planHasTeamFeatures,
	planName,
	teamFeatureLabel,
} from "./plans";
import type { PlanDetails } from "./types";

describe("plans", () => {
	it("names the plans as the owner set them: Starter, Pro, Team", () => {
		expect(planName("starter")).toBe("Starter");
		expect(planName("production")).toBe("Pro");
		expect(planName("growth")).toBe("Team");
		expect(planName("paygo")).toBe("Pro");
		expect(planName("free")).toBe("No plan");
	});

	it("gives Team features to Team and Enterprise only", () => {
		const details = (plan: string, features = {}) =>
			({ plan, features }) as unknown as PlanDetails;
		expect(planHasTeamFeatures(details("growth"))).toBe(true);
		expect(planHasTeamFeatures(details("production"))).toBe(false);
		expect(
			planHasTeamFeatures(details("production", { teamFeatures: true })),
		).toBe(true);
	});

	it("treats trialing, active and past due as a live subscription", () => {
		const live = (status: string) =>
			hasLiveSubscription({ status } as PlanDetails);
		expect(live("trialing")).toBe(true);
		expect(live("active")).toBe(true);
		expect(live("past_due")).toBe(true);
		expect(live("canceled")).toBe(false);
		expect(live("none")).toBe(false);
		expect(hasLiveSubscription(undefined)).toBe(false);
	});

	it("counts whole days left, never below zero", () => {
		const now = Date.parse("2026-10-24T12:00:00.000Z");
		expect(daysUntil("2026-11-07T12:00:00.000Z", now)).toBe(14);
		expect(daysUntil("2026-10-24T18:00:00.000Z", now)).toBe(1);
		expect(daysUntil("2026-10-20T00:00:00.000Z", now)).toBe(0);
	});

	it("reads the feature of a PLAN_FEATURE_REQUIRED as people do", () => {
		expect(teamFeatureLabel("sso")).toBe("Single sign-on");
		expect(teamFeatureLabel("audit_streaming")).toBe("Audit streaming");
		expect(teamFeatureLabel("secret-stores")).toBe("Secret stores");
		expect(teamFeatureLabel("environmentRoles")).toBe("Roles per environment");
		expect(teamFeatureLabel("something_new")).toBe("This feature");
	});
});
