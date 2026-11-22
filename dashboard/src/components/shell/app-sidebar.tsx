import { Link, useLocation } from "@tanstack/react-router";
import { ChevronRight, Search } from "lucide-react";
import { useEffect, useState } from "react";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Sidebar,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@/components/ui/sidebar";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useWorkspace } from "@/contexts/workspace-context";
import { useApprovals } from "@/hooks/api/use-approvals";
import { useEnvironments } from "@/hooks/api/use-environments";
import { useFirstRun } from "@/hooks/api/use-first-run";
import { useFunctionsAvailable } from "@/hooks/api/use-functions";
import { useSignOffs } from "@/hooks/api/use-sign-offs";
import { extensionPages } from "@/lib/extensions";
import { useFirstRunHidden } from "@/lib/first-run-storage";
import { isSelfHosted } from "@/lib/runtime-config";
import { cn } from "@/lib/utils";
import { NotificationPopover } from "../notifications";
import { WorkspaceSwitcher } from "../workspace-switcher";
import {
	areaHref,
	locate,
	type NavArea,
	type NavPage,
	navAreas,
	toSearchEntries,
} from "./nav-config";
import { NavSearch, useFocusNavSearch } from "./nav-search";
import {
	RAIL_BADGE,
	RAIL_DOT,
	RAIL_ITEM,
	RAIL_ITEM_ACTIVE,
	RAIL_WIDTH_CLASS,
} from "./rail";
import { RailOrientation } from "./rail-orientation";
import { UserMenu } from "./user-menu";

export function useNavAreas(): NavArea[] {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const pending = useApprovals(workspaceId, { status: "pending", limit: 50 });
	const signOffs = useSignOffs(workspaceId, "pending");
	const environments = useEnvironments(workspaceId);
	const firstRun = useFirstRun(workspaceId);
	const [firstRunHidden] = useFirstRunHidden(workspaceId);
	const functions = useFunctionsAvailable(workspaceId);
	return navAreas({
		pendingApprovals: pending.data?.pagination?.total ?? 0,
		pendingSignOffs: signOffs.data?.length ?? 0,
		anyHalted: (environments.data ?? []).some((env) => env.halted),
		showGetStarted: !firstRunHidden && !firstRun.loading,
		selfHosted: isSelfHosted(),
		functions: functions === true,
		extensionPages: extensionPages(),
	});
}

const countLabel = (count: number) => (count > 99 ? "99+" : String(count));

function accessibleName(
	item: { badge?: number; alert?: boolean },
	name: string,
) {
	if (item.badge) return `${name}, ${item.badge} waiting`;
	if (item.alert) return `${name}, needs attention`;
	return name;
}

function RailLink({ area, active }: { area: NavArea; active: boolean }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Link
						aria-current={active ? "page" : undefined}
						aria-label={accessibleName(area, area.label)}
						className={cn(RAIL_ITEM, active && RAIL_ITEM_ACTIVE)}
						data-active={active ? "" : undefined}
						data-area={area.id}
						to={areaHref(area)}
					/>
				}
			>
				<area.icon aria-hidden="true" />
				{area.badge ? (
					<span
						aria-hidden="true"
						className={cn(RAIL_BADGE, "bg-primary text-primary-foreground")}
						data-slot="rail-badge"
					>
						{countLabel(area.badge)}
					</span>
				) : area.alert ? (
					<span
						aria-hidden="true"
						className={cn(RAIL_DOT, "motion-safe:animate-pulse")}
						data-slot="rail-dot"
					/>
				) : null}
			</TooltipTrigger>
			<TooltipContent side="right">{area.label}</TooltipContent>
		</Tooltip>
	);
}

function NavRail({
	areas,
	activeId,
}: {
	areas: NavArea[];
	activeId: string | null;
}) {
	const { state } = useSidebar();
	const focusSearch = useFocusNavSearch();
	const top = areas.filter((area) => area.placement === "top");
	const bottom = areas.filter((area) => area.placement === "bottom");
	return (
		<TooltipProvider delay={400}>
			<nav
				aria-label="Areas"
				className={cn(
					RAIL_WIDTH_CLASS,
					"flex shrink-0 flex-col items-center gap-1 py-1",
				)}
				data-slot="nav-rail"
				data-state={state}
			>
				<WorkspaceSwitcher variant="rail" />
				<div aria-hidden="true" className="my-1 h-px w-6 bg-sidebar-border" />
				{state === "collapsed" ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									aria-label="Search pages"
									className={RAIL_ITEM}
									onClick={focusSearch}
									type="button"
								/>
							}
						>
							<Search aria-hidden="true" />
						</TooltipTrigger>
						<TooltipContent side="right">Search pages (/)</TooltipContent>
					</Tooltip>
				) : null}
				<ul className="flex flex-col items-center gap-1">
					{top.map((area) => (
						<li className="flex" key={area.id}>
							<RailLink active={area.id === activeId} area={area} />
						</li>
					))}
				</ul>
				<div className="flex-1" />
				<ul className="flex flex-col items-center gap-1">
					{bottom.map((area) => (
						<li className="flex" key={area.id}>
							<RailLink active={area.id === activeId} area={area} />
						</li>
					))}
					<li className="flex">
						<NotificationPopover variant="rail" />
					</li>
					<li className="flex">
						<UserMenu variant="rail" />
					</li>
				</ul>
			</nav>
		</TooltipProvider>
	);
}

