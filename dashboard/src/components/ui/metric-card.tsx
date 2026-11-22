import type * as React from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { Card } from "./card";
import { type ChartConfig, ChartContainer } from "./chart";
import { Skeleton } from "./skeleton";

interface MetricCardProps {
	title: string;
	value: string | number;
	subtitle?: string;
	chartData?: Array<{ value: number }>;
	chartColor?: string;
	isLoading?: boolean;
	className?: string;
	valueClassName?: string;
	info?: React.ReactNode;
	showChart?: boolean;
	showValue?: boolean;
	footer?: React.ReactNode;
}

export function MetricCard({
	title,
	value,
	subtitle,
	chartData,
	chartColor = "hsl(var(--chart-1))",
	isLoading = false,
	className,
	valueClassName,
	info,
	showChart = true,
	showValue = true,
	footer,
}: MetricCardProps) {
	const transformedChartData =
		chartData?.map((item, index) => ({
			name: `item-${index}`,
			value: item.value,
		})) || [];

	const colorValue = chartColor.match(/var\(--chart-\d+\)/)?.[0] || chartColor;

	const chartConfig = {
		value: {
			label: "Value",
			color: colorValue,
		},
	} satisfies ChartConfig;

	return (
		<Card className={cn("relative gap-0 overflow-hidden p-0", className)}>
			<div className="flex flex-1 flex-col p-4">
				<div className="mb-2 flex items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-2">
						<p className="truncate font-medium text-muted-foreground text-xs uppercase tracking-wide">
							{title}
						</p>
					</div>
					{info && <div className="text-muted-foreground">{info}</div>}
				</div>

				{isLoading ? (
					<Skeleton className="h-7 w-20 mb-1.5" />
				) : (
					<p
						className={cn(
							"mb-1 font-semibold text-[1.75rem] leading-tight tracking-tight tabular-nums",
							valueClassName,
						)}
					>
						{typeof value === "number" ? value.toLocaleString() : value}
					</p>
				)}

				{chartData && chartData.length > 0 && showChart && !isLoading && (
					<div className="h-[52px] -mx-1 -mb-1 mt-1">
						<ChartContainer config={chartConfig} className="h-full w-full">
							<BarChart
								accessibilityLayer
								data={transformedChartData}
								margin={{
									left: 0,
									right: 0,
									top: 4,
									bottom: 0,
								}}
							>
								<CartesianGrid vertical={false} horizontal={false} />
								<XAxis dataKey="name" hide tickLine={false} axisLine={false} />
								<YAxis hide domain={[0, "dataMax"]} />
								<Bar
									dataKey="value"
									fill="var(--color-value)"
									radius={[3, 3, 0, 0]}
									opacity={0.85}
								/>
							</BarChart>
						</ChartContainer>
					</div>
				)}
				{isLoading && <Skeleton className="h-[20px] w-full mb-1.5" />}

				{subtitle && showValue && (
					<p className="text-muted-foreground text-xs">{subtitle}</p>
				)}
			</div>
			{footer ? (
				<div className="flex items-center border-t px-4 py-2.5">{footer}</div>
			) : null}
		</Card>
	);
}
