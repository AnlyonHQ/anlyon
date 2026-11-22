import type { AvailablePlan, UsagePolicy } from "./types";

export const formatMoney = (cents: number) =>
	new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
		cents / 100,
	);
export const formatCount = (value: number | "unlimited") =>
	value === "unlimited" ? "Unlimited" : new Intl.NumberFormat().format(value);
export function includedUnits(policy: UsagePolicy): number | null {
	switch (policy.kind) {
		case "unlimited":
			return null;
		case "hard-cap":
			return policy.capUnits;
		case "payment-required":
			return 0;
		default:
			return policy.includedUnits;
	}
}
export function planHighlights(plan: AvailablePlan): string[] {
	const executions = includedUnits(plan.usagePolicy.actionInvokes);
	const limits = plan.limits;
	const environments =
		limits.maxEnvironments === 1
			? "1 environment"
			: `${formatCount(limits.maxEnvironments)} environments`;
	return [
		executions === null
			? "Custom execution allowance"
			: `${formatCount(executions)} executions / month`,
		`${formatCount(limits.maxSeats)} seats · ${formatCount(limits.maxActions)} actions`,
		environments,
		`${limits.traceRetentionDays} days of trace retention`,
		limits.traceArchival ? "Trace archive and export" : "Live traces",
		plan.features.protectedProduction
			? "Protected production and controlled promotion"
			: "Halt, isolation, and approvals included",
	];
}
