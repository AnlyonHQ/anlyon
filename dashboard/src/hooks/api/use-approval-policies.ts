import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type {
	ApprovalDecider,
	ApprovalPolicy,
	ApprovalPolicyEffect,
	ApprovalPolicyVersion,
	ConditionAssist,
} from "@/lib/types";

export const approvalPolicyKeys = {
	all: ["approval-policies"] as const,
	list: (workspaceId?: string, environmentId?: string) =>
		[...approvalPolicyKeys.all, workspaceId, environmentId] as const,
	versions: (workspaceId?: string, policyId?: string) =>
		[...approvalPolicyKeys.all, "versions", workspaceId, policyId] as const,
	version: (workspaceId?: string, policyId?: string, version?: number) =>
		[
			...approvalPolicyKeys.all,
			"version",
			workspaceId,
			policyId,
			version,
		] as const,
};

export interface ApprovalPolicyInput {
	environmentId: string;
	name: string;
	matchKind: "any" | "action" | "custom";
	matchActionName?: string;
	priority?: number;
	enabled?: boolean;
	minAmount?: number;
	effect?: ApprovalPolicyEffect;
	requiredApprovals?: number;
	acknowledgeBroadScope?: boolean;
	changeNote?: string;
	condition?: string;
	decidedBy?: ApprovalDecider;
}

export interface ApprovalPolicyPatch {
	policyId: string;
	name?: string;
	matchKind?: "any" | "action" | "custom";
	matchActionName?: string | null;
	priority?: number;
	enabled?: boolean;
	minAmount?: number | null;
	effect?: ApprovalPolicyEffect;
	requiredApprovals?: number;
	acknowledgeBroadScope?: boolean;
	changeNote?: string;
	condition?: string | null;
	conditions?: null;
	decidedBy?: ApprovalDecider;
}

export function useApprovalPolicies(
	workspaceId?: string,
	environmentId?: string,
) {
	return useQuery({
		queryKey: approvalPolicyKeys.list(workspaceId, environmentId),
		queryFn: () =>
			apiClient.get<ApprovalPolicy[]>(
				`/workspaces/${workspaceId}/approval-policies`,
				{ params: environmentId ? { environmentId } : undefined },
			),
		enabled: !!workspaceId,
	});
}

export interface ConditionAssistRequest {
	environmentId: string;
	matchKind: "any" | "action" | "custom";
	matchActionName?: string | null;
	condition?: string | null;
	sampleInput?: Record<string, unknown>;
	policyId?: string;
}

export function useConditionAssist(
	workspaceId: string | undefined,
	request: ConditionAssistRequest | null,
) {
	return useQuery({
		queryKey: [
			...approvalPolicyKeys.all,
			"condition-assist",
			workspaceId,
			request,
		],
		queryFn: () =>
			apiClient.post<ConditionAssist>(
				`/workspaces/${workspaceId}/approval-policies/condition-assist`,
				request,
			),
		enabled: !!workspaceId && !!request?.environmentId,
		placeholderData: (previous) => previous,
		staleTime: 30_000,
	});
}

export interface ConditionDraftRequest {
	environmentId: string;
	matchKind: "any" | "action" | "custom";
	matchActionName?: string | null;
	request: string;
}

export interface ConditionDraft {
	condition: string | null;
	check: { valid: true } | { valid: false; message: string } | null;
	usage: { used: number; limit: number };
}

export function useDraftCondition(workspaceId?: string) {
	return useMutation({
		mutationFn: (request: ConditionDraftRequest) =>
			apiClient.post<ConditionDraft>(
				`/workspaces/${workspaceId}/approval-policies/condition-draft`,
				request,
			),
	});
}

export interface PolicyVersionPage {
	data: ApprovalPolicyVersion[];
	pagination: {
		limit: number;
		nextBefore: number | null;
		earliestVersion: number;
		latestVersion: number;
	};
}

export function useApprovalPolicyVersions(
	workspaceId?: string,
	policyId?: string,
) {
	return useInfiniteQuery({
		queryKey: approvalPolicyKeys.versions(workspaceId, policyId),
		queryFn: ({ pageParam }) =>
			apiClient.get<PolicyVersionPage>(
				`/workspaces/${workspaceId}/approval-policies/${policyId}/versions`,
				{ params: pageParam ? { before: pageParam } : undefined },
			),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (last) => last.pagination.nextBefore ?? undefined,
		enabled: !!workspaceId && !!policyId,
	});
}

export function useApprovalPolicyVersion(
	workspaceId?: string,
	policyId?: string,
	version?: number,
) {
	return useQuery({
		queryKey: approvalPolicyKeys.version(workspaceId, policyId, version),
		queryFn: () =>
			apiClient.get<ApprovalPolicyVersion>(
				`/workspaces/${workspaceId}/approval-policies/${policyId}/versions/${version}`,
			),
		enabled: !!workspaceId && !!policyId && version !== undefined,
		retry: false,
	});
}

export function useCreateApprovalPolicy(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: ApprovalPolicyInput) =>
			apiClient.post<ApprovalPolicy>(
				`/workspaces/${workspaceId}/approval-policies`,
				input,
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: approvalPolicyKeys.all });
			toast.success("Policy created");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useUpdateApprovalPolicy(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ policyId, ...input }: ApprovalPolicyPatch) =>
			apiClient.patch<ApprovalPolicy>(
				`/workspaces/${workspaceId}/approval-policies/${policyId}`,
				input,
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: approvalPolicyKeys.all });
			toast.success("Policy updated");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useDeleteApprovalPolicy(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (policyId: string) =>
			apiClient.delete<{ deleted: boolean }>(
				`/workspaces/${workspaceId}/approval-policies/${policyId}`,
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: approvalPolicyKeys.all });
			toast.success("Policy deleted");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}
