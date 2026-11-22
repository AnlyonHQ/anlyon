import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import type { BillingUsage, PlanDetails, QuotaStatus } from "@/lib/types";

export const planKeys = {
	all: ["billing"] as const,
	plan: (workspaceId: string) =>
		[...planKeys.all, "plan", workspaceId] as const,
	usage: (workspaceId: string) =>
		[...planKeys.all, "usage", workspaceId] as const,
	quota: (workspaceId: string) =>
		[...planKeys.all, "quota", workspaceId] as const,
};

export function usePlanDetails(
	workspaceId?: string,
	options: { refetchInterval?: number | false } = {},
) {
	return useQuery({
		queryKey: planKeys.plan(workspaceId || ""),
		queryFn: () => apiClient.get<PlanDetails>("/billing/plan", { workspaceId }),
		enabled: !!workspaceId,
		refetchInterval: options.refetchInterval,
	});
}

export function useCurrentUsage(workspaceId?: string) {
	return useQuery({
		queryKey: planKeys.usage(workspaceId || ""),
		queryFn: () =>
			apiClient.get<BillingUsage>("/billing/usage/current", { workspaceId }),
		enabled: !!workspaceId,
		refetchInterval: 60000,
	});
}

export function useQuotaStatus(workspaceId?: string) {
	return useQuery({
		queryKey: planKeys.quota(workspaceId || ""),
		queryFn: () =>
			apiClient.get<QuotaStatus>("/billing/quota", { workspaceId }),
		enabled: !!workspaceId,
		refetchInterval: 30000,
	});
}
