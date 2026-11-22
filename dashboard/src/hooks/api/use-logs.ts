import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import type { DetailedLogsStats, LogFilters, LogsResponse } from "@/lib/types";

export const logsKeys = {
	all: ["logs"] as const,
	lists: () => [...logsKeys.all, "list"] as const,
	list: (workspaceId: string | undefined, filters: Partial<LogFilters>) =>
		[...logsKeys.lists(), workspaceId, filters] as const,
	stats: () => [...logsKeys.all, "stats"] as const,
	statsFiltered: (
		workspaceId: string | undefined,
		filters: Partial<LogFilters>,
	) => [...logsKeys.stats(), workspaceId, filters] as const,
};

export const defaultLogFilters: LogFilters = {
	type: "all",
	status: [],
	httpStatus: [],
	dateRange: {},
	duration: {},
	url: "",
	messageId: "",
	errorCode: "",
	search: "",
	sortBy: "timestamp",
	sortOrder: "desc",
	page: 1,
	limit: 50,
};

function buildLogsQueryParams(
	filters: Partial<LogFilters>,
): Record<string, string | number | boolean | undefined> {
	const params: Record<string, string | number | boolean | undefined> = {};

	if (filters.type && filters.type !== "all") {
		params.type = filters.type;
	}

	if (filters.status && filters.status.length > 0) {
		params.status = filters.status.join(",");
	}

	if (filters.httpStatus && filters.httpStatus.length > 0) {
		params.httpStatus = filters.httpStatus.join(",");
	}

	if (filters.dateRange?.start) {
		params.startDate = filters.dateRange.start;
	}

	if (filters.dateRange?.end) {
		params.endDate = filters.dateRange.end;
	}

	if (filters.duration?.min !== undefined) {
		params.minDuration = filters.duration.min;
	}

	if (filters.duration?.max !== undefined) {
		params.maxDuration = filters.duration.max;
	}

	if (filters.url) {
		params.url = filters.url;
	}

	if (filters.messageId) {
		params.messageId = filters.messageId;
	}

	if (filters.errorCode) {
		params.errorCode = filters.errorCode;
	}

	if (filters.search) {
		params.search = filters.search;
	}

	if (filters.sortBy) {
		params.sortBy = filters.sortBy;
	}

	if (filters.sortOrder) {
		params.sortOrder = filters.sortOrder;
	}

	if (filters.page) {
		params.page = filters.page;
	}

	if (filters.limit) {
		params.limit = filters.limit;
	}

	return params;
}

export function useLogs(
	workspaceId: string | undefined,
	filters: Partial<LogFilters> = {},
	options?: { refetchInterval?: number | false },
) {
	return useQuery({
		queryKey: logsKeys.list(workspaceId, filters),
		queryFn: async () => {
			const params = buildLogsQueryParams(filters);
			return apiClient.get<LogsResponse>("/logs", {
				workspaceId,
				params,
			});
		},
		enabled: !!workspaceId,
		refetchInterval: options?.refetchInterval,
	});
}

export function useLogsStats(
	workspaceId: string | undefined,
	filters: Partial<Pick<LogFilters, "type" | "dateRange">> = {},
) {
	return useQuery({
		queryKey: logsKeys.statsFiltered(workspaceId, filters),
		queryFn: async () => {
			const params: Record<string, string | undefined> = {};

			if (filters.type && filters.type !== "all") {
				params.type = filters.type;
			}

			if (filters.dateRange?.start) {
				params.startDate = filters.dateRange.start;
			}

			if (filters.dateRange?.end) {
				params.endDate = filters.dateRange.end;
			}

			return apiClient.get<DetailedLogsStats>("/logs/stats", {
				workspaceId,
				params,
			});
		},
		enabled: !!workspaceId,
	});
}

export async function exportLogs(
	workspaceId: string,
	filters: Partial<LogFilters>,
	format: "csv" | "json" = "csv",
): Promise<{ url: string; filename: string }> {
	const params = buildLogsQueryParams(filters);
	params.format = format;

	const queryString = new URLSearchParams(
		Object.entries(params)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => [k, String(v)]),
	).toString();

	const response = await fetch(`/api/v2/logs/export?${queryString}`, {
		method: "GET",
		credentials: "include",
		headers: {
			"X-Workspace-Id": workspaceId,
			"X-Request-Referer": "dashboard",
		},
	});

	if (!response.ok) {
		throw new Error("Failed to export logs");
	}

	const blob = await response.blob();
	const url = URL.createObjectURL(blob);
	const filename = `logs-export-${new Date().toISOString().slice(0, 10)}.${format}`;

	return { url, filename };
}
