import type * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function ListEmpty({
	title,
	description,
	action,
	className,
	role,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	action?: React.ReactNode;
	className?: string;
	role?: "status";
}) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-5",
				className,
			)}
			data-slot="list-empty"
		>
			<div className="min-w-0 max-w-xl">
				<p className="font-medium text-foreground text-sm" role={role}>
					{title}
				</p>
				{description ? (
					<p className="mt-0.5 text-pretty text-muted-foreground text-sm leading-relaxed">
						{description}
					</p>
				) : null}
			</div>
			{action ? (
				<div className="flex shrink-0 items-center gap-2">{action}</div>
			) : null}
		</div>
	);
}

export function ListLoading({
	rows = 3,
	rowClassName = "h-10",
}: {
	rows?: number;
	rowClassName?: string;
}) {
	return (
		<div aria-busy="true" className="divide-y">
			{Array.from({ length: rows }, (_, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
				<div className="flex items-center gap-3 px-4 py-3" key={index}>
					<Skeleton className={cn("w-full rounded-md", rowClassName)} />
				</div>
			))}
		</div>
	);
}
