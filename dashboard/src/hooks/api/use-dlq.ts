import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type { DlqStats, Message, PaginatedResponse } from "@/lib/types";

export const dlqKeys = {
	all: ["dlq"] as const,
	lists: () => [...dlqKeys.all, "list"] as const,
	list: (workspaceId: string | undefined, page: number, limit: number) =>
		[...dlqKeys.lists(), workspaceId, { page, limit }] as const,
	allStats: () => [...dlqKeys.all, "stats"] as const,
	stats: (workspaceId?: string) =>
		[...dlqKeys.allStats(), workspaceId] as const,
	details: () => [...dlqKeys.all, "detail"] as const,
	detail: (id: string) => [...dlqKeys.details(), id] as const,
};

export function useDlqMessages(workspaceId?: string, page = 1, limit = 20) {
	return useQuery({
		queryKey: dlqKeys.list(workspaceId, page, limit),
		queryFn: () =>
			apiClient.get<PaginatedResponse<Message>>(
				`/dlq?page=${page}&limit=${limit}`,
				{ workspaceId },
			),
		enabled: !!workspaceId,
	});
}

export function useDlqStats(workspaceId?: string) {
	return useQuery({
		queryKey: dlqKeys.stats(workspaceId),
		queryFn: () => apiClient.get<DlqStats>("/dlq/stats", { workspaceId }),
		enabled: !!workspaceId,
	});
}

export function useDlqMessage(messageId: string, workspaceId?: string) {
	return useQuery({
		queryKey: dlqKeys.detail(messageId),
		queryFn: () => apiClient.get<Message>(`/dlq/${messageId}`, { workspaceId }),
		enabled: !!messageId && !!workspaceId,
	});
}

export function useRetryDlqMessage() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			messageId,
			workspaceId,
		}: {
			messageId: string;
			workspaceId: string;
		}) =>
			apiClient.post<void>(`/dlq/${messageId}/retry`, undefined, {
				workspaceId,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: dlqKeys.lists() });
			queryClient.invalidateQueries({ queryKey: dlqKeys.allStats() });
			toast.success("Message queued for retry");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to retry message");
		},
	});
}

export function useRetryAllDlqMessages() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (workspaceId: string) =>
			apiClient.post<{ retriedCount: number; remaining: number }>(
				"/dlq/retry-all",
				undefined,
				{ workspaceId },
			),
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: dlqKeys.lists() });
			queryClient.invalidateQueries({ queryKey: dlqKeys.allStats() });
			toast.success(
				data.remaining > 0
					? `${data.retriedCount} message(s) queued for retry. ${data.remaining} still failed`
					: `${data.retriedCount} message(s) queued for retry`,
			);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to retry messages");
		},
	});
}

export function useDeleteDlqMessage() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			messageId,
			workspaceId,
		}: {
			messageId: string;
			workspaceId: string;
		}) => apiClient.delete<void>(`/dlq/${messageId}`, { workspaceId }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: dlqKeys.lists() });
			queryClient.invalidateQueries({ queryKey: dlqKeys.allStats() });
			toast.success("Message deleted successfully");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to delete message");
		},
	});
}

export function useClearDlq() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (workspaceId: string) =>
			apiClient.delete<{ deletedCount: number; remaining: number }>("/dlq", {
				workspaceId,
			}),
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: dlqKeys.lists() });
			queryClient.invalidateQueries({ queryKey: dlqKeys.allStats() });
			toast.success(
				data.remaining > 0
					? `${data.deletedCount} message(s) deleted. ${data.remaining} still failed`
					: "DLQ cleared successfully",
			);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to clear DLQ");
		},
	});
}
