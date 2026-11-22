import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type * as React from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type {
	AgentAnalytics,
	OverviewAnalytics,
	TrustControlAnalytics,
} from "@/lib/types";
import { MetricStrip, MetricStripSkeleton, Panel } from "./frames";

interface PanelProps<T> {
	data: T | undefined;
	isLoading: boolean;
	isError: boolean;
}

type AttentionItem = OverviewAnalytics["attention"][number];

const count = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact" });
const money = new Intl.NumberFormat(undefined, {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 2,
});

const outcomeConfig = {
	succeeded: { label: "Succeeded", color: "var(--success)" },
	approved: { label: "Approved", color: "var(--success)" },
	failed: { label: "Failed", color: "var(--destructive)" },
	denied: { label: "Denied", color: "var(--destructive)" },
	expired: { label: "Expired", color: "var(--warning)" },
	pending: { label: "Pending", color: "var(--warning)" },
	running: { label: "Running", color: "var(--info)" },
	cancelled: { label: "Cancelled", color: "var(--muted-foreground)" },
	total: {
		label: "Total",
		theme: { light: "var(--chart-3)", dark: "var(--chart-1)" },
	},
} satisfies ChartConfig;

type OutcomeKey = keyof typeof outcomeConfig;

const GOVERNED_ATTENTION = new Set<AttentionItem["product"]>([
	"agents",
	"actions",
	"approvals",
]);

function formatDuration(value: number) {
	if (value < 1000) return `${Math.round(value)} ms`;
	return `${(value / 1000).toFixed(1)} s`;
}

function formatPeriod(value: string, includeYear = false) {
	if (/^\d{4}-W\d{2}$/.test(value)) {
		const [year, week] = value.split("-W");
		return includeYear ? `Week ${week}, ${year}` : `Week ${week}`;
	}

	const isHourly = value.includes(" ");
	const parsed = new Date(
		isHourly ? `${value.replace(" ", "T")}Z` : `${value}T00:00:00`,
	);
	if (Number.isNaN(parsed.getTime())) return value;

	return isHourly
		? parsed.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "numeric",
			})
		: parsed.toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
				year: includeYear ? "numeric" : undefined,
			});
}

function PanelState({
	isError,
	isLoading,
	metrics,
	charts = 0,
}: Pick<PanelProps<unknown>, "isError" | "isLoading"> & {
	metrics: number;
	charts?: number;
}) {
	if (isError) {
		return (
			<div
				className="flex items-start gap-3 rounded-lg border bg-card px-4 py-4 sm:px-5"
				role="alert"
			>
				<AlertTriangle
					aria-hidden="true"
					className="mt-0.5 size-4 shrink-0 text-warning"
				/>
				<div className="min-w-0 text-sm">
					<p className="font-medium">Analytics could not be loaded</p>
					<p className="text-muted-foreground">
						Refresh the page or try a shorter date range.
					</p>
				</div>
			</div>
		);
	}
	if (isLoading) {
		return (
			<div aria-busy="true" className="flex flex-col gap-4">
				<MetricStripSkeleton count={metrics} />
				{charts > 0 ? (
					<div className="grid gap-4 xl:grid-cols-2">
						{Array.from({ length: charts }, (_, index) => (
							<Skeleton
								className={
									charts === 1
										? "h-72 rounded-lg xl:col-span-2"
										: "h-72 rounded-lg"
								}
								// biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
								key={index}
							/>
						))}
					</div>
				) : null}
			</div>
		);
	}
	return null;
}

function OutcomeChart({
	data,
	series,
}: {
	data: Array<Record<string, string | number>>;
	series: OutcomeKey[];
}) {
	if (!data.length) {
		return <EmptyChart label="No activity in this range." />;
	}

	return (
		<ChartContainer className="h-60 w-full" config={outcomeConfig}>
			<AreaChart data={data} margin={{ left: 4, right: 8, top: 4 }}>
				<CartesianGrid strokeDasharray="2 4" vertical={false} />
				<XAxis
					axisLine={false}
					dataKey="period"
					fontSize={11}
					minTickGap={28}
					tickFormatter={(value: string) => formatPeriod(value)}
					tickLine={false}
					tickMargin={8}
				/>
				<YAxis
					allowDecimals={false}
					axisLine={false}
					fontSize={11}
					tickFormatter={(value: number) => compact.format(value)}
					tickLine={false}
					width={36}
				/>
				<ChartTooltip
					content={
						<ChartTooltipContent
							indicator="dot"
							labelFormatter={(value) => formatPeriod(String(value), true)}
						/>
					}
				/>
				{series.map((key, index) => (
					<Area
						dataKey={key}
						fill={`var(--color-${key})`}
						fillOpacity={index === 0 ? 0.2 : 0.12}
						key={key}
						stackId="outcomes"
						stroke={`var(--color-${key})`}
						strokeWidth={1.5}
						type="monotone"
					/>
				))}
				<ChartLegend content={<ChartLegendContent />} />
			</AreaChart>
		</ChartContainer>
	);
}

