"use client";

import { type KeyboardEvent, useRef } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string | number> {
	value: T;
	label: string;
}

export function SegmentedControl<T extends string | number>({
	options,
	value,
	onChange,
	label,
	className,
	segmentClassName,
}: {
	options: readonly SegmentedOption<T>[];
	value: T;
	onChange: (value: T) => void;
	label: string;
	className?: string;
	segmentClassName?: (option: SegmentedOption<T>, checked: boolean) => string;
}) {
	const refs = useRef<Array<HTMLButtonElement | null>>([]);
	const index = Math.max(
		0,
		options.findIndex((o) => o.value === value),
	);

	const select = (next: number) => {
		const i = (next + options.length) % options.length;
		onChange(options[i].value);
		refs.current[i]?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		switch (event.key) {
			case "ArrowRight":
			case "ArrowDown":
				event.preventDefault();
				select(index + 1);
				break;
			case "ArrowLeft":
			case "ArrowUp":
				event.preventDefault();
				select(index - 1);
				break;
			case "Home":
				event.preventDefault();
				select(0);
				break;
			case "End":
				event.preventDefault();
				select(options.length - 1);
				break;
		}
	};

	return (
		<div
			aria-label={label}
			className={
				className ??
				"inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5"
			}
			role="radiogroup"
		>
			{options.map((option, i) => {
				const checked = i === index;
				return (
					<button
						aria-checked={checked}
						className={cn(
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							segmentClassName
								? segmentClassName(option, checked)
								: cn(
										"inline-flex h-6 cursor-pointer items-center whitespace-nowrap rounded-[5px] px-2 font-medium text-xs transition-colors duration-150 ease-out",
										checked
											? "bg-background text-foreground shadow-xs ring-1 ring-border/60"
											: "text-muted-foreground hover:text-foreground",
									),
						)}
						key={String(option.value)}
						onClick={() => onChange(option.value)}
						onKeyDown={onKeyDown}
						ref={(el) => {
							refs.current[i] = el;
						}}
						role="radio"
						tabIndex={checked ? 0 : -1}
						type="button"
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}
