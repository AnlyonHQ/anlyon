import { isFeatureEnabled } from "@anlyon/feature-flags";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type {
	Approval,
	ApprovalPolicy,
	AssistantAdvice,
	AssistantSettings,
	AssistantSettingsPatch,
	PolicySuggestion,
} from "@/lib/types";
import { approvalPolicyKeys } from "./use-approval-policies";
import { approvalKeys } from "./use-approvals";

export const assistantKeys = {
	all: ["assistant"] as const,
	settings: (workspaceId?: string) =>
		[...assistantKeys.all, "settings", workspaceId] as const,
	suggestions: (workspaceId?: string) =>
		[...assistantKeys.all, "suggestions", workspaceId] as const,
};

export function useAssistantSettings(workspaceId?: string) {
	return useQuery({
		queryKey: assistantKeys.settings(workspaceId),
		queryFn: () =>
			apiClient.get<AssistantSettings>(`/workspaces/${workspaceId}/assistant`),
		enabled: !!workspaceId,
	});
}

export function useUpdateAssistantSettings(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (patch: AssistantSettingsPatch) =>
			apiClient.put<AssistantSettings>(
				`/workspaces/${workspaceId}/assistant`,
				patch,
			),
		onSuccess: (settings) => {
			queryClient.setQueryData(assistantKeys.settings(workspaceId), settings);
			toast.success("Vigil settings saved");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function usePolicySuggestions(workspaceId?: string, enabled = true) {
	return useQuery({
		queryKey: assistantKeys.suggestions(workspaceId),
		queryFn: () =>
			apiClient.get<PolicySuggestion[]>(
				`/workspaces/${workspaceId}/assistant/policy-suggestions`,
			),
		enabled: !!workspaceId && enabled,
	});
}

export function useAcceptPolicySuggestion(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (key: string) =>
			apiClient.post<ApprovalPolicy[]>(
				`/workspaces/${workspaceId}/assistant/policy-suggestions/${encodeURIComponent(key)}/accept`,
				{},
			),
		onSuccess: (created) => {
			queryClient.invalidateQueries({ queryKey: approvalPolicyKeys.all });
			queryClient.invalidateQueries({
				queryKey: assistantKeys.suggestions(workspaceId),
			});
			toast.success(
				created.length === 1
					? "Policy created"
					: `${created.length} policies created`,
			);
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useAuditQueue(workspaceId?: string) {
	return useQuery({
		queryKey: [...assistantKeys.all, "audit-queue", workspaceId] as const,
		queryFn: () =>
			apiClient.get<Approval[]>(
				`/workspaces/${workspaceId}/assistant/audit-queue`,
			),
		enabled: !!workspaceId && isFeatureEnabled("ai-assistant"),
		retry: false,
		refetchInterval: 60_000,
	});
}

export function useAuditAdvice(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			approvalId,
			verdict,
		}: {
			approvalId: string;
			verdict: "agree" | "disagree";
		}) =>
			apiClient.post<AssistantAdvice>(
				`/workspaces/${workspaceId}/approvals/${approvalId}/advice/audit`,
				{ verdict },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: approvalKeys.all });
			queryClient.invalidateQueries({ queryKey: assistantKeys.all });
			toast.success("Thanks, your verdict is recorded");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}