function PageLink({
	page,
	active,
	onNavigate,
}: {
	page: NavPage;
	active: boolean;
	onNavigate?: () => void;
}) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton
				isActive={active}
				render={
					<Link
						aria-current={active ? "page" : undefined}
						aria-label={
							page.badge || page.alert
								? accessibleName(page, page.title)
								: undefined
						}
						onClick={onNavigate}
						to={page.href}
					>
						<page.icon />
						<span>{page.title}</span>
					</Link>
				}
				size="default"
			/>
			{page.badge ? (
				<SidebarMenuBadge
					aria-hidden="true"
					className="bg-primary/10 text-primary"
				>
					{countLabel(page.badge)}
				</SidebarMenuBadge>
			) : page.alert ? (
				<SidebarMenuBadge aria-hidden="true">
					<span className="size-2 rounded-full bg-destructive motion-safe:animate-pulse" />
				</SidebarMenuBadge>
			) : null}
		</SidebarMenuItem>
	);
}

function PageList({
	area,
	activeHref,
	onNavigate,
}: {
	area: NavArea;
	activeHref: string | null;
	onNavigate?: () => void;
}) {
	return area.groups.map((group) => (
		<SidebarGroup className="px-0" key={group.label ?? area.id}>
			{group.label ? (
				<SidebarGroupLabel>{group.label}</SidebarGroupLabel>
			) : null}
			<SidebarMenu>
				{group.pages.map((page) => (
					<PageLink
						active={page.href === activeHref}
						key={page.href}
						onNavigate={onNavigate}
						page={page}
					/>
				))}
			</SidebarMenu>
		</SidebarGroup>
	));
}

function NavPanel({
	areas,
	area,
	activeHref,
}: {
	areas: NavArea[];
	area: NavArea;
	activeHref: string | null;
}) {
	const [query, setQuery] = useState("");
	return (
		<nav
			aria-label={area.label}
			className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden"
			data-slot="nav-panel"
		>
			<div
				className="flex h-11 shrink-0 items-center px-2.5"
				title={area.description}
			>
				<h2 className="truncate font-sans font-semibold text-[13px] tracking-tight">
					{area.label}
				</h2>
			</div>
			<div className="px-2 pb-2">
				<NavSearch
					entries={toSearchEntries(areas)}
					onQueryChange={setQuery}
					query={query}
				/>
			</div>
			{query ? null : (
				<div
					className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
					key={area.id}
				>
					<PageList activeHref={activeHref} area={area} />
				</div>
			)}
		</nav>
	);
}

function MobileNav({
	areas,
	activeId,
	activeHref,
}: {
	areas: NavArea[];
	activeId: string | null;
	activeHref: string | null;
}) {
	const { setOpenMobile } = useSidebar();
	const [openId, setOpenId] = useState<string | null>(activeId);
	const [query, setQuery] = useState("");
	useEffect(() => setOpenId(activeId), [activeId]);
	const close = () => setOpenMobile(false);

	return (
		<div className="flex h-full min-h-0 flex-col" data-slot="nav-mobile">
			<div className="p-2">
				<WorkspaceSwitcher variant="row" />
			</div>
			<div className="px-3 pb-2">
				<NavSearch
					entries={toSearchEntries(areas)}
					onQueryChange={setQuery}
					query={query}
				/>
			</div>
			<nav
				aria-label="Areas"
				className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2"
			>
				{query ? null : (
					<ul className="flex flex-col gap-0.5">
						{areas.map((area) => {
							const open = openId === area.id;
							return (
								<li key={area.id}>
									<Collapsible
										onOpenChange={(next) => setOpenId(next ? area.id : null)}
										open={open}
									>
										<CollapsibleTrigger
											aria-label={accessibleName(area, area.label)}
											className={cn(
												"flex h-11 w-full items-center gap-3 rounded-lg px-2.5 text-left font-medium text-sm outline-none transition-colors duration-150 ease-out hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring [&>svg]:size-[18px] [&>svg]:shrink-0",
												area.id === activeId &&
													"text-sidebar-active-foreground",
											)}
											data-area={area.id}
										>
											<area.icon aria-hidden="true" />
											<span className="flex-1 truncate">{area.label}</span>
											{area.badge ? (
												<span
													aria-hidden="true"
													className="rounded-md bg-primary/10 px-1.5 font-medium text-primary text-xs tabular-nums"
												>
													{countLabel(area.badge)}
												</span>
											) : area.alert ? (
												<span
													aria-hidden="true"
													className="size-2 rounded-full bg-destructive"
												/>
											) : null}
											<ChevronRight
												aria-hidden="true"
												className={cn(
													"text-sidebar-muted-foreground transition-transform duration-150",
													open && "rotate-90",
												)}
											/>
										</CollapsibleTrigger>
										<CollapsiblePanel>
											<div className="pb-2 pl-6">
												<PageList
													activeHref={activeHref}
													area={area}
													onNavigate={close}
												/>
											</div>
										</CollapsiblePanel>
									</Collapsible>
								</li>
							);
						})}
					</ul>
				)}
			</nav>
			<div className="flex items-center gap-1 border-sidebar-border border-t p-2">
				<div className="min-w-0 flex-1">
					<UserMenu variant="row" />
				</div>
				<NotificationPopover variant="rail" />
			</div>
		</div>
	);
}

export function AppSidebar() {
	const { isMobile } = useSidebar();
	const areas = useNavAreas();
	const path = useLocation().pathname;
	const location = locate(areas, path);
	const area = location?.area ?? areas[0];
	const activeHref = location?.page.href ?? null;

	return (
		<Sidebar collapsible="icon" resizable variant="inset">
			{isMobile ? (
				<MobileNav
					activeHref={activeHref}
					activeId={location?.area.id ?? null}
					areas={areas}
				/>
			) : (
				<div className="flex h-full min-h-0">
					<NavRail activeId={location?.area.id ?? null} areas={areas} />
					{area ? (
						<NavPanel activeHref={activeHref} area={area} areas={areas} />
					) : null}
					<RailOrientation />
				</div>
			)}
		</Sidebar>
	);
}
