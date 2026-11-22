import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { PanelLeftCloseIcon } from "../icons/panel-left-close";
import { PanelLeftOpenIcon } from "../icons/panel-right-open";

const SIDEBAR_COOKIE_NAME = "sidebar_state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH_DEFAULT = 248;
const SIDEBAR_WIDTH_MIN = 216;
const SIDEBAR_WIDTH_MAX = 400;
const SIDEBAR_COLLAPSE_DRAG = 64;
const SIDEBAR_WIDTH_STORAGE_KEY = "sidebar_width";
const SIDEBAR_RESIZE_STEP = 16;

function clampSidebarWidth(width: number): number {
	return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width));
}

function readStoredSidebarWidth(): number {
	try {
		const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
		return Number.isFinite(stored) && stored > 0
			? clampSidebarWidth(stored)
			: SIDEBAR_WIDTH_DEFAULT;
	} catch {
		return SIDEBAR_WIDTH_DEFAULT;
	}
}
const SIDEBAR_WIDTH_MOBILE = "18rem";
export const SIDEBAR_WIDTH_ICON = "3.5rem";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

type SidebarContextProps = {
	state: "expanded" | "collapsed";
	open: boolean;
	setOpen: (open: boolean) => void;
	openMobile: boolean;
	setOpenMobile: (open: boolean) => void;
	isMobile: boolean;
	toggleSidebar: () => void;
	width: number;
	setWidth: (width: number) => void;
	resetWidth: () => void;
	isResizing: boolean;
	setIsResizing: (resizing: boolean) => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
	const context = React.useContext(SidebarContext);
	if (!context) {
		throw new Error("useSidebar must be used within a SidebarProvider.");
	}

	return context;
}

function SidebarProvider({
	defaultOpen = true,
	open: openProp,
	onOpenChange: setOpenProp,
	className,
	style,
	children,
	...props
}: React.ComponentProps<"div"> & {
	defaultOpen?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const isMobile = useIsMobile();
	const [openMobile, setOpenMobile] = React.useState(false);
	const [width, setWidthState] = React.useState(readStoredSidebarWidth);
	const [isResizing, setIsResizing] = React.useState(false);
	const setWidth = React.useCallback(
		(next: number) => setWidthState(clampSidebarWidth(next)),
		[],
	);
	const resetWidth = React.useCallback(
		() => setWidthState(SIDEBAR_WIDTH_DEFAULT),
		[],
	);

	React.useEffect(() => {
		if (isResizing) return;
		try {
			localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
		} catch {
		}
	}, [width, isResizing]);

	const [_open, _setOpen] = React.useState(defaultOpen);
	const open = openProp ?? _open;
	const setOpen = React.useCallback(
		(value: boolean | ((value: boolean) => boolean)) => {
			const openState = typeof value === "function" ? value(open) : value;
			if (setOpenProp) {
				setOpenProp(openState);
			} else {
				_setOpen(openState);
			}

			document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
		},
		[setOpenProp, open],
	);

	const toggleSidebar = React.useCallback(() => {
		return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open);
	}, [isMobile, setOpen]);

	React.useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
				(event.metaKey || event.ctrlKey)
			) {
				event.preventDefault();
				toggleSidebar();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [toggleSidebar]);

	const state = open ? "expanded" : "collapsed";

	const contextValue = React.useMemo<SidebarContextProps>(
		() => ({
			state,
			open,
			setOpen,
			isMobile,
			openMobile,
			setOpenMobile,
			toggleSidebar,
			width,
			setWidth,
			resetWidth,
			isResizing,
			setIsResizing,
		}),
		[
			state,
			open,
			setOpen,
			isMobile,
			openMobile,
			toggleSidebar,
			width,
			setWidth,
			resetWidth,
			isResizing,
		],
	);

	return (
		<SidebarContext.Provider value={contextValue}>
			<div
				data-slot="sidebar-wrapper"
				data-resizing={isResizing}
				style={
					{
						"--sidebar-width": `${width}px`,
						"--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
						...style,
					} as React.CSSProperties
				}
				className={cn(
					"group/sidebar-wrapper has-data-[variant=inset]:bg-sidebar flex min-h-svh w-full",
					className,
				)}
				{...props}
			>
				{children}
			</div>
		</SidebarContext.Provider>
	);
}

