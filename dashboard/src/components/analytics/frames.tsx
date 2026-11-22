import type * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type Metric = {
	label: string;
	value: React.ReactNode;
	detail?: React.ReactNode;
};

const COLUMNS: Record<number, string> = {
	3: "grid-cols-1 sm:grid-cols-3",
	4: "grid-cols-2 xl:grid-cols-4",
	5: "grid-cols-2 md:grid-cols-3 xl:grid-cols-5",
};

export function MetricStrip({
	items,
	label,
	className,
}: {
	items: Metric[];
	label: string;
	className?: string;
}) {
	return (
		<dl
			aria-label={label}
			className={cn(
				"grid overflow-hidden rounded-lg border bg-card",
				COLUMNS[items.length] ?? "grid-cols-2 lg:grid-cols-4",
				className,
			)}
			data-slot="metric-strip"
		>
			{items.map((item) => (
				<div
					className="flex min-w-0 flex-col gap-1 px-4 py-3.5 shadow-[1px_0_0_0_var(--border),0_1px_0_0_var(--border)] sm:px-5 sm:py-4"
					key={item.label}
				>
					<dt className="truncate text-[12.5px] text-muted-foreground">
						{item.label}
					</dt>
					<dd className="truncate font-semibold text-[1.625rem] text-foreground leading-tight tracking-tight tabular-nums">
						{typeof item.value === "number"
							? item.value.toLocaleString()
							: item.value}
					</dd>
					{item.detail ? (
						<dd className="truncate text-muted-foreground text-xs tabular-nums">
							{item.detail}
						</dd>
					) : null}
				</div>
			))}
		</dl>
	);
}

export function MetricStripSkeleton({ count }: { count: number }) {
	return (
		<div
			aria-hidden="true"
			className={cn(
				"grid overflow-hidden rounded-lg border bg-card",
				COLUMNS[count] ?? "grid-cols-2 lg:grid-cols-4",
			)}
		>
			{Array.from({ length: count }, (_, index) => (
				<div
					className="flex flex-col gap-2 px-4 py-4 shadow-[1px_0_0_0_var(--border),0_1px_0_0_var(--border)] sm:px-5"
					// biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
					key={index}
				>
					<Skeleton className="h-3 w-20" />
					<Skeleton className="h-7 w-16" />
					<Skeleton className="h-3 w-24" />
				</div>
			))}
		</div>
	);
}

export function Panel({
	title,
	description,
	actions,
	flush = false,
	className,
	children,
}: {
	title: string;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	flush?: boolean;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<section
			aria-label={title}
			className={cn(
				"flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card",
				className,
			)}
		>
			<header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-3.5 pb-3 sm:px-5">
				<div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
					<h3 className="font-medium text-[13.5px] text-foreground">{title}</h3>
					{description ? (
						<p className="text-[12.5px] text-muted-foreground">{description}</p>
					) : null}
				</div>
				{actions ? (
					<div className="flex shrink-0 items-center gap-2">{actions}</div>
				) : null}
			</header>
			<div
				className={cn(
					"min-w-0 flex-1",
					flush
						? "border-t [&_[data-slot=table-cell]:first-child]:ps-4 sm:[&_[data-slot=table-cell]:first-child]:ps-5 [&_[data-slot=table-cell]:last-child]:pe-4 sm:[&_[data-slot=table-cell]:last-child]:pe-5 [&_[data-slot=table-cell]]:py-2.5 [&_[data-slot=table-head]:first-child]:ps-4 sm:[&_[data-slot=table-head]:first-child]:ps-5 [&_[data-slot=table-head]:last-child]:pe-4 sm:[&_[data-slot=table-head]:last-child]:pe-5 [&_[data-slot=table-head]]:h-9 [&_thead_tr]:bg-muted/40 [&_thead_tr]:hover:bg-muted/40"
						: "px-2 pb-3 sm:px-3",
				)}
			>
				{children}
			</div>
		</section>
	);
}
