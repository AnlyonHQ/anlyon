"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";

import { cn } from "@/lib/utils";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
	return (
		<CheckboxPrimitive.Root
			className={cn(
				"relative inline-flex size-4 shrink-0 items-center justify-center rounded border border-input bg-background outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-invalid:border-destructive data-disabled:opacity-50",
				className,
			)}
			data-slot="checkbox"
			{...props}
		>
			<CheckboxPrimitive.Indicator
				className="-inset-px absolute flex items-center justify-center rounded text-primary-foreground data-unchecked:hidden data-checked:bg-primary data-indeterminate:text-foreground"
				data-slot="checkbox-indicator"
				render={(props, state) => (
					<span {...props}>
						{state.indeterminate ? (
							<svg
								aria-hidden="true"
								className="size-3"
								fill="none"
								height="24"
								stroke="currentColor"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth="3"
								viewBox="0 0 24 24"
								width="24"
								xmlns="http://www.w3.org/2000/svg"
							>
								<path d="M5.252 12h13.496" />
							</svg>
						) : (
							<svg
								aria-hidden="true"
								className="size-3"
								fill="none"
								height="24"
								stroke="currentColor"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth="3"
								viewBox="0 0 24 24"
								width="24"
								xmlns="http://www.w3.org/2000/svg"
							>
								<path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
							</svg>
						)}
					</span>
				)}
			/>
		</CheckboxPrimitive.Root>
	);
}

export { Checkbox };
