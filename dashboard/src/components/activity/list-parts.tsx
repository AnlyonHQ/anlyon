import { ChevronLeft, ChevronRight } from "lucide-react";
import type * as React from "react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function ListMessage({
	title,
	children,
	action,
	tone = "default",
	className,
}: {
	title: React.ReactNode;
	children?: React.ReactNode;
	action?: React.ReactNode;
	tone?: "default" | "error";
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-5 text-sm",
				className,
			)}
			data-slot="list-message"
			role={tone === "error" ? "alert" : undefined}
		>
			<p className="min-w-0 max-w-2xl text-pretty">
				<span
					className={cn(
						"font-medium",
						tone === "error" ? "text-destructive" : "text-foreground",
					)}
				>
					{title}
				</span>
				{children ? (
					<span className="text-muted-foreground"> {children}</span>
				) : null}
			</p>
			{action ? (
				<div className="flex shrink-0 items-center gap-2">{action}</div>
			) : null}
		</div>
	);
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
	return (
		<div aria-busy="true" className="divide-y">
			<div className="h-9 bg-muted/40" />
			{Array.from({ length: rows }, (_, index) => (
				<div
					className="flex items-center gap-4 px-4 py-3"
					// biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
					key={index}
				>
					<Skeleton className="h-3.5 w-24" />
					<Skeleton className="h-3.5 flex-1" />
					<Skeleton className="hidden h-3.5 w-16 sm:block" />
					<Skeleton className="hidden h-3.5 w-20 sm:block" />
				</div>
			))}
		</div>
	);
}

export function Pager({
	offset,
	shown,
	total,
	hasMore,
	onPage,
	noun,
	pageSize,
}: {
	offset: number;
	shown: number;
	total: number | undefined;
	hasMore: boolean;
	onPage: (offset: number | undefined) => void;
	noun: [string, string];
	pageSize: number;
}) {
	const first = shown === 0 ? 0 : offset + 1;
	const last = offset + shown;
	const word = (total ?? shown) === 1 ? noun[0] : noun[1];
	return (
		<>
			<span className="tabular-nums">
				{offset === 0 && !hasMore
					? `${shown} ${word}`
					: `${first}–${last}${total !== undefined ? ` of ${total.toLocaleString()}` : ""} ${word}`}
			</span>
			{offset > 0 || hasMore ? (
				<nav aria-label="Pages" className="flex items-center gap-1">
					<Button
						aria-label="Previous page"
						disabled={offset === 0}
						onClick={() => onPage(Math.max(offset - pageSize, 0) || undefined)}
						size="icon-xs"
						variant="ghost"
					>
						<ChevronLeft />
					</Button>
					<Button
						aria-label="Next page"
						disabled={!hasMore}
						onClick={() => onPage(offset + pageSize)}
						size="icon-xs"
						variant="ghost"
					>
						<ChevronRight />
					</Button>
				</nav>
			) : null}
		</>
	);
}

export function useRowKeys<T extends { id: string }>({
	rows,
	selectedId,
	onSelect,
}: {
	rows: T[];
	selectedId: string | undefined;
	onSelect: (id: string) => void;
}) {
	useEffect(() => {
		if (!selectedId) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target as HTMLElement | null;
			if (
				target?.closest("input, textarea, select, [contenteditable=true]") !==
				null
			)
				return;
			const key = event.key.toLowerCase();
			if (key !== "j" && key !== "k") return;
			const index = rows.findIndex((row) => row.id === selectedId);
			if (index === -1) return;
			const next = rows[key === "j" ? index + 1 : index - 1];
			if (next) {
				event.preventDefault();
				onSelect(next.id);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [rows, selectedId, onSelect]);

	const index = rows.findIndex((row) => row.id === selectedId);
	return {
		position: index === -1 ? null : { index, count: rows.length },
		newer: index > 0 ? rows[index - 1] : undefined,
		older: index !== -1 ? rows[index + 1] : undefined,
	};
}

export function RowStepper({
	position,
	onNewer,
	onOlder,
}: {
	position: { index: number; count: number } | null;
	onNewer?: () => void;
	onOlder?: () => void;
}) {
	if (!position) return null;
	return (
		<div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
			<span className="tabular-nums">
				{position.index + 1} of {position.count} on this page
			</span>
			<span className="flex items-center gap-1">
				<Button
					disabled={!onNewer}
					onClick={onNewer}
					size="xs"
					title="Newer (K)"
					variant="ghost"
				>
					Newer <Kbd>K</Kbd>
				</Button>
				<Button
					disabled={!onOlder}
					onClick={onOlder}
					size="xs"
					title="Older (J)"
					variant="ghost"
				>
					Older <Kbd>J</Kbd>
				</Button>
			</span>
		</div>
	);
}
