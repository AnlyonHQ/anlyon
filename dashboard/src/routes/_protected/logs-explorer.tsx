import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Activity, Circle, FileText, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ExportButton } from "@/components/logs/ExportButton";
import { LogsFilters } from "@/components/logs/LogsFilters";
import { LogsPagination } from "@/components/logs/LogsPagination";
import { LogsStatsBar } from "@/components/logs/LogsStats";
import { LogsTable } from "@/components/logs/LogsTable";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FrameTitle,
} from "@/components/ui/frame";
import { useWorkspace } from "@/contexts/workspace-context";
import { useLogs } from "@/hooks/api/use-logs";
import { requireFeature } from "@/lib/feature-flags";
import { secureStorage } from "@/lib/storage";
import type {
	LogFilters,
	LogSortBy,
	LogSortOrder,
	UnifiedLogType,
} from "@/lib/types";

interface LogsSearchParams {
	type?: UnifiedLogType;
	status?: string;
	httpStatus?: string;
	startDate?: string;
	endDate?: string;
	minDuration?: string;
	maxDuration?: string;
	url?: string;
	messageId?: string;
	errorCode?: string;
	search?: string;
	sortBy?: LogSortBy;
	sortOrder?: LogSortOrder;
	page?: string;
	limit?: string;
}

export const Route = createFileRoute("/_protected/logs-explorer")({
	beforeLoad: () => requireFeature("logs"),
	component: LogsExplorerPage,
	validateSearch: (search: Record<string, unknown>): LogsSearchParams => {
		return {
			type: (search.type as UnifiedLogType) || undefined,
			status: (search.status as string) || undefined,
			httpStatus: (search.httpStatus as string) || undefined,
			startDate: (search.startDate as string) || undefined,
			endDate: (search.endDate as string) || undefined,
			minDuration: (search.minDuration as string) || undefined,
			maxDuration: (search.maxDuration as string) || undefined,
			url: (search.url as string) || undefined,
			messageId: (search.messageId as string) || undefined,
			errorCode: (search.errorCode as string) || undefined,
			search: (search.search as string) || undefined,
			sortBy: (search.sortBy as LogSortBy) || undefined,
			sortOrder: (search.sortOrder as LogSortOrder) || undefined,
			page: (search.page as string) || undefined,
			limit: (search.limit as string) || undefined,
		};
	},
});

function LogsExplorerPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId =
		currentWorkspace?.id || secureStorage.getItem("current_workspace_id");
	const navigate = useNavigate();
	const searchParams = Route.useSearch();

	const [autoRefresh, setAutoRefresh] = useState(false);
	const refreshInterval = autoRefresh ? 30000 : 0;

	const filters = useMemo<LogFilters>(() => {
		return {
			type: searchParams.type || "all",
			status: searchParams.status ? searchParams.status.split(",") : [],
			httpStatus: searchParams.httpStatus
				? searchParams.httpStatus
						.split(",")
						.map((s) => parseInt(s, 10))
						.filter((n) => !isNaN(n))
				: [],
			dateRange: {
				start: searchParams.startDate,
				end: searchParams.endDate,
			},
			duration: {
				min: searchParams.minDuration
					? parseInt(searchParams.minDuration, 10)
					: undefined,
				max: searchParams.maxDuration
					? parseInt(searchParams.maxDuration, 10)
					: undefined,
			},
			url: searchParams.url || "",
			messageId: searchParams.messageId || "",
			errorCode: searchParams.errorCode || "",
			search: searchParams.search || "",
			sortBy: searchParams.sortBy || "timestamp",
			sortOrder: searchParams.sortOrder || "desc",
			page: searchParams.page ? parseInt(searchParams.page, 10) : 1,
			limit: searchParams.limit ? parseInt(searchParams.limit, 10) : 50,
		};
	}, [searchParams]);

	const {
		data: logsResponse,
		isLoading,
		refetch,
		isFetching,
	} = useLogs(workspaceId || undefined, filters, {
		refetchInterval: refreshInterval || false,
	});

	const updateFilters = useCallback(
		(newFilters: LogFilters) => {
			const params: Record<string, string> = {};

			if (newFilters.type !== "all") params.type = newFilters.type;
			if (newFilters.status.length > 0)
				params.status = newFilters.status.join(",");
			if (newFilters.httpStatus.length > 0)
				params.httpStatus = newFilters.httpStatus.join(",");
			if (newFilters.dateRange.start)
				params.startDate = newFilters.dateRange.start;
			if (newFilters.dateRange.end) params.endDate = newFilters.dateRange.end;
			if (newFilters.duration.min !== undefined)
				params.minDuration = newFilters.duration.min.toString();
			if (newFilters.duration.max !== undefined)
				params.maxDuration = newFilters.duration.max.toString();
			if (newFilters.url) params.url = newFilters.url;
			if (newFilters.messageId) params.messageId = newFilters.messageId;
			if (newFilters.errorCode) params.errorCode = newFilters.errorCode;
			if (newFilters.search) params.search = newFilters.search;
			if (newFilters.sortBy !== "timestamp") params.sortBy = newFilters.sortBy;
			if (newFilters.sortOrder !== "desc")
				params.sortOrder = newFilters.sortOrder;
			if (newFilters.page !== 1) params.page = newFilters.page.toString();
			if (newFilters.limit !== 50) params.limit = newFilters.limit.toString();

			navigate({
				to: "/logs-explorer",
				search: params,
				replace: true,
			});
		},
		[navigate],
	);

	const resetFilters = useCallback(() => {
		navigate({
			to: "/logs-explorer",
			search: {},
			replace: true,
		});
	}, [navigate]);

	const handleSort = useCallback(
		(sortBy: LogSortBy, sortOrder: LogSortOrder) => {
			updateFilters({ ...filters, sortBy, sortOrder, page: 1 });
		},
		[filters, updateFilters],
	);

	const handlePageChange = useCallback(
		(page: number) => {
			updateFilters({ ...filters, page });
		},
		[filters, updateFilters],
	);

	const handleLimitChange = useCallback(
		(limit: number) => {
			updateFilters({ ...filters, limit, page: 1 });
		},
		[filters, updateFilters],
	);

	const logs = logsResponse?.data || [];
	const pagination = logsResponse?.pagination;
	const stats = logsResponse?.stats;

	return (
		<div className="min-w-0 w-full space-y-6">
			<Frame className="w-full min-w-0 overflow-hidden">
				<FrameHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
					<div className="flex flex-col gap-1">
						<FrameTitle>Delivery logs</FrameTitle>
						<FrameDescription>
							Execution logs for message deliveries, event webhooks included.
							Governed actions are not listed here. Their records are under
							Invocations and Effects.
						</FrameDescription>
					</div>
					<div className="flex flex-wrap items-center gap-3">
						<button
							type="button"
							onClick={() => setAutoRefresh((v) => !v)}
							aria-pressed={autoRefresh}
							className={`flex h-8 items-center gap-1.5 rounded-lg border px-3 font-medium text-xs shadow-xs outline-none transition-[background-color,border-color,color,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] ${
								autoRefresh
									? "border-brand/30 bg-brand/5 text-brand"
									: "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground"
							}`}
						>
							<Circle
								className={`h-2 w-2 fill-current ${autoRefresh ? "animate-pulse text-brand" : "text-muted-foreground/50"}`}
							/>
							Live
						</button>

						<Button
							variant="outline"
							size="icon-sm"
							aria-label="Refresh"
							onClick={() => refetch()}
							disabled={isFetching}
						>
							<RefreshCw
								className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
							/>
						</Button>

						{workspaceId && (
							<ExportButton
								workspaceId={workspaceId}
								filters={filters}
								disabled={isLoading || logs.length === 0}
							/>
						)}
					</div>
				</FrameHeader>

				<div className="min-w-0 space-y-5">
					<LogsStatsBar
						stats={stats}
						isLoading={isLoading}
						total={pagination?.total || 0}
					/>

					<LogsFilters
						filters={filters}
						onChange={updateFilters}
						onReset={resetFilters}
					/>

					{(filters.type !== "all" || filters.messageId) && (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Activity className="h-4 w-4" />
							<span>
								Filtering by:{" "}
								{filters.type !== "all" && (
									<code className="rounded-md bg-muted px-2 py-0.5 font-mono text-foreground text-xs mr-2">
										Messages
									</code>
								)}
								{filters.messageId && (
									<code className="rounded-md bg-muted px-2 py-0.5 font-mono text-foreground text-xs mr-2">
										{filters.messageId}
									</code>
								)}
							</span>
						</div>
					)}

					{!isLoading && logs.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<FileText className="h-8 w-8 text-muted-foreground" />
								</EmptyMedia>
								<EmptyTitle>No logs</EmptyTitle>
								<EmptyDescription>
									{Object.keys(searchParams).length > 0
										? "No logs match your filters. Adjust your search criteria."
										: "Logs appear here when messages are delivered."}
								</EmptyDescription>
							</EmptyHeader>
							{Object.keys(searchParams).length > 0 && (
								<Button variant="outline" onClick={resetFilters}>
									Clear filters
								</Button>
							)}
						</Empty>
					) : (
						<>
							<div className="min-w-0 overflow-x-auto -mx-1 px-1">
								<LogsTable
									logs={logs}
									isLoading={isLoading}
									sortBy={filters.sortBy}
									sortOrder={filters.sortOrder}
									onSort={handleSort}
								/>
							</div>

							{pagination && pagination.total > 0 && (
								<LogsPagination
									page={pagination.page}
									limit={pagination.limit}
									total={pagination.total}
									totalPages={pagination.totalPages}
									hasMore={pagination.hasMore}
									onPageChange={handlePageChange}
									onLimitChange={handleLimitChange}
								/>
							)}
						</>
					)}
				</div>
			</Frame>
		</div>
	);
}
