import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[5px] border border-transparent font-medium text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button,a&]:cursor-pointer",
	{
		defaultVariants: {
			size: "default",
			variant: "default",
		},
		variants: {
			size: {
				default: "h-5 px-1.5",
				lg: "h-6 px-2 text-xs",
				sm: "h-4 px-1 text-[10px]",
			},
			variant: {
				default:
					"bg-primary text-primary-foreground [button,a&]:hover:bg-primary/90",
				destructive:
					"bg-destructive text-white [button,a&]:hover:bg-destructive/90",
				error: "bg-destructive/10 text-destructive-foreground",
				info: "bg-info/10 text-info-foreground",
				outline: "border-border bg-transparent [button,a&]:hover:bg-accent",
				secondary:
					"bg-secondary text-secondary-foreground [button,a&]:hover:bg-secondary/80",
				success: "bg-success/10 text-success-foreground",
				warning: "bg-warning/10 text-warning-foreground",
				soft: "bg-primary/10 text-primary",
				"soft-orange": "bg-orange-500/10 text-orange-500",
			},
		},
	},
);

interface BadgeProps extends useRender.ComponentProps<"span"> {
	variant?: VariantProps<typeof badgeVariants>["variant"];
	size?: VariantProps<typeof badgeVariants>["size"];
}

function Badge({ className, variant, size, render, ...props }: BadgeProps) {
	const defaultProps = {
		className: cn(badgeVariants({ className, size, variant })),
		"data-slot": "badge",
	};

	return useRender({
		defaultTagName: "span",
		props: mergeProps<"span">(defaultProps, props),
		render,
	});
}

export { Badge, badgeVariants };