function Sidebar({
	side = "left",
	variant = "sidebar",
	collapsible = "offcanvas",
	resizable = false,
	className,
	children,
	dir,
	...props
}: React.ComponentProps<"div"> & {
	side?: "left" | "right";
	variant?: "sidebar" | "floating" | "inset";
	collapsible?: "offcanvas" | "icon" | "none";
	resizable?: boolean;
}) {
	const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

	if (collapsible === "none") {
		return (
			<div
				data-slot="sidebar"
				className={cn(
					"bg-sidebar text-sidebar-foreground flex h-full w-(--sidebar-width) flex-col",
					className,
				)}
				{...props}
			>
				{children}
			</div>
		);
	}

	if (isMobile) {
		return (
			<Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
				<SheetContent
					dir={dir}
					data-sidebar="sidebar"
					data-slot="sidebar"
					data-mobile="true"
					className="bg-sidebar text-sidebar-foreground w-(--sidebar-width) p-0 [&>button]:hidden"
					style={
						{
							"--sidebar-width": SIDEBAR_WIDTH_MOBILE,
						} as React.CSSProperties
					}
					side={side}
				>
					<SheetHeader className="sr-only">
						<SheetTitle>Sidebar</SheetTitle>
						<SheetDescription>Displays the mobile sidebar.</SheetDescription>
					</SheetHeader>
					<div className="flex h-full w-full flex-col">{children}</div>
				</SheetContent>
			</Sheet>
		);
	}

	return (
		<div
			className="group peer text-sidebar-foreground hidden md:block"
			data-state={state}
			data-collapsible={state === "collapsed" ? collapsible : ""}
			data-variant={variant}
			data-side={side}
			data-slot="sidebar"
		>
			<div
				data-slot="sidebar-gap"
				className={cn(
					"transition-[width] duration-200 ease-out group-data-[resizing=true]/sidebar-wrapper:transition-none relative w-(--sidebar-width) bg-transparent",
					"group-data-[collapsible=offcanvas]:w-0",
					"group-data-[side=right]:rotate-180",
					variant === "floating"
						? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
						: "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
				)}
			/>
			<div
				data-slot="sidebar-container"
				data-side={side}
				className={cn(
					"fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-out group-data-[resizing=true]/sidebar-wrapper:transition-none data-[side=left]:left-0 data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] data-[side=right]:right-0 data-[side=right]:group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)] md:flex",
					variant === "floating"
						? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
						: variant === "inset"
							? "py-2 group-data-[side=left]:pr-2 group-data-[side=right]:pl-2 group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[collapsible=icon]:px-0"
							: "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
					className,
				)}
				{...props}
			>
				<div
					data-sidebar="sidebar"
					data-slot="sidebar-inner"
					className="bg-sidebar group-data-[variant=floating]:ring-sidebar-border group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:shadow-sm group-data-[variant=floating]:ring-1 flex size-full flex-col"
				>
					{children}
				</div>
				{resizable && state === "expanded" ? (
					<SidebarResizeHandle side={side} />
				) : null}
			</div>
		</div>
	);
}

function SidebarResizeHandle({
	side,
	className,
}: {
	side: "left" | "right";
	className?: string;
}) {
	const { width, setWidth, resetWidth, setIsResizing, setOpen } = useSidebar();
	const direction = side === "left" ? 1 : -1;

	const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		const handle = event.currentTarget;
		const startX = event.clientX;
		const startWidth = width;
		handle.setPointerCapture(event.pointerId);
		setIsResizing(true);
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";

		const onMove = (move: PointerEvent) => {
			const next = startWidth + (move.clientX - startX) * direction;
			if (next < SIDEBAR_WIDTH_MIN - SIDEBAR_COLLAPSE_DRAG) {
				onUp();
				setWidth(startWidth);
				setOpen(false);
				return;
			}
			setWidth(next);
		};
		const onUp = () => {
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", onUp);
			handle.removeEventListener("pointercancel", onUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			setIsResizing(false);
		};
		handle.addEventListener("pointermove", onMove);
		handle.addEventListener("pointerup", onUp);
		handle.addEventListener("pointercancel", onUp);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const step =
			event.key === "ArrowRight"
				? SIDEBAR_RESIZE_STEP
				: event.key === "ArrowLeft"
					? -SIDEBAR_RESIZE_STEP
					: 0;
		if (step) {
			event.preventDefault();
			setWidth(width + step * direction);
		} else if (event.key === "Home") {
			event.preventDefault();
			setWidth(SIDEBAR_WIDTH_MIN);
		} else if (event.key === "End") {
			event.preventDefault();
			setWidth(SIDEBAR_WIDTH_MAX);
		}
	};

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize sidebar"
			aria-valuemin={SIDEBAR_WIDTH_MIN}
			aria-valuemax={SIDEBAR_WIDTH_MAX}
			aria-valuenow={width}
			tabIndex={0}
			data-slot="sidebar-resize-handle"
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
			onDoubleClick={resetWidth}
			title="Drag to resize, double-click to reset"
			className={cn(
				"absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-2 after:start-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-sidebar-border focus-visible:after:bg-sidebar-ring active:after:bg-sidebar-ring",
				side === "left" ? "right-0" : "left-0",
				className,
			)}
		/>
	);
}

