import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, RotateCw } from "lucide-react";
import { useMemo, useState } from "react";
import {
	AgentsPanel,
	OverviewPanel,
	TrustControlPanel,
} from "@/components/analytics/analytics-panels";
import { OnboardAgentPill } from "@/components/dashboard/onboard-agent-pill";
import { StartHere } from "@/components/first-run/start-here";
import { Page, PageHeader, PageTabs } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useWorkspace } from "@/contexts/workspace-context";
import {
	useAgentAnalytics,
	useOverviewAnalytics,
	useTrustControlAnalytics,
} from "@/hooks/api/use-analytics";
import { useEnvironments } from "@/hooks/api/use-environments";
import { requireFeature } from "@/lib/feature-flags";
import type { AnalyticsQuery, OverviewAnalytics } from "@/lib/types";

type AnalyticsTab = "overview" | "agents" | "trust-control";
type AnalyticsRange = "7d" | "30d" | "90d";

interface AnalyticsSearch {
	tab?: AnalyticsTab;
	range?: AnalyticsRange;
	environmentId?: string;
}

function analyticsTab(value: unknown): AnalyticsTab | undefined {
	return value === "overview" || value === "agents" || value === "trust-control"
		? value
		: undefined;
}

function analyticsRange(value: unknown): AnalyticsRange | undefined {
	return value === "7d" || value === "30d" || value === "90d"
		? value
		: undefined;
}

export const Route = createFileRoute("/_protected/analytics")({
	beforeLoad: () => requireFeature("analytics"),
	validateSearch: (search: Record<string, unknown>): AnalyticsSearch => ({
		tab: analyticsTab(search.tab),
		range: analyticsRange(search.range),
		environmentId:
			typeof search.environmentId === "string"
				? search.environmentId
				: undefined,
	}),
	component: AnalyticsPage,
});

const RANGES = ["7d", "30d", "90d"] as const;

function OpenAttention({
	item,
}: {
	item: OverviewAnalytics["attention"][number];
}) {
	const className =
		"inline-flex shrink-0 items-center gap-1 rounded-sm text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
	const label = (
		<>
			Open
			<ArrowRight aria-hidden="true" className="size-3" />
			<span className="sr-only"> {item.label}</span>
		</>
	);
	if (item.product === "agents")
		return (
			<Link
				className={className}
				search={{ run: undefined, search: undefined, view: "tree" }}
				to="/recent-runs"
			>
				{label}
			</Link>
		);
	if (item.product === "actions")
		return (
			<Link
				className={className}
				search={{ invocation: undefined, status: "failed" }}
				to="/actions/invocations"
			>
				{label}
			</Link>
		);
	if (item.product === "approvals")
		return (
			<Link className={className} to="/approvals">
				{label}
			</Link>
		);
	return null;
}

function AnalyticsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const activeTab = search.tab ?? "overview";
	const activeRange = search.range ?? "30d";
	const environments = useEnvironments(workspaceId);
	const [queryUpdatedAt, setQueryUpdatedAt] = useState(Date.now);

	const query = useMemo<AnalyticsQuery>(() => {
		const end = new Date(queryUpdatedAt);
		const start = new Date(end);
		const days = activeRange === "7d" ? 7 : activeRange === "90d" ? 90 : 30;
		start.setUTCDate(start.getUTCDate() - days);
		return {
			startDate: start.toISOString(),
			endDate: end.toISOString(),
			granularity: days <= 7 ? "hour" : "day",
			environmentId: search.environmentId,
			limit: 10,
		};
	}, [activeRange, queryUpdatedAt, search.environmentId]);

	const overview = useOverviewAnalytics(
		workspaceId,
		query,
		activeTab === "overview",
	);
	const agents = useAgentAnalytics(workspaceId, query, activeTab === "agents");
	const trust = useTrustControlAnalytics(
		workspaceId,
		query,
		activeTab === "trust-control",
	);

	const activeQuery =
		activeTab === "overview"
			? overview
			: activeTab === "agents"
				? agents
				: trust;
	const metadata = activeQuery.data?.range;

	const updateSearch = (next: Partial<AnalyticsSearch>) => {
		setQueryUpdatedAt(Date.now());
		return navigate({
			to: "/analytics",
			search: (previous) => ({ ...previous, ...next }),
			replace: true,
		});
	};

	const environmentItems = [
		{ value: "all", label: "All environments" },
		...(environments.data ?? []).map((environment) => ({
			value: environment.id,
			label: environment.name,
		})),
	];

	const tabSearch = (tab: AnalyticsTab | undefined) => ({
		tab,
		range: search.range,
		environmentId: search.environmentId,
	});

	return (
		<Page>
			<PageHeader
				actions={
					<>
						<Select
							items={environmentItems}
							onValueChange={(value) =>
								updateSearch({
									environmentId:
										typeof value === "string" && value !== "all"
											? value
											: undefined,
								})
							}
							value={search.environmentId ?? "all"}
						>
							<SelectTrigger
								aria-label="Environment"
								className="h-8 w-44 min-w-0"
								size="sm"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{environmentItems.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<fieldset className="m-0 flex h-8 items-center gap-0.5 rounded-lg border-0 bg-muted p-0.5">
							<legend className="sr-only">Date range</legend>
							{RANGES.map((range) => (
								<button
									aria-pressed={activeRange === range}
									className="h-7 rounded-md px-2.5 font-medium text-muted-foreground text-xs tabular-nums outline-none transition-[background-color,color,box-shadow] duration-150 ease-out hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm dark:aria-pressed:bg-accent"
									key={range}
									onClick={() => updateSearch({ range })}
									type="button"
								>
									{range}
								</button>
							))}
						</fieldset>
						<Button
							aria-label="Refresh analytics"
							className="size-8"
							loading={activeQuery.isFetching}
							onClick={() => setQueryUpdatedAt(Date.now())}
							size="icon-sm"
							variant="outline"
						>
							<RotateCw />
						</Button>
					</>
				}
				description="How your agents are doing over time: their calls, the approvals they waited on, and their runs."
				meta={
					metadata?.truncated ? (
						<Badge variant="warning">Range limited by plan</Badge>
					) : metadata?.retentionDays ? (
						<Badge variant="outline">
							{metadata.retentionDays}-day analytics range
						</Badge>
					) : null
				}
				title="Overview"
			>
				<OnboardAgentPill />
			</PageHeader>

			<div className="empty:hidden">
				<StartHere workspaceId={workspaceId} />
			</div>

			<div className="flex flex-col gap-5">
				<PageTabs
					items={[
						{
							label: "Summary",
							to: "/analytics",
							search: tabSearch(undefined),
							match: {
								key: "tab",
								value: search.tab === "overview" ? "overview" : undefined,
							},
						},
						{
							label: "Agents",
							to: "/analytics",
							search: tabSearch("agents"),
							match: { key: "tab", value: "agents" },
						},
						{
							label: "Actions and approvals",
							to: "/analytics",
							search: tabSearch("trust-control"),
							match: { key: "tab", value: "trust-control" },
						},
					]}
					label="Overview views"
				/>
				{activeTab === "overview" ? (
					<OverviewPanel
						data={overview.data}
						isError={overview.isError}
						isLoading={overview.isLoading}
						renderOpen={(item) => <OpenAttention item={item} />}
					/>
				) : activeTab === "agents" ? (
					<AgentsPanel
						data={agents.data}
						isError={agents.isError}
						isLoading={agents.isLoading}
					/>
				) : (
					<TrustControlPanel
						data={trust.data}
						isError={trust.isError}
						isLoading={trust.isLoading}
					/>
				)}
			</div>
		</Page>
	);
}
