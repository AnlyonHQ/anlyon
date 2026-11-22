import { Link } from "@tanstack/react-router";
import { ChevronsUpDown, Monitor, Moon, Sun } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebar } from "@/components/ui/sidebar";
import { useTheme } from "@/contexts/theme-provider";
import { useAuth } from "@/hooks/use-auth";
import { extensionPages } from "@/lib/extensions";
import { isSelfHosted } from "@/lib/runtime-config";
import { cn } from "@/lib/utils";
import { RAIL_ITEM } from "./rail";

const themeModes = [
	{ id: "system" as const, label: "System", icon: Monitor },
	{ id: "light" as const, label: "Light", icon: Sun },
	{ id: "dark" as const, label: "Dark", icon: Moon },
];

export function UserMenu({ variant = "rail" }: { variant?: "rail" | "row" }) {
	const { isMobile, setOpenMobile } = useSidebar();
	const { user, logout } = useAuth();
	const { theme, setTheme } = useTheme();
	const themeIndex = Math.max(
		0,
		themeModes.findIndex((m) => m.id === theme),
	);
	const initials = user?.name
		? user.name
				.split(" ")
				.map((n) => n[0])
				.join("")
				.slice(0, 2)
				.toUpperCase()
		: user?.email?.[0]?.toUpperCase() || "U";
	const close = () => {
		if (isMobile) setOpenMobile(false);
	};

	const avatar = (
		<Avatar className="size-7 rounded-full">
			<AvatarFallback className="bg-gradient-to-r from-green-600 to-lime-300 text-[11px]">
				{initials}
			</AvatarFallback>
		</Avatar>
	);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				{variant === "rail" ? (
					<button
						aria-label={`Your account (${user?.name || user?.email || "signed in"})`}
						className={cn(RAIL_ITEM, "data-[state=open]:bg-sidebar-accent")}
						type="button"
					>
						{avatar}
					</button>
				) : (
					<button
						className="flex h-10 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left outline-none transition-colors duration-150 ease-out hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent"
						type="button"
					>
						{avatar}
						<span className="grid min-w-0 flex-1 text-sm leading-tight">
							<span className="truncate font-semibold">
								{user?.name || "Your account"}
							</span>
							<span className="truncate text-sidebar-muted-foreground text-xs">
								{user?.email}
							</span>
						</span>
						<ChevronsUpDown className="size-4 shrink-0 text-sidebar-muted-foreground" />
					</button>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="w-60 rounded-lg"
				side={isMobile ? "top" : "right"}
				sideOffset={10}
			>
				<DropdownMenuLabel className="p-0 font-normal">
					<div className="grid px-2 py-1.5 text-left text-sm leading-tight">
						<span className="truncate font-medium">{user?.name}</span>
						<span className="truncate text-muted-foreground text-xs">
							{user?.email}
						</span>
					</div>
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem asChild onSelect={close}>
						<Link to="/settings/profile">Profile</Link>
					</DropdownMenuItem>
					{extensionPages()
						.filter(
							(page) =>
								page.accountMenu && !(page.hostedOnly && isSelfHosted()),
						)
						.map((page) => (
							<DropdownMenuItem asChild key={page.path} onSelect={close}>
								<Link to={page.path}>{page.accountMenu}</Link>
							</DropdownMenuItem>
						))}
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<fieldset
					className="m-0 flex min-w-0 items-center justify-between gap-3 border-0 px-2 py-1.5"
					data-slot="user-menu-theme"
					onPointerDown={(e) => e.stopPropagation()}
				>
					<legend className="sr-only">Theme</legend>
					<span className="shrink-0 font-normal text-foreground text-sm">
						Theme
					</span>
					<div className="relative isolate flex h-7 w-[88px] shrink-0 rounded-full border border-border/70 bg-background p-[3px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-[inset_0_1px_2px_rgba(255,255,255,0.04)]">
						<div
							aria-hidden
							className="pointer-events-none absolute inset-y-[3px] left-[3px] w-[calc((100%-6px)/3)] rounded-full border border-border/50 bg-background shadow-sm transition-transform duration-200 ease-out"
							style={{
								transform: `translateX(calc(${themeIndex} * 100%))`,
							}}
						/>
						{themeModes.map(({ id, label, icon: Icon }) => (
							<button
								aria-label={label}
								aria-pressed={theme === id}
								className={cn(
									"relative z-10 inline-flex h-full min-w-0 flex-1 basis-0 items-center justify-center rounded-full outline-none transition-colors",
									"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
									theme === id ? "text-foreground" : "text-muted-foreground",
								)}
								key={id}
								onClick={() => setTheme(id)}
								type="button"
							>
								<Icon className="size-3.5" strokeWidth={1.5} />
							</button>
						))}
					</div>
				</fieldset>
				<DropdownMenuSeparator />
				<DropdownMenuItem asChild>
					<a href="https://docs.anlyon.com" rel="noopener" target="_blank">
						Docs
					</a>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={logout}>Log out</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
