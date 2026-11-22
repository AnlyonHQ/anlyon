import type { ImpactLimit } from "@/lib/types";
import { cn } from "@/lib/utils";

export function formatLimitAmount(
	limit: Pick<ImpactLimit, "dimension" | "currency">,
	amount: number,
): string {
	if (limit.dimension === "resource_mutations") {
		return `${amount.toLocaleString()} change${amount === 1 ? "" : "s"}`;
	}
	if (limit.dimension !== "money") {
		return `${amount.toLocaleString()} ${limit.dimension}`;
	}
	const currency = limit.currency?.toUpperCase() ?? "";
	try {
		return new Intl.NumberFormat(undefined, {
			style: "currency",
			currency,
		}).format(amount / 100);
	} catch {
		return `${(amount / 100).toFixed(2)} ${currency}`;
	}
}

export function periodLabel(limit: ImpactLimit): string {
	if (limit.period === "total") return "All time";
	return `Per ${limit.period} · ${limit.currentPeriod}`;
}

export function UsageBar({ limit }: { limit: ImpactLimit }) {
	const ratio = (value: number) =>
		limit.limit > 0 ? Math.min(100, (value / limit.limit) * 100) : 0;
	const consumed = ratio(limit.consumed);
	const reserved = Math.min(100 - consumed, ratio(limit.reserved));
	const full = consumed + reserved >= 90;

	return (
		<div className="space-y-1.5">
			<div
				aria-hidden="true"
				className="flex h-1.5 w-full overflow-hidden rounded-full bg-input"
			>
				<span
					className={cn("h-full", full ? "bg-destructive" : "bg-foreground/70")}
					style={{ width: `${consumed}%` }}
				/>
				<span
					className="h-full bg-warning/70"
					style={{ width: `${reserved}%` }}
				/>
			</div>
			<p className="text-muted-foreground text-xs tabular-nums">
				{formatLimitAmount(limit, limit.consumed)} used
				{limit.reserved > 0
					? ` · ${formatLimitAmount(limit, limit.reserved)} held`
					: ""}
				{limit.unknownExposure > 0 ? (
					<span className="text-warning-foreground">
						{" "}
						· {formatLimitAmount(limit, limit.unknownExposure)} unknown
					</span>
				) : null}
			</p>
		</div>
	);
}

export function Available({ limit }: { limit: ImpactLimit }) {
	return (
		<>
			<p className="font-medium tabular-nums">
				{formatLimitAmount(limit, limit.available)}
			</p>
			<p className="text-muted-foreground text-xs tabular-nums">
				of {formatLimitAmount(limit, limit.limit)}
			</p>
		</>
	);
}