function SidebarTrigger({
	className,
	onClick,
	...props
}: React.ComponentProps<typeof Button>) {
	const { toggleSidebar, state } = useSidebar();
	const isCollapsed = state === "collapsed";
	return (
		<Button
			data-sidebar="trigger"
			data-slot="sidebar-trigger"
			variant="ghost"
			size="icon-sm"
			className={cn(className)}
			onClick={(event) => {
				onClick?.(event);
				toggleSidebar();
			}}
			{...props}
		>
			{isCollapsed ? (
				<PanelLeftOpenIcon className="cn-rtl-flip " />
			) : (
				<PanelLeftCloseIcon className="cn-rtl-flip " />
			)}

			<span className="sr-only">Toggle Sidebar</span>
		</Button>
	);
}

function SidebarRail({ className, ...props }: React.ComponentProps<"button">) {
	const { toggleSidebar } = useSidebar();

	return (
		<button
			data-sidebar="rail"
			data-slot="sidebar-rail"
			aria-label="Toggle Sidebar"
			tabIndex={-1}
			onClick={toggleSidebar}
			title="Toggle Sidebar"
			className={cn(
				"hover:after:bg-sidebar-border absolute inset-y-0 z-20 hidden w-4 transition-[transform,background-color] ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] sm:flex ltr:-translate-x-1/2 rtl:-translate-x-1/2",
				"in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
				"[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
				"hover:group-data-[collapsible=offcanvas]:bg-sidebar group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full",
				"[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
				"[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
				className,
			)}
			{...props}
		/>
	);
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
	return (
		<main
			data-slot="sidebar-inset"
			className={cn(
				"bg-panel relative flex w-full flex-1 flex-col min-w-0 min-h-0",
				"md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-2xl md:peer-data-[variant=inset]:border md:peer-data-[variant=inset]:border-panel-border md:peer-data-[variant=inset]:shadow-panel",
				className,
			)}
			{...props}
		/>
	);
}

function SidebarInput({
	className,
	...props
}: React.ComponentProps<typeof Input>) {
	return (
		<Input
			data-slot="sidebar-input"
			data-sidebar="input"
			className={cn("bg-background h-8 w-full shadow-none", className)}
			{...props}
		/>
	);
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="sidebar-header"
			data-sidebar="header"
			className={cn("gap-2 p-2 flex flex-col", className)}
			{...props}
		/>
	);
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="sidebar-footer"
			data-sidebar="footer"
			className={cn("gap-2 p-2 flex flex-col", className)}
			{...props}
		/>
	);
}

function SidebarSeparator({
	className,
	...props
}: React.ComponentProps<typeof Separator>) {
	return (
		<Separator
			data-slot="sidebar-separator"
			data-sidebar="separator"
			className={cn("bg-sidebar-border mx-2 w-auto", className)}
			{...props}
		/>
	);
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="sidebar-content"
			data-sidebar="content"
			className={cn(
				"no-scrollbar gap-0 flex min-h-0 flex-1 flex-col overflow-auto group-data-[collapsible=icon]:overflow-hidden",
				className,
			)}
			{...props}
		/>
	);
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="sidebar-group"
			data-sidebar="group"
			className={cn(
				"px-2 py-1.5 relative flex w-full min-w-0 flex-col",
				className,
			)}
			{...props}
		/>
	);
}

