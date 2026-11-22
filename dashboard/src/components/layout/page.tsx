import { Link, useRouterState } from "@tanstack/react-router";
import type * as React from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
	title,
	description,
	actions,
	meta,
	eyebrow,
	className,
	titleAs: Title = "h2",
	mono = false,
	children,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	meta?: React.ReactNode;
	eyebrow?: React.ReactNode;
	className?: string;
	titleAs?: "h1" | "h2" | "h3";
	mono?: boolean;
	children?: React.ReactNode;
}) {
	return (
		<header
			className={cn("flex flex-col gap-3 pt-1", className)}
			data-slot="page-header"
		>
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
				<div className="min-w-0 max-w-3xl flex-1 basis-80">
					{eyebrow ? (
						<p className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
							{eyebrow}
						</p>
					) : null}
					<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
						<Title
							className={cn(
								"min-w-0 truncate text-foreground leading-tight",
								mono
									? "font-mono font-semibold text-lg tracking-tight"
									: "font-heading text-xl",
							)}
							data-slot="page-title"
						>
							{title}
						</Title>
						{meta ? (
							<div className="flex flex-wrap items-center gap-1.5">{meta}</div>
						) : null}
					</div>
					{description ? (
						<p className="mt-1 text-pretty text-[13px] text-muted-foreground leading-relaxed">
							{description}
						</p>
					) : null}
				</div>
				{actions ? (
					<div className="flex shrink-0 flex-wrap items-center gap-2">
						{actions}
					</div>
				) : null}
			</div>
			{children}
		</header>
	);
}

export type PageTab = {
	label: React.ReactNode;
	to: string;
	params?: Record<string, string>;
	search?: Record<string, unknown>;
	count?: number;
	prefix?: boolean;
	match?: { key: string; value: string | undefined };
};

export function PageTabs({
	items,
	className,
	label = "Sections",
}: {
	items: PageTab[];
	className?: string;
	label?: string;
}) {
	const location = useRouterState({ select: (s) => s.location });
	const search = location.search as Record<string, unknown>;
	return (
		<PageTabsView
			className={className}
			isActive={(item) => {
				const path = fillParams(item.to, item.params);
				return item.match
					? (search[item.match.key] ?? undefined) === item.match.value
					: item.prefix
						? location.pathname === path ||
							location.pathname.startsWith(`${path}/`)
						: location.pathname === path;
			}}
			items={items}
			label={label}
		/>
	);
}

