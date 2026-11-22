export type FeatureStage =
	| "unavailable"
	| "beta"
	| "release-candidate"
	| "generally-available";

export const FEATURE_STAGES = {
	actions: "generally-available",
	agents: "generally-available",
	"ai-assistant": "beta",
	analytics: "generally-available",
	"approval-policies": "generally-available",
	approvals: "generally-available",
	"connected-accounts": "beta",
	dlq: "generally-available",
	environments: "generally-available",
	events: "generally-available",
	functions: "beta",
	"google-integrations": "unavailable",
	logs: "generally-available",
	"mcp-events": "unavailable",
	"mcp-upstreams": "beta",
	runs: "generally-available",
} as const satisfies Record<string, FeatureStage>;

export type FeatureKey = keyof typeof FEATURE_STAGES;

export function featureStage(feature: FeatureKey): FeatureStage {
	return FEATURE_STAGES[feature];
}

export function isFeatureEnabled(feature: FeatureKey): boolean {
	return FEATURE_STAGES[feature] !== "unavailable";
}

export function stageLabel(stage: FeatureStage): string | null {
	switch (stage) {
		case "beta":
			return "Beta";
		case "release-candidate":
			return "RC";
		default:
			return null;
	}
}

export function featureStageLabel(feature: FeatureKey): string | null {
	return stageLabel(FEATURE_STAGES[feature]);
}

export function allFeatures(): FeatureKey[] {
	return Object.keys(FEATURE_STAGES) as FeatureKey[];
}

export const PRODUCT_STAGE: FeatureStage = "beta";

export const IS_BETA =
	PRODUCT_STAGE === "beta" || PRODUCT_STAGE === "release-candidate";

export function productStageLabel(): string | null {
	return stageLabel(PRODUCT_STAGE);
}

export const BETA_POLICY_URL = "https://docs.anlyon.com/beta";
