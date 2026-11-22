import { describe, expect, it } from "vitest";
import {
	allFeatures,
	FEATURE_STAGES,
	featureStage,
	featureStageLabel,
	IS_BETA,
	isFeatureEnabled,
	PRODUCT_STAGE,
	productStageLabel,
	stageLabel,
} from "./index.ts";

describe("stages", () => {
	it("treats every stage but unavailable as reachable", () => {
		for (const feature of allFeatures()) {
			expect(isFeatureEnabled(feature)).toBe(
				FEATURE_STAGES[feature] !== "unavailable",
			);
		}
	});

	it("marks only the pre-release stages", () => {
		expect(stageLabel("beta")).toBe("Beta");
		expect(stageLabel("release-candidate")).toBe("RC");
		expect(stageLabel("generally-available")).toBeNull();
		expect(stageLabel("unavailable")).toBeNull();
	});
});

describe("product stage", () => {
	it("labels the product like any other pre-release stage", () => {
		expect(productStageLabel()).toBe(stageLabel(PRODUCT_STAGE));
	});

	it("treats beta and RC as pre-GA", () => {
		expect(IS_BETA).toBe(
			PRODUCT_STAGE === "beta" || PRODUCT_STAGE === "release-candidate",
		);
	});
});

describe("an unavailable feature", () => {
	it("is switched off and carries no stage label", () => {
		expect(featureStage("mcp-events")).toBe("unavailable");
		expect(isFeatureEnabled("mcp-events")).toBe(false);
		expect(featureStageLabel("mcp-events")).toBeNull();
	});
});
