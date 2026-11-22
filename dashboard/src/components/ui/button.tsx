import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex shrink-0 cursor-pointer touch-manipulation items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium text-[13px] outline-none transition-[background-color,border-color,box-shadow,color,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_[data-slot=kbd]]:border-current/15 [&_[data-slot=kbd]]:bg-current/10 [&_[data-slot=kbd]]:text-current/70",
	{
		defaultVariants: {
			size: "default",
			variant: "default",
		},
		variants: {
			size: {
				default: "h-8 px-3",
				icon: "size-8",
				"icon-lg": "size-9",
				"icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
				"icon-xl": "size-10 [&_svg:not([class*='size-'])]:size-5",
				"icon-xs":
					"size-6 rounded-[5px] [&_svg:not([class*='size-'])]:size-3.5",
				lg: "h-9 px-4",
				sm: "h-7 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
				xl: "h-10 px-5 text-sm",
				xs: "h-6 gap-1 rounded-[5px] px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
			},
			variant: {
				brand:
					"border-transparent bg-brand text-brand-foreground shadow-xs hover:bg-brand/90",
				default:
					"border-transparent bg-primary text-primary-foreground shadow-xs hover:bg-primary/88",
				destructive:
					"border-transparent bg-destructive text-white hover:bg-destructive/90 shadow-xs",
				"destructive-outline":
					"border-destructive/30 bg-transparent text-destructive hover:bg-destructive/10 hover:border-destructive/50",
				ghost: "border-transparent hover:bg-accent data-pressed:bg-accent",
				link: "border-transparent underline-offset-4 hover:underline",
				outline:
					"border-border bg-background shadow-xs hover:border-foreground/15 hover:bg-accent/60 hover:text-accent-foreground",
				secondary:
					"border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/70",
			},
		},
	},
);

interface ButtonProps extends useRender.ComponentProps<"button"> {
	variant?: VariantProps<typeof buttonVariants>["variant"];
	size?: VariantProps<typeof buttonVariants>["size"];
	loading?: boolean;
}

function Button({
	className,
	variant,
	size,
	loading,
	render,
	children,
	...props
}: ButtonProps) {
	const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
		render ? undefined : "button";

	const spinnerSizeClass =
		size === "xl"
			? "h-5 w-5 sm:h-4.5 sm:w-4.5"
			: size === "lg"
				? "h-4.5 w-4.5 sm:h-4 sm:w-4"
				: size === "sm"
					? "h-3.5 w-3.5 sm:h-3 w-3"
					: size === "xs"
						? "h-3 w-3 sm:h-2.5 sm:w-2.5"
						: "h-4 w-4 sm:h-3.5 sm:w-3.5";

	const defaultProps = {
		className: cn(buttonVariants({ className, size, variant })),
		"data-slot": "button",
		type: typeValue,
		disabled: loading || props.disabled,
		children: (
			<span className="relative inline-flex items-center justify-center gap-[inherit] overflow-hidden">
				<span
					className={cn(
						"inline-flex items-center gap-[inherit] transition-[transform,opacity] duration-200 ease-out",
						loading && "-translate-y-full opacity-0",
					)}
				>
					{children}
				</span>
				<span
					className={cn(
						"absolute inset-0 flex items-center justify-center transition-[transform,opacity] duration-200 ease-out",
						loading
							? "translate-y-0 opacity-100"
							: "translate-y-full opacity-0",
					)}
				>
					<Loader2 className={cn("animate-spin", spinnerSizeClass)} />
				</span>
			</span>
		),
	};

	return useRender({
		defaultTagName: "button",
		props: mergeProps<"button">(defaultProps, props),
		render,
	});
}

export { Button, buttonVariants };
