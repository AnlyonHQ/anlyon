import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import type {
	AgentAnalytics,
	AnalyticsQuery,
	ErrorDistribution,
	MessageAnalytics,
	OverviewAnalytics,
	TopUrl,
	TrustControlAnalytics,
} from "@/lib/types";

export interface TimeSeriesPoint {
	period: string;
	published: number;
	delivered: number;
	failed: number;
}

type AnalyticsResource = "overview" | "agents" | "trust-control";

export const analyticsKeys = {
	all: ["analytics"] as const,
	resource: (
		resource: AnalyticsResource,
		workspaceId: string | undefined,
		query: AnalyticsQuery,
	) => [...analyticsKeys.all, resource, workspaceId, query] as const,
	legacy: (
		resource: string,
		workspaceId: string | undefined,
		query?: AnalyticsQuery | number,
	) => [...analyticsKeys.all, "v1", resource, workspaceId, query] as const,
};

function analyticsParams(
	query: AnalyticsQuery,
): Record<string, string | number> {
	const params: Record<string, string | number> = {};
	if (query.startDate) params.startDate = query.startDate;
	if (query.endDate) params.endDate = query.endDate;
	if (query.granularity) params.granularity = query.granularity;
	if (query.environmentId) params.environmentId = query.environmentId;
	if (query.limit) params.limit = query.limit;
	return params;
}

function useProductAnalytics<T>(
	resource: AnalyticsResource,
	workspaceId: string | undefined,
	query: AnalyticsQuery,
	enabled: boolean,
) {
	return useQuery({
		queryKey: analyticsKeys.resource(resource, workspaceId, query),
		queryFn: () =>
			apiClient.get<T>(`/analytics/${resource}`, {
				workspaceId,
				params: analyticsParams(query),
			}),
		enabled: enabled && !!workspaceId,
	});
}

export function useOverviewAnalytics(
	workspaceId?: string,
	query: AnalyticsQuery = {},
	enabled = true,
) {
	return useProductAnalytics<OverviewAnalytics>(
		"overview",
		workspaceId,
		query,
		enabled,
	);
}

export function useAgentAnalytics(
	workspaceId?: string,
	query: AnalyticsQuery = {},
	enabled = true,
) {
	return useProductAnalytics<AgentAnalytics>(
		"agents",
		workspaceId,
		query,
		enabled,
	);
}

export function useTrustControlAnalytics(
	workspaceId?: string,
	query: AnalyticsQuery = {},
	enabled = true,
) {
	return useProductAnalytics<TrustControlAnalytics>(
		"trust-control",
		workspaceId,
		query,
		enabled,
	);
}

export function useMessageAnalytics(
	workspaceId?: string,
	query: AnalyticsQuery = {},
) {
	return useQuery({
		queryKey: analyticsKeys.legacy("messages", workspaceId, query),
		queryFn: () =>
			apiClient.get<MessageAnalytics>("/analytics/messages", {
				workspaceId,
				params: analyticsParams(query),
			}),
		enabled: !!workspaceId,
	});
}

export function useTimeSeriesData(
	workspaceId?: string,
	query: AnalyticsQuery = {},
) {
	return useQuery({
		queryKey: analyticsKeys.legacy("time-series", workspaceId, query),
		queryFn: () =>
			apiClient.get<TimeSeriesPoint[]>("/analytics/time-series", {
				workspaceId,
				params: analyticsParams(query),
			}),
		enabled: !!workspaceId,
	});
}

export function useTopUrls(workspaceId?: string, query: AnalyticsQuery = {}) {
	return useQuery({
		queryKey: analyticsKeys.legacy("top-urls", workspaceId, query),
		queryFn: () =>
			apiClient.get<TopUrl[]>("/analytics/top-urls", {
				workspaceId,
				params: analyticsParams(query),
			}),
		enabled: !!workspaceId,
	});
}

export function useErrorDistribution(
	workspaceId?: string,
	query: AnalyticsQuery = {},
) {
	return useQuery({
		queryKey: analyticsKeys.legacy("errors", workspaceId, query),
		queryFn: () =>
			apiClient.get<ErrorDistribution[]>("/analytics/errors", {
				workspaceId,
				params: analyticsParams(query),
			}),
		enabled: !!workspaceId,
	});
}
