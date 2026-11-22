import { createFileRoute } from "@tanstack/react-router";
import {
	AlertTriangle,
	CheckCircle2,
	TrendingDown,
	TrendingUp,
	XCircle,
} from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	ResponsiveContainer,
	XAxis,
	YAxis,
} from "recharts";
import { PlanAction } from "@/components/extension-slots";
import { UsageSummary } from "@/components/plan/usage-summary";
import {
	SettingsPage,
	SettingsSection,
} from "@/components/settings/settings-page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useWorkspace } from "@/contexts/workspace-context";
import {
	useErrorDistribution,
	useMessageAnalytics,
	useTimeSeriesData,
	useTopUrls,
} from "@/hooks/api/use-analytics";
import { useCurrentUsage, usePlanDetails } from "@/hooks/api/use-plan";
import { usePlanAccess } from "@/hooks/use-plan-access";
import type { Granularity } from "@/lib/types";

function isTimeRange(value: unknown): value is "7d" | "30d" | "90d" {
	return value === "7d" || value === "30d" || value === "90d";
}

function isGranularity(value: unknown): value is Granularity {
	return (
		value === "hour" || value === "day" || value === "week" || value === "month"
	);
}

export const Route = createFileRoute("/_protected/settings/usage")({
	component: UsagePage,
});