function EmptyChart({ label }: { label: string }) {
	return (
		<div className="flex h-60 items-center justify-center text-muted-foreground text-sm">
			{label}
		</div>
	);
}

function EmptyTableRow({ colSpan, label }: { colSpan: number; label: string }) {
	return (
		<TableRow className="hover:bg-transparent">
			<TableCell
				className="py-6! text-center text-muted-foreground"
				colSpan={colSpan}
			>
				{label}
			</TableCell>
		</TableRow>
	);
}

function NumberHead({ children }: { children: React.ReactNode }) {
	return <TableHead className="text-right">{children}</TableHead>;
}

function NumberCell({ children }: { children: React.ReactNode }) {
	return (
		<TableCell className="text-right text-muted-foreground tabular-nums">
			{children}
		</TableCell>
	);
}

export function OverviewPanel({
	data,
	isError,
	isLoading,
	renderOpen,
}: PanelProps<OverviewAnalytics> & {
	renderOpen?: (item: AttentionItem) => React.ReactNode;
}) {
	if (!data)
		return <PanelState isError={isError} isLoading={isLoading} metrics={3} />;
	const attention = data.attention.filter((item) =>
		GOVERNED_ATTENTION.has(item.product),
	);

	return (
		<div className="flex flex-col gap-4">
			<MetricStrip
				items={[
					{
						label: "Agent runs",
						value: data.summary.agentRuns,
						detail: `${data.summary.agentRunSuccessRate}% success`,
					},
					{
						label: "Action invocations",
						value: data.summary.actionInvocations,
						detail: `${data.summary.actionSuccessRate}% success`,
					},
					{
						label: "Pending approvals",
						value: data.summary.pendingApprovals,
						detail: "Needs review",
					},
				]}
				label="Summary"
			/>
			<Panel
				description="Failed runs, failed invocations and pending approvals."
				flush
				title="Needs attention"
			>
				{attention.length ? (
					<ul className="divide-y">
						{attention.map((item) => (
							<li
								className="flex items-center gap-4 px-4 py-2.5 sm:px-5"
								key={`${item.product}-${item.label}`}
							>
								<span className="inline-flex h-6 min-w-8 shrink-0 items-center justify-center rounded-md bg-muted px-2 font-semibold text-[13px] tabular-nums">
									{count.format(item.count)}
								</span>
								<div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
									<p className="truncate font-medium text-sm">{item.label}</p>
									<p className="text-muted-foreground text-xs capitalize">
										{item.product}
									</p>
								</div>
								{renderOpen ? renderOpen(item) : null}
							</li>
						))}
					</ul>
				) : (
					<p className="flex items-center gap-2 px-4 py-4 text-muted-foreground text-sm sm:px-5">
						<CheckCircle2 aria-hidden="true" className="size-4 text-success" />
						No failures or pending approvals in this range.
					</p>
				)}
			</Panel>
		</div>
	);
}

export function AgentsPanel({
	data,
	isError,
	isLoading,
}: PanelProps<AgentAnalytics>) {
	if (!data)
		return (
			<PanelState
				charts={1}
				isError={isError}
				isLoading={isLoading}
				metrics={5}
			/>
		);
	return (
		<div className="flex flex-col gap-4">
			<MetricStrip
				items={[
					{
						label: "Runs",
						value: data.summary.totalRuns,
						detail: `${data.summary.runningRuns} running`,
					},
					{
						label: "Success rate",
						value: `${data.summary.successRate}%`,
						detail: `${data.summary.failedRuns} failed`,
					},
					{
						label: "P95 duration",
						value: formatDuration(data.summary.p95DurationMs),
						detail: `P50 ${formatDuration(data.summary.p50DurationMs)}`,
					},
					{
						label: "Tokens",
						value: compact.format(data.summary.totalTokens),
						detail: "Across all runs",
					},
					{
						label: "Cost",
						value: money.format(data.summary.totalCost),
						detail: "Recorded model cost",
					},
				]}
				label="Agent runs"
			/>
			<Panel title="Agent run outcomes">
				<OutcomeChart
					data={data.series}
					series={["succeeded", "failed", "running", "cancelled"]}
				/>
			</Panel>
			<Panel
				description="Highest run volume in this range."
				flush
				title="Top agents"
			>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Agent</TableHead>
							<NumberHead>Runs</NumberHead>
							<NumberHead>Failed</NumberHead>
							<NumberHead>Success</NumberHead>
							<NumberHead>Tokens</NumberHead>
							<NumberHead>Cost</NumberHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{data.topAgents.length ? (
							data.topAgents.map((agent) => (
								<TableRow key={agent.agentId ?? agent.name}>
									<TableCell className="font-medium">{agent.name}</TableCell>
									<NumberCell>{count.format(agent.totalRuns)}</NumberCell>
									<NumberCell>{count.format(agent.failedRuns)}</NumberCell>
									<NumberCell>{agent.successRate}%</NumberCell>
									<NumberCell>{compact.format(agent.totalTokens)}</NumberCell>
									<NumberCell>{money.format(agent.totalCost)}</NumberCell>
								</TableRow>
							))
						) : (
							<EmptyTableRow colSpan={6} label="No agent runs in this range." />
						)}
					</TableBody>
				</Table>
			</Panel>
		</div>
	);
}

