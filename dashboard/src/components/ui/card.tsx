import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ArrowRight } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Card({
	className,
	interactive = false,
	...props
}: React.ComponentProps<"div"> & { interactive?: boolean }) {
	return (
		<div
			className={cn(
				"flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-xs transition-[box-shadow,border-color] duration-200 ease-out",
				interactive &&
					"cursor-pointer hover:border-foreground/15 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				"has-[data-slot=card-header:first-child]:overflow-hidden",
				className,
			)}
			data-slot="card"
			{...props}
		/>
	);
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"-mx-4 -mt-4",
				"px-4 pt-4 pb-2",
				"first:rounded-t-lg",
				"grid auto-rows-min grid-rows-[auto_auto] items-start gap-x-3 gap-y-1.5 has-data-[slot=card-action]:grid-cols-[1fr_auto]",
				"has-data-[slot=card-icon]:grid-cols-[auto_1fr] has-data-[slot=card-icon]:has-data-[slot=card-action]:grid-cols-[auto_1fr_auto]",
				"has-data-[slot=card-icon]:*:data-[slot=card-title]:col-start-2 has-data-[slot=card-icon]:*:data-[slot=card-description]:col-start-2 has-data-[slot=card-icon]:*:data-[slot=card-action]:col-start-3",
				"has-data-[slot=card-icon]:not-has-data-[slot=card-description]:*:data-[slot=card-title]:row-span-2 has-data-[slot=card-icon]:not-has-data-[slot=card-description]:*:data-[slot=card-title]:self-center",
				className,
			)}
			data-slot="card-header"
			{...props}
		/>
	);
}

function CardIcon({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			aria-hidden="true"
			className={cn(
				"col-start-1 row-span-2 row-start-1 flex size-8 items-center justify-center self-center rounded-md border bg-muted/60 text-foreground/80 [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
				className,
			)}
			data-slot="card-icon"
			{...props}
		/>
	);
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"font-semibold text-[15px] leading-none tracking-tight",
				className,
			)}
			data-slot="card-title"
			{...props}
		/>
	);
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("text-[13px] text-muted-foreground", className)}
			data-slot="card-description"
			{...props}
		/>
	);
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"col-start-2 row-span-2 row-start-1 self-start justify-self-end",
				className,
			)}
			data-slot="card-action"
			{...props}
		/>
	);
}

function CardPanel({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("px-0", className)}
			data-slot="card-content"
			{...props}
		/>
	);
}

function CardFooter({
	className,
	separated = false,
	...props
}: React.ComponentProps<"div"> & { separated?: boolean }) {
	return (
		<div
			className={cn(
				"flex items-center pt-3",
				separated && "-mx-4 -mb-4 mt-auto border-t px-4 py-2.5",
				className,
			)}
			data-slot="card-footer"
			{...props}
		/>
	);
}

function CardFooterLink({
	className,
	children,
	render,
	...props
}: useRender.ComponentProps<"a">) {
	return useRender({
		defaultTagName: "a",
		props: mergeProps<"a">(
			{
				className: cn(
					"group/footer-link -mx-1 inline-flex items-center gap-1.5 rounded-md px-1 font-medium text-[13px] text-muted-foreground outline-none transition-colors duration-150 ease-out hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
					className,
				),
				children: (
					<>
						{children}
						<ArrowRight
							aria-hidden="true"
							className="size-3.5 transition-transform duration-200 ease-out group-hover/footer-link:translate-x-0.5"
						/>
					</>
				),
			},
			props,
		),
		render,
	});
}

export {
	Card,
	CardHeader,
	CardFooter,
	CardFooterLink,
	CardIcon,
	CardTitle,
	CardAction,
	CardDescription,
	CardPanel,
	CardPanel as CardContent,
};
