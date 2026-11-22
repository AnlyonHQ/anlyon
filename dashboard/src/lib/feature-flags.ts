import { type FeatureKey, isFeatureEnabled } from "@anlyon/feature-flags";
import { redirect } from "@tanstack/react-router";

export function requireFeature(feature: FeatureKey): void {
	if (!isFeatureEnabled(feature)) {
		throw redirect({ to: "/dashboard" });
	}
}