function UsagePage() {
	const { currentWorkspace } = useWorkspace();
	const {
		paidPlansAvailable,
		betaOnly,
		access: billingAccess,
	} = usePlanAccess(currentWorkspace?.id);
	const [timeRange, setTimeRange] = useState<"7d" | "30d" | "90d">("30d");
	const [granularity, setGranularity] = useState<Granularity>("day");

	const getDateRange = () => {
		const end = new Date();
		const start = new Date();
		switch (timeRange) {
			case "7d":
				start.setDate(end.getDate() - 7);
				break;
			case "30d":
				start.setDate(end.getDate() - 30);
				break;
			case "90d":
				start.setDate(end.getDate() - 90);
				break;
		}
		return {
			startDate: start.toISOString(),
			endDate: end.toISOString(),
		};
	};

	const dateRange = getDateRange();

	const { data: planDetails, isLoading: isLoadingPlan } = usePlanDetails(
		currentWorkspace?.id,
	);
	const { data: billingUsage, isLoading: isLoadingBilling } = useCurrentUsage(
		currentWorkspace?.id,
	);
	const { data: messageAnalytics, isLoading: isLoadingAnalytics } =
		useMessageAnalytics(currentWorkspace?.id, { ...dateRange });
	const { data: timeSeries, isLoading: isLoadingTimeSeries } =
		useTimeSeriesData(currentWorkspace?.id, { ...dateRange, granularity });
	const { data: topUrls } = useTopUrls(currentWorkspace?.id, {
		...dateRange,
		limit: 5,
	});
	const { data: errorDistribution } = useErrorDistribution(
		currentWorkspace?.id,
		{
			...dateRange,
			limit: 5,
		},
	);

	const formatNumber = (num: number | "unlimited") => {
		if (num === "unlimited") return "Unlimited";
		return new Intl.NumberFormat().format(num);
	};

	const formatBytes = (bytes: number) => {
		if (bytes === 0) return "0 B";
		const k = 1024;
		const sizes = ["B", "KB", "MB", "GB", "TB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
	};

	const getUsagePercentage = (used: number, limit: number | "unlimited") => {
		if (limit === "unlimited") return 0;
		return Math.min((used / limit) * 100, 100);
	};

	const getUsageColor = (percentage: number) => {
		if (percentage >= 90) return "text-red-500";
		if (percentage >= 75) return "text-yellow-500";
		return "text-green-500";
	};

	const chartData =
		timeSeries?.map((item) => ({
			date: new Date(item.period).toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
			}),
			delivered: item.delivered,
			failed: item.failed,
			pending: 0,
			total: item.published,
		})) || [];
	const totalErrors =
		errorDistribution?.reduce((total, error) => total + error.count, 0) ?? 0;

	const dailyUsage = billingUsage?.dailyMessages || 0;
	const dailyLimit = planDetails?.limits.maxMessagesPerDay ?? "unlimited";
	const dailyPercentage = getUsagePercentage(dailyUsage, dailyLimit);

	const monthlyUsage = billingUsage?.currentMonthMessages || 0;
	const monthlyLimit = planDetails?.limits.maxMonthlyMessages ?? 10000;
	const monthlyPercentage = getUsagePercentage(monthlyUsage, monthlyLimit);

	const bandwidthUsage = billingUsage?.currentMonthBandwidth || 0;
	const bandwidthLimit =
		planDetails?.limits.maxMonthlyBandwidth ?? 50 * 1024 * 1024 * 1024;
	const bandwidthPercentage = getUsagePercentage(
		bandwidthUsage,
		bandwidthLimit,
	);

	const hasOtherUsage =
		dailyUsage > 0 ||
		monthlyUsage > 0 ||
		bandwidthUsage > 0 ||
		(messageAnalytics?.total ?? 0) > 0;

	return (
		<SettingsPage
			title="Usage"
			description="What this workspace has used in the current period, against its allowances."
			width="wide"
		>
			{currentWorkspace && (
				<UsageSummary
					workspaceId={currentWorkspace.id}
					beta={
						betaOnly && billingAccess
							? { usageResetsAt: billingAccess.usageResetsAt }
							: undefined
					}
				/>
			)}
			{hasOtherUsage ? (
				<SettingsSection
					title="Other usage in detail"
					description="The figures below count messages and their bandwidth. Action executions are in the summary above."
					actions={
						<Select
							value={timeRange}
							onValueChange={(value) => {
								if (isTimeRange(value)) setTimeRange(value);
							}}
						>
							<SelectTrigger className="w-36" aria-label="Time range">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="7d">Last 7 days</SelectItem>
								<SelectItem value="30d">Last 30 days</SelectItem>
								<SelectItem value="90d">Last 90 days</SelectItem>
							</SelectContent>
						</Select>
					}
				>
					<div className="flex flex-col gap-10">
						<div className="grid gap-x-10 gap-y-6 md:grid-cols-3">
							<QuotaMeter
								label="Daily messages"
								loading={isLoadingBilling || isLoadingPlan}
								percentage={dailyPercentage}
								used={formatNumber(dailyUsage)}
								limit={formatNumber(dailyLimit)}
								colorClass={getUsageColor(dailyPercentage)}
							/>
							<QuotaMeter
								label="Monthly messages"
								loading={isLoadingBilling || isLoadingPlan}
								percentage={monthlyPercentage}
								used={formatNumber(monthlyUsage)}
								limit={formatNumber(monthlyLimit)}
								colorClass={getUsageColor(monthlyPercentage)}
							/>
							<QuotaMeter
								label="Bandwidth"
								loading={isLoadingBilling || isLoadingPlan}
								percentage={bandwidthPercentage}
								used={formatBytes(bandwidthUsage)}
								limit={formatBytes(bandwidthLimit)}
								colorClass={getUsageColor(bandwidthPercentage)}
							/>
						</div>

						{(dailyPercentage >= 75 || monthlyPercentage >= 75) && (
							<Alert variant="warning">
								<AlertTriangle aria-hidden="true" />
								<AlertTitle>Approaching quota limit</AlertTitle>
								<AlertDescription>
									<p>
										{Math.max(dailyPercentage, monthlyPercentage).toFixed(0)}%
										of quota used.{" "}
										{paidPlansAvailable
											? "Upgrade to avoid interruptions."
											: billingAccess
												? `Monthly allowances reset on ${new Date(billingAccess.usageResetsAt).toLocaleDateString(undefined, { dateStyle: "long", timeZone: "UTC" })} (UTC). Nothing is charged automatically.`
												: "Nothing is charged automatically."}
									</p>
									<PlanAction site="usage-alert" />
								</AlertDescription>
							</Alert>
						)}

						<dl className="grid grid-cols-2 gap-x-10 gap-y-6 md:grid-cols-4">
							<Stat label="Total messages" loading={isLoadingAnalytics}>
								{formatNumber(messageAnalytics?.total || 0)}
							</Stat>
							<Stat
								label={
									<>
										<CheckCircle2
											aria-hidden="true"
											className="size-3.5 text-green-500"
										/>
										Delivered
									</>
								}
								loading={isLoadingAnalytics}
							>
								<span className="text-green-600">
									{formatNumber(messageAnalytics?.delivered || 0)}
								</span>
							</Stat>
							<Stat
								label={
									<>
										<XCircle
											aria-hidden="true"
											className="size-3.5 text-red-500"
										/>
										Failed
									</>
								}
								loading={isLoadingAnalytics}
							>
								<span className="text-red-600">
									{formatNumber(messageAnalytics?.failed || 0)}
								</span>
							</Stat>
							<Stat label="Success rate" loading={isLoadingAnalytics}>
								<span className="flex items-center gap-2">
									{(messageAnalytics?.successRate || 0).toFixed(1)}%
									{(messageAnalytics?.successRate || 0) >= 95 ? (
										<TrendingUp
											aria-hidden="true"
											className="size-4 text-green-500"
										/>
									) : (
										<TrendingDown
											aria-hidden="true"
											className="size-4 text-red-500"
										/>
									)}
								</span>
							</Stat>
						</dl>

						<Tabs defaultValue="volume" className="gap-4">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<TabsList>
									<TabsTrigger value="volume">Message volume</TabsTrigger>
									<TabsTrigger value="status">Status breakdown</TabsTrigger>
								</TabsList>
								<Select
									value={granularity}
									onValueChange={(value) => {
										if (isGranularity(value)) setGranularity(value);
									}}
								>
									<SelectTrigger className="w-28" aria-label="Granularity">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="hour">Hourly</SelectItem>
										<SelectItem value="day">Daily</SelectItem>
										<SelectItem value="week">Weekly</SelectItem>
										<SelectItem value="month">Monthly</SelectItem>
									</SelectContent>
								</Select>
							</div>

							<TabsContent value="volume">
								<ChartFrame
									title="Message volume"
									description="Messages sent over time."
								>
									{isLoadingTimeSeries ? (
										<Skeleton className="h-[300px] w-full" />
									) : chartData.length > 0 ? (
										<div className="h-[300px]">
											<ResponsiveContainer width="100%" height="100%">
												<AreaChart data={chartData}>
													<defs>
														<linearGradient
															id="colorDelivered"
															x1="0"
															y1="0"
															x2="0"
															y2="1"
														>
															<stop
																offset="5%"
																stopColor="#22c55e"
																stopOpacity={0.3}
															/>
															<stop
																offset="95%"
																stopColor="#22c55e"
																stopOpacity={0}
															/>
														</linearGradient>
														<linearGradient
															id="colorFailed"
															x1="0"
															y1="0"
															x2="0"
															y2="1"
														>
															<stop
																offset="5%"
																stopColor="#ef4444"
																stopOpacity={0.3}
															/>
															<stop
																offset="95%"
																stopColor="#ef4444"
																stopOpacity={0}
															/>
														</linearGradient>
													</defs>
													<XAxis dataKey="date" />
													<YAxis />
													<ChartTooltip content={<ChartTooltipContent />} />
													<Area
														type="monotone"
														dataKey="delivered"
														stroke="#22c55e"
														fillOpacity={1}
														fill="url(#colorDelivered)"
														name="Delivered"
													/>
													<Area
														type="monotone"
														dataKey="failed"
														stroke="#ef4444"
														fillOpacity={1}
														fill="url(#colorFailed)"
														name="Failed"
													/>
												</AreaChart>
											</ResponsiveContainer>
										</div>
									) : (
										<div className="flex h-[300px] items-center justify-center text-muted-foreground text-sm">
											No data for this range.
										</div>
									)}
								</ChartFrame>
							</TabsContent>

							<TabsContent value="status">
								<ChartFrame
									title="Status distribution"
									description="Breakdown of message statuses."
								>
									{isLoadingAnalytics ? (
										<Skeleton className="h-[300px] w-full" />
									) : messageAnalytics ? (
										<div className="h-[300px]">
											<ResponsiveContainer width="100%" height="100%">
												<BarChart
													data={[
														{
															name: "Delivered",
															value: messageAnalytics.delivered,
															fill: "#22c55e",
														},
														{
															name: "Failed",
															value: messageAnalytics.failed,
															fill: "#ef4444",
														},
														{
															name: "Pending",
															value: messageAnalytics.pending,
															fill: "#eab308",
														},
														{
															name: "Scheduled",
															value: messageAnalytics.scheduled,
															fill: "#3b82f6",
														},
														{
															name: "Cancelled",
															value: messageAnalytics.cancelled,
															fill: "#6b7280",
														},
													]}
													layout="vertical"
												>
													<XAxis type="number" />
													<YAxis dataKey="name" type="category" width={80} />
													<ChartTooltip content={<ChartTooltipContent />} />
													<Bar dataKey="value" radius={4} />
												</BarChart>
											</ResponsiveContainer>
										</div>
									) : (
										<div className="flex h-[300px] items-center justify-center text-muted-foreground text-sm">
											No data.
										</div>
									)}
								</ChartFrame>
							</TabsContent>
						</Tabs>

						<div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
							<div className="flex flex-col gap-4">
								<div>
									<h4 className="font-medium text-sm">Top destinations</h4>
									<p className="text-muted-foreground text-xs">
										Most frequently used endpoints.
									</p>
								</div>
								{topUrls && topUrls.length > 0 ? (
									<div className="space-y-4">
										{topUrls.map((url) => (
											<div key={url.url} className="space-y-1">
												<div className="flex items-center justify-between gap-3 text-sm">
													<span className="min-w-0 truncate" title={url.url}>
														{url.url}
													</span>
													<span className="font-medium tabular-nums">
														{formatNumber(url.messageCount)}
													</span>
												</div>
												<Progress
													value={(url.successCount / url.messageCount) * 100}
													className="h-1.5"
												/>
												<div className="flex justify-between text-muted-foreground text-xs tabular-nums">
													<span>{url.successCount} delivered</span>
													<span>{url.failureCount} failed</span>
												</div>
											</div>
										))}
									</div>
								) : (
									<p className="text-muted-foreground text-sm">No URL data.</p>
								)}
							</div>

							<div className="flex flex-col gap-4">
								<div>
									<h4 className="font-medium text-sm">Error distribution</h4>
									<p className="text-muted-foreground text-xs">
										Common error types.
									</p>
								</div>
								{errorDistribution && errorDistribution.length > 0 ? (
									<div className="space-y-4">
										{errorDistribution.map((error) => (
											<div key={error.errorMessage} className="space-y-1">
												<div className="flex items-center justify-between gap-3">
													<Badge variant="outline">{error.errorMessage}</Badge>
													<span className="font-medium text-sm tabular-nums">
														{formatNumber(error.count)} (
														{totalErrors > 0
															? ((error.count / totalErrors) * 100).toFixed(1)
															: "0.0"}
														%)
													</span>
												</div>
												<Progress
													value={
														totalErrors > 0
															? (error.count / totalErrors) * 100
															: 0
													}
													className="h-1.5"
												/>
											</div>
										))}
									</div>
								) : (
									<p className="flex items-center gap-2 text-muted-foreground text-sm">
										<CheckCircle2
											aria-hidden="true"
											className="size-4 text-green-500"
										/>
										No errors in this period.
									</p>
								)}
							</div>
						</div>
					</div>
				</SettingsSection>
			) : null}
		</SettingsPage>
	);
}