export function PageTabsView({
	items,
	isActive,
	className,
	label = "Sections",
}: {
	items: PageTab[];
	isActive: (item: PageTab, index: number) => boolean;
	className?: string;
	label?: string;
}) {
	return (
		<nav aria-label={label} className={cn("border-b", className)}>
			<ul className="-mb-px flex gap-4 overflow-x-auto">
				{items.map((item, index) => {
					const active = isActive(item, index);
					return (
						<li key={`${item.to}-${index}`}>
							<Link
								aria-current={active ? "page" : undefined}
								className={cn(
									"relative inline-flex h-9 items-center gap-1.5 whitespace-nowrap border-b-2 px-1 font-medium text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
									active
										? "border-foreground text-foreground"
										: "border-transparent text-muted-foreground hover:text-foreground",
								)}
								params={item.params as never}
								search={item.search as never}
								to={item.to as never}
							>
								{item.label}
								{item.count !== undefined ? (
									<span className="rounded-[4px] bg-muted px-1 py-px text-[11px] text-muted-foreground tabular-nums">
										{item.count}
									</span>
								) : null}
							</Link>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}

function fillParams(to: string, params?: Record<string, string>): string {
	if (!params) return to;
	return to.replace(/\$([A-Za-z0-9_]+)/g, (whole, key: string) =>
		key in params ? encodeURIComponent(params[key] as string) : whole,
	);
}

export function PageToolbar({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("flex flex-wrap items-center gap-2", className)}
			data-slot="page-toolbar"
			{...props}
		/>
	);
}

export function ListFrame({
	className,
	footer,
	children,
	padded = false,
	...props
}: React.ComponentProps<"div"> & {
	footer?: React.ReactNode;
	padded?: boolean;
}) {
	return (
		<div
			className={cn(
				"overflow-hidden rounded-lg border bg-card",
				"[&_td:first-child]:ps-3.5 [&_td:last-child]:pe-3.5 [&_th:first-child]:ps-3.5 [&_th:last-child]:pe-3.5",
				"[&_thead_tr]:bg-muted/50 [&_thead_tr]:hover:bg-muted/50",
				className,
			)}
			data-slot="list-frame"
			{...props}
		>
			<div className={cn(padded && "p-4")}>{children}</div>
			{footer ? (
				<div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-3.5 py-1.5 text-muted-foreground text-xs">
					{footer}
				</div>
			) : null}
		</div>
	);
}

export function PageSection({
	title,
	description,
	actions,
	className,
	children,
	id,
	divided = true,
}: {
	title?: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	className?: string;
	children?: React.ReactNode;
	id?: string;
	divided?: boolean;
}) {
	return (
		<section
			className={cn(
				"flex flex-col gap-3",
				divided &&
					"[[data-slot=page-section]+&]:border-t [[data-slot=page-section]+&]:pt-6",
				className,
			)}
			data-slot="page-section"
			id={id}
		>
			{title || actions ? (
				<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
					<div className="min-w-0 max-w-2xl">
						{title ? (
							<h3 className="font-semibold text-foreground text-sm leading-6 tracking-tight">
								{title}
							</h3>
						) : null}
						{description ? (
							<p className="mt-0.5 text-pretty text-[13px] text-muted-foreground leading-relaxed">
								{description}
							</p>
						) : null}
					</div>
					{actions ? (
						<div className="flex shrink-0 flex-wrap items-center gap-2">
							{actions}
						</div>
					) : null}
				</div>
			) : null}
			{children}
		</section>
	);
}

export function DetailLayout({
	rail,
	children,
	className,
}: {
	rail?: React.ReactNode;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"grid min-w-0 gap-6",
				rail && "lg:grid-cols-[minmax(0,1fr)_16rem] xl:gap-8",
				className,
			)}
			data-slot="detail-layout"
		>
			<div className="flex min-w-0 flex-col gap-6">{children}</div>
			{rail ? (
				<aside className="min-w-0 lg:border-l lg:ps-6">
					<div className="flex flex-col gap-6 lg:sticky lg:top-20">{rail}</div>
				</aside>
			) : null}
		</div>
	);
}

export function PropertyList({
	items,
	className,
	title,
}: {
	items: Array<{
		label: React.ReactNode;
		value: React.ReactNode;
		key?: string;
	}>;
	className?: string;
	title?: React.ReactNode;
}) {
	return (
		<div className={cn("flex flex-col gap-3", className)}>
			{title ? (
				<p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
					{title}
				</p>
			) : null}
			<dl className="flex flex-col gap-2.5 text-[13px]">
				{items.map((item, index) => (
					<div
						className="flex flex-col gap-0.5"
						key={
							item.key ?? (typeof item.label === "string" ? item.label : index)
						}
					>
						<dt className="text-muted-foreground text-xs">{item.label}</dt>
						<dd className="min-w-0 break-words text-foreground">
							{item.value}
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

export function Page({
	className,
	width = "full",
	...props
}: React.ComponentProps<"div"> & { width?: "full" | "wide" | "narrow" }) {
	return (
		<div
			className={cn(
				"flex w-full min-w-0 flex-col gap-5",
				width === "wide" && "mx-auto max-w-6xl",
				width === "narrow" && "mx-auto max-w-3xl",
				className,
			)}
			data-slot="page"
			{...props}
		/>
	);
}
