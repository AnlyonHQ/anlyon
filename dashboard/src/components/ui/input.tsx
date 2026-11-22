"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "@/lib/utils";

type InputProps = Omit<
	InputPrimitive.Props & React.RefAttributes<HTMLInputElement>,
	"size"
> & {
	size?: "sm" | "default" | "lg" | number;
	unstyled?: boolean;
};

function Input({
	className,
	size = "default",
	unstyled = false,
	...props
}: InputProps) {
	return (
		<span
			className={
				cn(
					!unstyled &&
						"inline-flex w-full rounded-md border border-input bg-background text-[13px] shadow-xs ring-ring/20 transition-[border-color,box-shadow] duration-150 ease-out hover:border-foreground/20 has-focus-visible:border-ring has-focus-visible:ring-[3px] has-aria-invalid:border-destructive has-disabled:opacity-50",
					className,
				) || undefined
			}
			data-size={size}
			data-slot="input-control"
		>
			<InputPrimitive
				className={cn(
					"h-8 w-full min-w-0 touch-manipulation rounded-[inherit] px-2.5 outline-none placeholder:text-muted-foreground",
					size === "sm" && "h-7 px-2 text-xs",
					size === "lg" && "h-9 px-3 text-sm",
					props.type === "search" &&
						"[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none",
					props.type === "file" &&
						"text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm",
				)}
				data-slot="input"
				size={typeof size === "number" ? size : undefined}
				{...props}
			/>
		</span>
	);
}

export { Input, type InputProps };
