"use client";

import { Field as FieldPrimitive } from "@base-ui/react/field";
import { mergeProps } from "@base-ui/react/merge-props";
import type * as React from "react";

import { cn } from "@/lib/utils";

type TextareaProps = React.ComponentProps<"textarea"> & {
	size?: "sm" | "default" | "lg" | number;
	unstyled?: boolean;
};

function Textarea({
	className,
	size = "default",
	unstyled = false,
	...props
}: TextareaProps) {
	return (
		<span
			className={
				cn(
					!unstyled &&
						"inline-flex w-full rounded-md border border-input bg-background text-[13px] ring-ring/20 transition-colors has-focus-visible:border-ring has-focus-visible:ring-2 has-aria-invalid:border-destructive has-disabled:opacity-50",
					className,
				) || undefined
			}
			data-size={size}
			data-slot="textarea-control"
		>
			<FieldPrimitive.Control
				render={(defaultProps) => (
					<textarea
						className={cn(
							"field-sizing-content min-h-16 w-full touch-manipulation rounded-[inherit] px-2.5 py-1.5 outline-none placeholder:text-muted-foreground",
							size === "sm" && "min-h-12 px-2.5 py-1.5 text-xs",
							size === "lg" && "min-h-20 px-4 py-2.5",
						)}
						data-slot="textarea"
						{...mergeProps(defaultProps, props)}
					/>
				)}
			/>
		</span>
	);
}

export { Textarea, type TextareaProps };
