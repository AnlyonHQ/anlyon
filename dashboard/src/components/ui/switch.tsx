"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
	return (
		<SwitchPrimitive.Root
			className={cn(
				"group/switch inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input data-disabled:opacity-50",
				className,
			)}
			data-slot="switch"
			{...props}
		>
			<SwitchPrimitive.Thumb
				className={cn(
					"pointer-events-none block size-4 rounded-full bg-background shadow-sm transition-transform data-checked:translate-x-4 data-unchecked:translate-x-0",
				)}
				data-slot="switch-thumb"
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
