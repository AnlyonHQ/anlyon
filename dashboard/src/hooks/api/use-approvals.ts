import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type {
	Approval,
	ApprovalDecider,
	ApprovalDecision,
	ApprovalStatus,
	PaginatedResponse,
} from "@/lib/types";

export const approvalKeys = {
	all: ["approvals"] as const,
	lists: () => [...approvalKeys.all, "list"] as const,
	list: (
		workspaceId?: string,
		params?: ApprovalListParams,
	) => [...approvalKeys.lists(), workspaceId, params] as const,
};

export type ApprovalListParams = {
	status?: ApprovalStatus;
	decisionOrigin?: "human" | "policy" | "system" | "assistant" | "automated";
	limit?: number;
	offset?: number;
	endUserId?: string;
	environmentId?: string;
	actingFor?: "workspace" | "end_users";
	decider?: ApprovalDecider;
};

export function useApprovals(
	workspaceId?: string,
	params?: ApprovalListParams,
) {
	return useQuery({
		queryKey: approvalKeys.list(workspaceId, {
			status: params?.status,
			decisionOrigin: params?.decisionOrigin,
			limit: params?.limit,
			offset: params?.offset,
			endUserId: params?.endUserId,
			environmentId: params?.environmentId,
			actingFor: params?.actingFor,
			decider: params?.decider,
		}),
		queryFn: () =>
			apiClient.get<PaginatedResponse<Approval>>("/approvals", {
				workspaceId,
				params: params as Record<string, string | number | boolean | undefined>,
			}),
		enabled: !!workspaceId,
		refetchInterval: 30_000,
	});
}

export function useApprovalDetail(workspaceId?: string, approvalId?: string) {
	return useQuery({
		queryKey: [...approvalKeys.all, "detail", workspaceId, approvalId],
		queryFn: () =>
			apiClient.get<Approval>(`/approvals/${approvalId}`, { workspaceId }),
		enabled: !!workspaceId && !!approvalId,
		refetchInterval: 30_000,
	});
}

export function useDecideApproval() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			approvalId,
			decision,
			note,
			workspaceId,
		}: {
			approvalId: string;
			decision: "approve" | "deny";
			note?: string;
			workspaceId: string;
		}) =>
			apiClient.post<ApprovalDecision>(
				`/approvals/${approvalId}/${decision}`,
				{ note },
				{ workspaceId },
			),
		onSuccess: (result) => {
			queryClient.invalidateQueries({ queryKey: approvalKeys.all });
			queryClient.invalidateQueries({ queryKey: ["actions"] });

			if (result.approval.status === "denied") {
				toast.success("Denied. Anlyon will not run it.");
				return;
			}
			if (result.invocation) {
				if (result.invocation.status === "unknown") {
					toast.error(
						"Approved, but the destination outcome is unknown. Reconcile before retrying.",
					);
				} else if (result.invocation.status === "succeeded") {
					toast.success(
						`Approved. The action ran (HTTP ${result.invocation.responseStatus}).`,
					);
				} else if (result.invocation.status === "failed") {
					toast.error(
						`Approved. The action failed: ${result.invocation.error ?? "unknown error"}`,
					);
				} else {
					toast.success(
						`Approved. Invocation status: ${result.invocation.status}.`,
					);
				}
				return;
			}
			toast.success("Approved.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to record the decision");
		},
	});
}
