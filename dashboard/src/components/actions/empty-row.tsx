import type * as React from "react";
import { cn } from "@/lib/utils";

export function EmptyRow({
	title,
	children,
	action,
	className,
}: {
	title: React.ReactNode;
	children?: React.ReactNode;
	action?: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center justify-between gap-x-6 gap-y-3",
				className,
			)}
		>
			<p className="min-w-0 max-w-2xl flex-1 basis-72 text-pretty text-muted-foreground text-sm leading-relaxed">
				<span className="font-medium text-foreground">{title}</span>
				{children ? <>. {children}</> : null}
			</p>
			{action ? (
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					{action}
				</div>
			) : null}
		</div>
	);
}
