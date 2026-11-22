import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "./api-client";
import {
	clearQuotaFeedback,
	publishQuotaFeedback,
	suppressQuotaToast,
} from "./quota-feedback";

describe("quota feedback", () => {
	afterEach(() => clearQuotaFeedback());

	it("takes 402 PAYMENT_REQUIRED and 403 PLAN_FEATURE_REQUIRED off the toast and into the banner", () => {
		publishQuotaFeedback(
			new ApiError(
				"Choose a plan to run actions.",
				402,
				"PAYMENT_REQUIRED",
				"ws_1",
			),
		);
		expect(suppressQuotaToast("Choose a plan to run actions.")).toBe(true);
		publishQuotaFeedback(
			new ApiError(
				"Single sign-on needs the growth plan.",
				403,
				"PLAN_FEATURE_REQUIRED",
				"ws_1",
				{ feature: "sso", requiredPlan: "growth" },
			),
		);
		expect(suppressQuotaToast("Single sign-on needs the growth plan.")).toBe(
			true,
		);
	});

	it("leaves every other error to its toast", () => {
		publishQuotaFeedback(new ApiError("Name taken", 409, "CONFLICT", "ws_1"));
		expect(suppressQuotaToast("Name taken")).toBe(false);
	});
});