export function TrustControlPanel({
	data,
	isError,
	isLoading,
}: PanelProps<TrustControlAnalytics>) {
	if (!data)
		return (
			<PanelState
				charts={2}
				isError={isError}
				isLoading={isLoading}
				metrics={4}
			/>
		);
	return (
		<div className="flex flex-col gap-4">
			<MetricStrip
				items={[
					{
						label: "Action invocations",
						value: data.actions.summary.totalInvocations,
						detail: `${data.actions.summary.successRate}% success`,
					},
					{
						label: "Approval gated",
						value: `${data.actions.summary.approvalGatedRate}%`,
						detail: `${data.actions.summary.deniedInvocations} denied actions`,
					},
					{
						label: "Approval requests",
						value: data.approvals.summary.totalRequests,
						detail: `${data.approvals.summary.pendingRequests} pending`,
					},
					{
						label: "Approval rate",
						value: `${data.approvals.summary.approvalRate}%`,
						detail: `P95 decision ${formatDuration(data.approvals.summary.p95DecisionMs)}`,
					},
				]}
				label="Actions and approvals"
			/>
			<div className="grid gap-4 xl:grid-cols-2">
				<Panel title="Action outcomes">
					<OutcomeChart
						data={data.actions.series}
						series={["succeeded", "failed", "denied", "pending"]}
					/>
				</Panel>
				<Panel title="Approval outcomes">
					<OutcomeChart
						data={data.approvals.series}
						series={["approved", "denied", "expired", "pending"]}
					/>
				</Panel>
			</div>
			<div className="grid gap-4 xl:grid-cols-2">
				<Panel flush title="Top actions">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Action</TableHead>
								<NumberHead>Invocations</NumberHead>
								<NumberHead>Failed</NumberHead>
								<NumberHead>Success</NumberHead>
								<NumberHead>P95</NumberHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.actions.topActions.length ? (
								data.actions.topActions.map((action) => (
									<TableRow key={action.actionId}>
										<TableCell className="font-medium font-mono text-[13px]">
											{action.name}
										</TableCell>
										<NumberCell>
											{count.format(action.totalInvocations)}
										</NumberCell>
										<NumberCell>
											{count.format(action.failedInvocations)}
										</NumberCell>
										<NumberCell>{action.successRate}%</NumberCell>
										<NumberCell>
											{formatDuration(action.p95DurationMs)}
										</NumberCell>
									</TableRow>
								))
							) : (
								<EmptyTableRow
									colSpan={5}
									label="No action invocations in this range."
								/>
							)}
						</TableBody>
					</Table>
				</Panel>
				<Panel flush title="Top approval policies">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Policy</TableHead>
								<NumberHead>Requests</NumberHead>
								<NumberHead>Approved</NumberHead>
								<NumberHead>Denied</NumberHead>
								<NumberHead>Expired</NumberHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.approvals.topPolicies.length ? (
								data.approvals.topPolicies.map((policy) => (
									<TableRow key={policy.policyId ?? policy.name}>
										<TableCell className="font-medium">{policy.name}</TableCell>
										<NumberCell>
											{count.format(policy.totalRequests)}
										</NumberCell>
										<NumberCell>
											{count.format(policy.approvedRequests)}
										</NumberCell>
										<NumberCell>
											{count.format(policy.deniedRequests)}
										</NumberCell>
										<NumberCell>
											{count.format(policy.expiredRequests)}
										</NumberCell>
									</TableRow>
								))
							) : (
								<EmptyTableRow
									colSpan={5}
									label="No approval requests in this range."
								/>
							)}
						</TableBody>
					</Table>
				</Panel>
			</div>
		</div>
	);
}
