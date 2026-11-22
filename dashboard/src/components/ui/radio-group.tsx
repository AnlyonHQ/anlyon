"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "@/lib/utils";

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
	return (
		<RadioGroupPrimitive
			className={cn("flex flex-col gap-3", className)}
			data-slot="radio-group"
			{...props}
		/>
	);
}

function Radio({ className, ...props }: RadioPrimitive.Root.Props) {
	return (
		<RadioPrimitive.Root
			className={cn(
				"relative inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-background outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-invalid:border-destructive data-disabled:opacity-50",
				className,
			)}
			data-slot="radio"
			{...props}
		>
			<RadioPrimitive.Indicator
				className="-inset-px absolute flex size-4 items-center justify-center rounded-full before:size-2 before:rounded-full before:bg-primary-foreground data-unchecked:hidden data-checked:bg-primary"
				data-slot="radio-indicator"
			/>
		</RadioPrimitive.Root>
	);
}

export { RadioGroup, Radio, Radio as RadioGroupItem };