function QuotaMeter({
	label,
	loading,
	used,
	limit,
	percentage,
	colorClass,
}: {
	label: string;
	loading: boolean;
	used: string;
	limit: string;
	percentage: number;
	colorClass: string;
}) {
	return (
		<div className="flex min-w-0 flex-col">
			<p className="text-muted-foreground text-xs">{label}</p>
			{loading ? (
				<Skeleton className="mt-2 h-14 w-full" />
			) : (
				<>
					<p className="mt-1 flex items-baseline gap-2">
						<span className="font-semibold text-2xl tabular-nums tracking-tight">
							{used}
						</span>
						<span className="text-muted-foreground text-sm tabular-nums">
							/ {limit}
						</span>
					</p>
					<Progress value={percentage} className="mt-2.5 h-1.5" />
					<p
						className={`mt-1.5 flex items-center gap-1 text-xs tabular-nums ${colorClass}`}
					>
						{percentage >= 90 ? (
							<AlertTriangle aria-hidden="true" className="size-3" />
						) : (
							<CheckCircle2 aria-hidden="true" className="size-3" />
						)}
						{percentage.toFixed(1)}% used
					</p>
				</>
			)}
		</div>
	);
}

function Stat({
	label,
	loading,
	children,
}: {
	label: React.ReactNode;
	loading: boolean;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<dt className="flex items-center gap-1.5 text-muted-foreground text-xs">
				{label}
			</dt>
			<dd className="font-semibold text-2xl tabular-nums tracking-tight">
				{loading ? <Skeleton className="h-8 w-24" /> : children}
			</dd>
		</div>
	);
}

function ChartFrame({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: React.ReactNode;
}) {
	return (
		<figure className="flex flex-col gap-4 rounded-lg border bg-card p-5">
			<figcaption>
				<p className="font-medium text-sm">{title}</p>
				<p className="text-muted-foreground text-xs">{description}</p>
			</figcaption>
			{children}
		</figure>
	);
}