function SidebarGroupLabel({
	className,
	render,
	...props
}: useRender.ComponentProps<"div"> & React.ComponentProps<"div">) {
	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(
			{
				className: cn(
					"text-sidebar-muted-foreground ring-sidebar-ring h-7 rounded-md px-2 text-[11px] transition-[margin,opacity] duration-200 ease-out group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0 focus-visible:ring-2 [&>svg]:size-4 flex shrink-0 items-center outline-hidden [&>svg]:shrink-0",
					className,
				),
			},
			props,
		),
		render,
		state: {
			slot: "sidebar-group-label",
			sidebar: "group-label",
		},
	});
}

function SidebarGroupAction({
	className,
	render,
	...props
}: useRender.ComponentProps<"button"> & React.ComponentProps<"button">) {
	return useRender({
		defaultTagName: "button",
		props: mergeProps<"button">(
			{
				className: cn(
					"text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground absolute top-3.5 right-3 w-5 rounded-md p-0 focus-visible:ring-2 [&>svg]:size-4 flex aspect-square items-center justify-center outline-hidden transition-transform [&>svg]:shrink-0 after:absolute after:-inset-2 md:after:hidden group-data-[collapsible=icon]:hidden",
					className,
				),
			},
			props,
		),
		render,
		state: {
			slot: "sidebar-group-action",
			sidebar: "group-action",
		},
	});
}

function SidebarGroupContent({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="sidebar-group-content"
			data-sidebar="group-content"
			className={cn("text-sm w-full", className)}
			{...props}
		/>
	);
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
	return (
		<ul
			data-slot="sidebar-menu"
			data-sidebar="menu"
			className={cn("gap-0.5 flex w-full min-w-0 flex-col", className)}
			{...props}
		/>
	);
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
	return (
		<li
			data-slot="sidebar-menu-item"
			data-sidebar="menu-item"
			className={cn("group/menu-item relative", className)}
			{...props}
		/>
	);
}

