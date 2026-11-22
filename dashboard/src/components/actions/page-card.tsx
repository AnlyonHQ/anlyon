import type * as React from "react";
import { cn } from "@/lib/utils";

export function PageCard({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"flex min-w-0 flex-col gap-3",
				"[[data-page-card]+&]:mt-4 [[data-page-card]+&]:border-t [[data-page-card]+&]:pt-6",
				className,
			)}
			data-page-card=""
			{...props}
		/>
	);
}

export function PageCardHeader({
	title,
	description,
	actions,
	className,
	titleAs: Title = "h2",
	children,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	className?: string;
	titleAs?: "h1" | "h2" | "h3";
	children?: React.ReactNode;
}) {
	return (
		<div
			className={cn("flex flex-col gap-4 pt-1", className)}
			data-slot="page-card-header"
		>
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
				<div className="flex min-w-0 max-w-3xl flex-1 basis-72 flex-col gap-1">
					<Title
						className={cn(
							"text-foreground leading-tight",
							Title === "h3"
								? "font-sans font-semibold text-sm tracking-tight"
								: "font-heading text-lg",
						)}
						data-slot="card-title"
					>
						{title}
					</Title>
					{description ? (
						<p
							className="max-w-2xl text-pretty text-[13px] text-muted-foreground leading-relaxed"
							data-slot="card-description"
						>
							{description}
						</p>
					) : null}
				</div>
				{actions ? (
					<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
						{actions}
					</div>
				) : null}
			</div>
			{children}
		</div>
	);
}

export function PageCardToolbar({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("flex flex-wrap items-center gap-2", className)}
			data-slot="page-card-toolbar"
			{...props}
		/>
	);
}

export function PageCardBody({
	className,
	flush = false,
	...props
}: React.ComponentProps<"div"> & { flush?: boolean }) {
	return (
		<div
			className={cn(
				"min-w-0 overflow-hidden rounded-lg border bg-card",
				"[&:has(+[data-slot=card-footer])]:rounded-b-none",
				flush
					? "[&_td:first-child]:ps-3.5 [&_td:last-child]:pe-3.5 [&_th:first-child]:ps-3.5 [&_th:last-child]:pe-3.5 [&_thead_tr]:bg-muted/50 [&_thead_tr]:hover:bg-muted/50"
					: "p-4",
				className,
			)}
			data-slot="page-card-body"
			{...props}
		/>
	);
}

export function PageCardFooter({
	className,
	as: Footer = "div",
	...props
}: React.ComponentProps<"div"> & { as?: "div" | "nav" | "footer" }) {
	return (
		<Footer
			className={cn(
				"flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 text-muted-foreground text-xs",
				"[[data-slot=page-card-body]+&]:-mt-3 [[data-slot=page-card-body]+&]:rounded-b-lg [[data-slot=page-card-body]+&]:border [[data-slot=page-card-body]+&]:border-t-0 [[data-slot=page-card-body]+&]:bg-card [[data-slot=page-card-body]+&]:px-3.5 [[data-slot=page-card-body]+&]:py-2",
				className,
			)}
			data-slot="card-footer"
			{...props}
		/>
	);
}
