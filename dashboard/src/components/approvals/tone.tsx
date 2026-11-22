import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "amber" | "rose" | "emerald" | "sky";

export const TONE_PILL: Record<Tone, string> = {
	neutral: "bg-muted text-muted-foreground",
	amber:
		"bg-amber-500/10 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200",
	rose: "bg-rose-500/10 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200",
	emerald:
		"bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200",
	sky: "bg-sky-500/10 text-sky-700 dark:bg-sky-400/10 dark:text-sky-200",
};

export const TONE_TEXT: Record<Tone, string> = {
	neutral: "text-muted-foreground",
	amber: "text-amber-700 dark:text-amber-300",
	rose: "text-rose-600 dark:text-rose-300",
	emerald: "text-emerald-700 dark:text-emerald-300",
	sky: "text-sky-700 dark:text-sky-300",
};

export const TONE_SURFACE: Record<Tone, string> = {
	neutral: "bg-muted/40 border-border/60",
	amber:
		"bg-amber-500/[0.06] border-amber-500/15 dark:bg-amber-400/[0.06] dark:border-amber-400/15",
	rose: "bg-rose-500/[0.06] border-rose-500/15 dark:bg-rose-400/[0.06] dark:border-rose-400/15",
	emerald:
		"bg-emerald-500/[0.06] border-emerald-500/15 dark:bg-emerald-400/[0.06] dark:border-emerald-400/15",
	sky: "bg-sky-500/[0.06] border-sky-500/15 dark:bg-sky-400/[0.06] dark:border-sky-400/15",
};

export function Pill({
	tone = "neutral",
	className,
	...props
}: ComponentProps<"span"> & { tone?: Tone }) {
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 font-medium text-[11px] leading-none",
				TONE_PILL[tone],
				className,
			)}
			{...props}
		/>
	);
}
