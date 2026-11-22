import {
	CheckCircle2,
	Clock,
	RefreshCw,
	TrendingDown,
	XCircle,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { LogsStats } from "@/lib/types";

interface LogsStatsBarProps {
	stats: LogsStats | undefined;
	isLoading: boolean;
	total: number;
}

export function LogsStatsBar({ stats, isLoading, total }: LogsStatsBarProps) {
	if (isLoading) {
		return <Skeleton className="h-[86px] rounded-lg" />;
	}

	const statItems = [
		{
			label: "Total",
			value: total.toLocaleString(),
			icon: Clock,
			color: "text-muted-foreground",
			emphasis: false,
		},
		{
			label: "Success",
			value: stats?.totalSuccess.toLocaleString() ?? "0",
			icon: CheckCircle2,
			color: "text-success",
			emphasis: false,
		},
		{
			label: "Errors",
			value: stats?.totalError.toLocaleString() ?? "0",
			icon: XCircle,
			color: "text-destructive",
			emphasis: (stats?.totalError ?? 0) > 0,
		},
		{
			label: "Retries",
			value: stats?.totalRetry.toLocaleString() ?? "0",
			icon: RefreshCw,
			color: "text-warning",
			emphasis: false,
		},
		{
			label: "Avg latency",
			value: stats?.avgDuration ? `${stats.avgDuration}ms` : "0ms",
			icon: TrendingDown,
			color: "text-info",
			emphasis: false,
		},
	];

	return (
		<div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border shadow-xs md:grid-cols-5">
			{statItems.map((item) => (
				<div
					key={item.label}
					className="bg-card px-4 py-3 last:max-md:col-span-2 md:py-3.5"
				>
					<div className="mb-1 flex items-center gap-2">
						<item.icon className={`size-3.5 ${item.color}`} />
						<span className="text-muted-foreground text-xs">{item.label}</span>
					</div>
					<div
						className={`font-semibold text-2xl tabular-nums tracking-tight ${item.emphasis ? "text-destructive" : "text-foreground"}`}
					>
						{item.value}
					</div>
					{item.label === "Total" && stats && (
						<div className="text-xs text-muted-foreground tabular-nums mt-1">
							{stats.errorRate.toFixed(1)}% error rate
						</div>
					)}
				</div>
			))}
		</div>
	);
}