const sidebarMenuButtonVariants = cva(
	"text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground data-open:hover:bg-sidebar-accent data-open:hover:text-sidebar-accent-foreground data-active:bg-sidebar-active data-active:text-sidebar-active-foreground data-active:hover:bg-sidebar-active data-active:hover:text-sidebar-active-foreground gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-[background-color,color,box-shadow] duration-150 ease-out group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! focus-visible:ring-2 data-active:font-medium peer/menu-button flex w-full items-center overflow-hidden outline-hidden group/menu-button disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:transition-colors [&_svg]:duration-150",
	{
		variants: {
			variant: {
				default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
				outline:
					"bg-background hover:bg-sidebar-accent hover:text-sidebar-accent-foreground shadow-[0_0_0_1px_var(--sidebar-border)] hover:shadow-[0_0_0_1px_var(--sidebar-accent)]",
			},
			size: {
				default: "h-7 text-[13px]",
				sm: "h-7 text-xs",
				md: "h-9 text-sm font-medium",
				lg: "h-12 text-sm group-data-[collapsible=icon]:p-0!",

				xl: "h-16 text-sm group-data-[collapsible=icon]:p-0!",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function SidebarMenuButton({
	render,
	isActive = false,
	variant = "default",
	size = "md",
	tooltip,
	className,
	...props
}: useRender.ComponentProps<"button"> &
	React.ComponentProps<"button"> & {
		isActive?: boolean;
		tooltip?: string | React.ComponentProps<typeof TooltipContent>;
	} & VariantProps<typeof sidebarMenuButtonVariants>) {
	const { isMobile, state } = useSidebar();
	const comp = useRender({
		defaultTagName: "button",
		props: mergeProps<"button">(
			{
				className: cn(sidebarMenuButtonVariants({ variant, size }), className),
			},
			props,
		),
		render: !tooltip ? render : TooltipTrigger,
		state: {
			slot: "sidebar-menu-button",
			sidebar: "menu-button",
			size,
			active: isActive,
		},
	});

	if (!tooltip) {
		return comp;
	}

	if (typeof tooltip === "string") {
		tooltip = {
			children: tooltip,
		};
	}

	return (
		<Tooltip>
			{comp}
			<TooltipContent
				side="right"
				align="center"
				hidden={state !== "collapsed" || isMobile}
				{...tooltip}
			/>
		</Tooltip>
	);
}

function SidebarMenuAction({
	className,
	render,
	showOnHover = false,
	...props
}: useRender.ComponentProps<"button"> &
	React.ComponentProps<"button"> & {
		showOnHover?: boolean;
	}) {
	return useRender({
		defaultTagName: "button",
		props: mergeProps<"button">(
			{
				className: cn(
					"text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground peer-hover/menu-button:text-sidebar-accent-foreground absolute top-1.5 right-1 aspect-square w-5 rounded-md p-0 peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=md]/menu-button:top-2 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 focus-visible:ring-2 [&>svg]:size-4 flex items-center justify-center outline-hidden transition-transform group-data-[collapsible=icon]:hidden after:absolute after:-inset-2 md:after:hidden [&>svg]:shrink-0",
					showOnHover &&
						"peer-data-active/menu-button:text-sidebar-accent-foreground group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 aria-expanded:opacity-100 md:opacity-0",
					className,
				),
			},
			props,
		),
		render,
		state: {
			slot: "sidebar-menu-action",
			sidebar: "menu-action",
		},
	});
}

function SidebarMenuBadge({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="sidebar-menu-badge"
			data-sidebar="menu-badge"
			className={cn(
				"text-sidebar-foreground peer-hover/menu-button:text-sidebar-accent-foreground peer-data-active/menu-button:text-sidebar-accent-foreground pointer-events-none absolute right-1 h-5 min-w-5 rounded-md px-1 text-xs font-medium peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=md]/menu-button:top-2 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 flex items-center justify-center tabular-nums select-none group-data-[collapsible=icon]:hidden",
				className,
			)}
			{...props}
		/>
	);
}

function SidebarMenuSkeleton({
	className,
	showIcon = false,
	...props
}: React.ComponentProps<"div"> & {
	showIcon?: boolean;
}) {
	const [width] = React.useState(() => {
		return `${Math.floor(Math.random() * 40) + 50}%`;
	});

	return (
		<div
			data-slot="sidebar-menu-skeleton"
			data-sidebar="menu-skeleton"
			className={cn("h-8 gap-2 rounded-md px-2 flex items-center", className)}
			{...props}
		>
			{showIcon && (
				<Skeleton
					className="size-4 rounded-md"
					data-sidebar="menu-skeleton-icon"
				/>
			)}
			<Skeleton
				className="h-4 max-w-(--skeleton-width) flex-1"
				data-sidebar="menu-skeleton-text"
				style={
					{
						"--skeleton-width": width,
					} as React.CSSProperties
				}
			/>
		</div>
	);
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
	return (
		<ul
			data-slot="sidebar-menu-sub"
			data-sidebar="menu-sub"
			className={cn(
				"border-sidebar-border mx-4 mt-0.5 translate-x-px gap-0.5 border-l px-2 py-0.5 group-data-[collapsible=icon]:hidden flex min-w-0 flex-col",
				className,
			)}
			{...props}
		/>
	);
}

function SidebarMenuSubItem({
	className,
	...props
}: React.ComponentProps<"li">) {
	return (
		<li
			data-slot="sidebar-menu-sub-item"
			data-sidebar="menu-sub-item"
			className={cn("group/menu-sub-item relative", className)}
			{...props}
		/>
	);
}

function SidebarMenuSubButton({
	render,
	size = "md",
	isActive = false,
	className,
	...props
}: useRender.ComponentProps<"a"> &
	React.ComponentProps<"a"> & {
		size?: "sm" | "md";
		isActive?: boolean;
	}) {
	return useRender({
		defaultTagName: "a",
		props: mergeProps<"a">(
			{
				className: cn(
					"text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground [&>svg]:text-sidebar-accent-foreground data-active:bg-sidebar-active data-active:text-sidebar-active-foreground data-active:font-medium h-8 gap-2 rounded-lg px-2.5 transition-[background-color,color,box-shadow] duration-150 ease-out focus-visible:ring-2 data-[size=md]:text-sm data-[size=sm]:text-xs [&>svg]:size-4 flex min-w-0 -translate-x-px items-center overflow-hidden outline-hidden group-data-[collapsible=icon]:hidden disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:shrink-0",
					className,
				),
			},
			props,
		),
		render,
		state: {
			slot: "sidebar-menu-sub-button",
			sidebar: "menu-sub-button",
			size,
			active: isActive,
		},
	});
}

export {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupAction,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInput,
	SidebarInset,
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSkeleton,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	SidebarProvider,
	SidebarRail,
	SidebarResizeHandle,
	SidebarSeparator,
	SidebarTrigger,
	useSidebar,
};
