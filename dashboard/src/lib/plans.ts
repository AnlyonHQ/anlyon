import type { Plan, PlanDetails } from "./types";

const PLAN_NAMES: Record<Plan, string> = {
	free: "No plan",
	starter: "Starter",
	production: "Pro",
	growth: "Team",
	enterprise: "Enterprise",
	paygo: "Pro",
};

export function planName(plan: Plan | null | undefined): string {
	return plan ? PLAN_NAMES[plan] : PLAN_NAMES.free;
}

export function hasLiveSubscription(details: PlanDetails | undefined): boolean {
	const status = details?.status;
	return status === "trialing" || status === "active" || status === "past_due";
}

export function planHasTeamFeatures(details: PlanDetails | undefined): boolean {
	const flag = (details?.features as { teamFeatures?: boolean } | undefined)
		?.teamFeatures;
	if (typeof flag === "boolean") return flag;
	return details?.plan === "growth" || details?.plan === "enterprise";
}

export function daysUntil(iso: string, now = Date.now()): number {
	return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 86_400_000));
}

export function billingDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, { dateStyle: "long" });
}

const TEAM_FEATURE_LABELS: Record<string, string> = {
	sso: "Single sign-on",
	ssoconnection: "Single sign-on",
	scim: "Directory sync",
	directorysync: "Directory sync",
	rolemappings: "Directory sync",
	audit: "Audit streaming",
	auditstreaming: "Audit streaming",
	auditsink: "Audit streaming",
	auditsinks: "Audit streaming",
	secretstore: "Secret stores",
	secretstores: "Secret stores",
	environmentrole: "Roles per environment",
	environmentroles: "Roles per environment",
};

export function teamFeatureLabel(feature: string | undefined): string {
	const key = (feature ?? "").toLowerCase().replace(/[^a-z]/g, "");
	return TEAM_FEATURE_LABELS[key] ?? "This feature";
}
