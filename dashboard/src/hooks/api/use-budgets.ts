import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type { Budget, BudgetDimension } from "@/lib/types";

export const budgetKeys = {
	all: ["budgets"] as const,
	list: (workspaceId?: string) =>
		[...budgetKeys.all, "list", workspaceId] as const,
};

export interface BudgetInput {
	monthlyCostCentsCap?: number | null;
	dimensionCaps?: Partial<Record<BudgetDimension, number>>;
	alertThreshold?: number;
	enabled?: boolean;
}

export function useBudgets(workspaceId?: string) {
	return useQuery({
		queryKey: budgetKeys.list(workspaceId),
		queryFn: () => apiClient.get<Budget[]>("/budgets", { workspaceId }),
		enabled: !!workspaceId,
	});
}

export function usePutBudget() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			apiKeyId,
			workspaceId,
			...input
		}: BudgetInput & { apiKeyId: string; workspaceId: string }) =>
			apiClient.put<Budget>(`/budgets/${apiKeyId}`, input, { workspaceId }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: budgetKeys.all });
			toast.success("Budget saved.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to save budget");
		},
	});
}

export function useDeleteBudget() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			apiKeyId,
			workspaceId,
		}: {
			apiKeyId: string;
			workspaceId: string;
		}) =>
			apiClient.delete<{ deleted: boolean }>(`/budgets/${apiKeyId}`, {
				workspaceId,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: budgetKeys.all });
			toast.success("Budget removed  this key is now uncapped.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to remove budget");
		},
	});
}
