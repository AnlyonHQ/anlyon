import { Check } from "lucide-react";
import { type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";

export type StepState = "done" | "active" | "todo";

export function StepProgress({ done, total }: { done: number; total: number }) {
	return (
		<div aria-hidden="true" className="mt-3 flex gap-1">
			{Array.from({ length: total }, (_, index) => (
				<span
					className={cn(
						"h-1 flex-1 rounded-full transition-colors duration-500 ease-out",
						index < done ? "bg-foreground" : "bg-muted",
					)}
					// biome-ignore lint/suspicious/noArrayIndexKey: a segment is its position
					key={index}
				/>
			))}
		</div>
	);
}

export function StepList({ children }: { children: ReactNode }) {
	return (
		<ol className="mt-10 flex flex-col" data-slot="step-list">
			{children}
		</ol>
	);
}

export function StepItem({
	number,
	title,
	state,
	result,
	line,
	last = false,
	doneAction,
	children,
}: {
	number: number;
	title: string;
	state: StepState;
	result: string[];
	line: ReactNode;
	last?: boolean;
	doneAction?: ReactNode;
	children: ReactNode;
}) {
	const titleId = useId();
	const done = state === "done";
	const active = state === "active";

	return (
		<li
			aria-current={active ? "step" : undefined}
			aria-labelledby={titleId}
			className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-4"
			data-state={state}
		>
			<div className="relative flex justify-center">
				<StepMarker number={number} state={state} />
				{last ? null : (
					<span
						aria-hidden="true"
						className={cn(
							"absolute top-9 bottom-1.5 w-px transition-colors duration-500",
							done ? "bg-foreground/40" : "bg-border",
						)}
					/>
				)}
			</div>
			<div className={cn("min-w-0", last ? "pb-2" : "pb-8")}>
				<div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-0.5">
					<h2
						className={cn(
							"font-medium text-[14.5px] leading-5",
							state === "todo" && "text-muted-foreground",
						)}
						id={titleId}
					>
						{title}
						{done ? <span className="sr-only">, done</span> : null}
					</h2>
					{done && result.length > 0 ? (
						<p className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
							{result.map((part, index) => (
								<span key={part}>
									{index > 0 ? <Dot /> : null}
									{part}
								</span>
							))}
						</p>
					) : null}
					<span className="ms-auto text-[12px]">
						{done ? (
							(doneAction ?? (
								<span className="text-muted-foreground">Done</span>
							))
						) : active ? (
							<span className="inline-flex items-center gap-1.5 font-medium text-foreground">
								<LiveDot />
								Now
							</span>
						) : null}
					</span>
				</div>
				{active ? (
					<div className="mt-1.5 motion-safe:fade-in motion-safe:animate-in motion-safe:duration-300">
						<p className="mb-5 max-w-[38rem] text-pretty text-[14px] text-muted-foreground">
							{line}
						</p>
						{children}
					</div>
				) : null}
			</div>
		</li>
	);
}

function StepMarker({ number, state }: { number: number; state: StepState }) {
	if (state === "done") {
		return (
			<span
				aria-hidden="true"
				className="onboarding-enter relative z-10 flex size-7 items-center justify-center rounded-full bg-foreground text-background"
			>
				<Check className="size-3.5" strokeWidth={3} />
			</span>
		);
	}
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative z-10 flex size-7 items-center justify-center rounded-full bg-background font-mono text-[11.5px] tabular-nums",
				state === "active"
					? "border-[1.5px] border-foreground text-foreground"
					: "border border-border text-muted-foreground",
			)}
		>
			{number}
		</span>
	);
}

export function LiveDot({ className }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn("relative flex size-1.5 shrink-0", className)}
		>
			<span className="absolute inline-flex size-full rounded-full bg-success/60 motion-safe:animate-ping" />
			<span className="relative inline-flex size-1.5 rounded-full bg-success" />
		</span>
	);
}

export function Dot() {
	return (
		<span aria-hidden="true" className="px-1.5 text-muted-foreground/60">
			·
		</span>
	);
}
