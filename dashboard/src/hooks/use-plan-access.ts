import { usePlanDetails } from "@/hooks/api/use-plan";
import { hasLiveSubscription, planHasTeamFeatures } from "@/lib/plans";
import { isSelfHosted } from "@/lib/runtime-config";

export function usePlanAccess(workspaceId?: string) {
	const plan = usePlanDetails(workspaceId);
	const access = plan.data?.access;
	const subscribed =
		hasLiveSubscription(plan.data) ||
		(plan.data?.subscription?.hasSubscription ?? false);
	const paidPlansAvailable = access?.paidPlansAvailable ?? false;
	const hasTeamFeatures = planHasTeamFeatures(plan.data);
	return {
		isLoading: plan.isPending,
		error: plan.error,
		plan: plan.data,
		access,
		paidPlansAvailable,
		betaOnly:
			plan.data?.plan === "free" &&
			access?.betaAllowancesApply === true &&
			access.paidPlansAvailable === false &&
			!subscribed,
		noPlan:
			paidPlansAvailable &&
			plan.data?.plan === "free" &&
			access?.betaAllowancesApply !== true &&
			!subscribed,
		hasTeamFeatures,
		teamPlanRequired:
			!isSelfHosted() &&
			paidPlansAvailable &&
			plan.data !== undefined &&
			!hasTeamFeatures,
		refetch: plan.refetch,
	};
}
