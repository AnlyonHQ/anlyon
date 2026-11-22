import { Link, useLocation } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type * as React from "react";
import { useEffect, useId, useRef, useState } from "react";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { DETAIL_PANE_SLOT_ID } from "../actions/detail-sheet";
import { ExtensionTopBar } from "../extension-slots";
import { AppSidebar, useNavAreas } from "./app-sidebar";
import { locate, type NavArea, UNLISTED_TITLES } from "./nav-config";

export interface Breadcrumb {
	area?: string;
	parent?: { title: string; href: string };
	title: string;
	named?: boolean;
}

const SUBPAGE_TITLES: Record<string, string> = {
	"/mcp-servers/new": "Add server",
};

const NESTED_PREFIXES = ["/mcp-servers"];

export function breadcrumbFor(areas: NavArea[], path: string): Breadcrumb {
	const location = locate(areas, path);
	if (location) {
		const { area: found, page, rest } = location;
		const area = found.label === page.title ? undefined : found.label;
		const nested = NESTED_PREFIXES.some((prefix) =>
			path.startsWith(`${prefix}/`),
		);
		const onPage = !rest || (!path.startsWith(page.href) && !nested);
		if (onPage) return { area, title: page.title };
		const subpage =
			SUBPAGE_TITLES[path.replace(/\/+$/, "")] ??
			SUBPAGE_TITLES[`${page.href}/${rest}`];
		if (subpage) {
			return {
				area,
				parent: { title: page.title, href: page.href },
				title: subpage,
				named: true,
			};
		}
		return {
			area,
			parent: { title: page.title, href: page.href },
			title: decodeURIComponent(rest),
		};
	}
	const clean = path.replace(/\/+$/, "");
	return {
		title:
			UNLISTED_TITLES[clean] ??
			(clean.split("/").pop()?.replace(/-/g, " ") || "Anlyon"),
	};
}

function TopBarTitle({ crumb }: { crumb: Breadcrumb }) {
	return (
		<nav aria-label="Breadcrumb" className="min-w-0">
			<ol className="flex min-w-0 items-center gap-1.5 text-[13px] leading-none">
				{crumb.area ? (
					<li className="hidden shrink-0 items-center gap-1.5 text-muted-foreground sm:flex">
						<span>{crumb.area}</span>
						<ChevronRight aria-hidden="true" className="size-3" />
					</li>
				) : null}
				{crumb.parent ? (
					<li className="flex shrink-0 items-center gap-1.5">
						<Link
							className="rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
							to={crumb.parent.href}
						>
							{crumb.parent.title}
						</Link>
						<ChevronRight
							aria-hidden="true"
							className="size-3 text-muted-foreground"
						/>
					</li>
				) : null}
				<li className="min-w-0">
					<h1
						className={
							crumb.parent && !crumb.named
								? "truncate font-medium font-mono text-[12.5px]"
								: "truncate font-medium first-letter:uppercase"
						}
						translate={crumb.parent && !crumb.named ? "no" : undefined}
					>
						{crumb.title}
					</h1>
				</li>
			</ol>
		</nav>
	);
}

function ShellFrame({ children }: { children: React.ReactNode }) {
	const path = useLocation().pathname;
	const areas = useNavAreas();
	const crumb = breadcrumbFor(areas, path);
	const mainContentId = useId();
	const scrollRef = useRef<HTMLDivElement>(null);
	const [isScrolled, setIsScrolled] = useState<boolean>(false);
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const handleScroll = () => setIsScrolled(el.scrollTop > 4);
		handleScroll();
		el.addEventListener("scroll", handleScroll, { passive: true });
		return () => el.removeEventListener("scroll", handleScroll);
	}, []);

	useEffect(() => {
		document.title = crumb.title ? `${crumb.title} · Anlyon` : "Anlyon";
	}, [crumb.title]);

	return (
		<>
			<a
				className="sr-only fixed top-4 left-4 z-50 rounded-lg bg-background px-3 py-2 font-medium text-foreground text-sm shadow-lg ring-2 ring-ring focus:not-sr-only focus:outline-none"
				href={`#${mainContentId}`}
			>
				Skip to content
			</a>
			<AppSidebar />
			<SidebarInset className="flex min-h-0 min-w-0 flex-row overflow-hidden">
				<div
					className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain outline-none"
					id={mainContentId}
					ref={scrollRef}
					tabIndex={-1}
				>
					<header
						className="sticky top-0 z-10 flex h-11 shrink-0 items-center justify-between gap-2 border-transparent border-b bg-panel/85 px-3 backdrop-blur-md transition-[border-color] duration-200 ease-out data-[scrolled=true]:border-border md:px-4"
						data-scrolled={isScrolled}
					>
						<div className="flex min-w-0 items-center gap-2">
							<SidebarTrigger className="shrink-0 text-muted-foreground hover:text-foreground" />
							<span
								aria-hidden="true"
								className="h-4 w-px shrink-0 bg-border"
							/>
							<div className="min-w-0 pl-1">
								<TopBarTitle crumb={crumb} />
							</div>
						</div>
						<div className="flex shrink-0 items-center gap-2">
							<ExtensionTopBar />
						</div>
					</header>
					<div className="flex min-w-0 flex-1 flex-col gap-4 px-4 pt-3 pb-10 md:px-6">
						{children}
					</div>
				</div>
				<div className="contents" id={DETAIL_PANE_SLOT_ID} />
			</SidebarInset>
		</>
	);
}

export function AppShell({ children }: { children: React.ReactNode }) {
	return (
		<SidebarProvider className="h-svh overflow-hidden">
			<ShellFrame>{children}</ShellFrame>
		</SidebarProvider>
	);
}
