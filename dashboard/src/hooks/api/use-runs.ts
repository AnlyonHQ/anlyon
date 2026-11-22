import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import type {
	PaginatedResponse,
	Run,
	RunStatus,
	RunWithSpans,
} from "@/lib/types";

export const runKeys = {
	all: ["runs"] as const,
	lists: () => [...runKeys.all, "list"] as const,
	list: (
		workspaceId?: string,
		params?: { search?: string; status?: RunStatus; offset?: number },
	) => [...runKeys.lists(), workspaceId, params] as const,
	detail: (runId: string) => [...runKeys.all, "detail", runId] as const,
};

export function useRuns(
	workspaceId?: string,
	params?: {
		search?: string;
		status?: RunStatus;
		limit?: number;
		offset?: number;
	},
) {
	return useQuery({
		queryKey: runKeys.list(workspaceId, {
			search: params?.search,
			status: params?.status,
			offset: params?.offset,
		}),
		queryFn: () =>
			apiClient.get<PaginatedResponse<Run>>("/runs", {
				workspaceId,
				params: params as Record<string, string | number | boolean | undefined>,
			}),
		enabled: !!workspaceId,
		refetchInterval: 15_000,
	});
}

export function useRun(workspaceId?: string, runId?: string) {
	return useQuery({
		queryKey: runKeys.detail(runId ?? ""),
		queryFn: () =>
			apiClient.get<RunWithSpans>(`/runs/${runId}`, { workspaceId }),
		enabled: !!workspaceId && !!runId,
		refetchInterval: 5_000,
	});
}
