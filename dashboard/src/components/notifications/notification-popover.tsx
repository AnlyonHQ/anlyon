import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import {
	AlertCircle,
	AlertTriangle,
	Bell,
	CheckCircle2,
	ChevronRight,
	Clock,
	CreditCard,
	HelpCircle,
	Info,
	Key,
	type LucideIcon,
	PlugZap,
	Shield,
	TrendingDown,
	TrendingUp,
} from "lucide-react";
import { useState } from "react";
import { BellIcon } from "@/components/icons/bell-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useWorkspace } from "@/contexts/workspace-context";
import {
	useDismissNotification,
	useMarkAllNotificationsRead,
	useMarkNotificationRead,
	useNotifications,
	useUnreadNotificationCount,
} from "@/hooks/api/use-notifications";
import type {
	Notification,
	NotificationPriority,
	NotificationType,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { RAIL_BADGE, RAIL_ITEM } from "../shell/rail";

const NOTIFICATION_CONFIG: Record<
	NotificationType,
	{ icon: LucideIcon; color: string; bgColor: string }
> = {
	quota_warning: {
		icon: AlertTriangle,
		color: "text-warning",
		bgColor: "bg-warning/10",
	},
	quota_exceeded: {
		icon: AlertCircle,
		color: "text-destructive",
		bgColor: "bg-destructive/10",
	},
	payment_failed: {
		icon: CreditCard,
		color: "text-destructive",
		bgColor: "bg-destructive/10",
	},
	plan_upgraded: {
		icon: TrendingUp,
		color: "text-foreground",
		bgColor: "bg-muted",
	},
	plan_downgraded: {
		icon: TrendingDown,
		color: "text-muted-foreground",
		bgColor: "bg-muted",
	},
	feature_enabled: {
		icon: CheckCircle2,
		color: "text-success",
		bgColor: "bg-success/10",
	},
	system_alert: {
		icon: Info,
		color: "text-blue-500",
		bgColor: "bg-blue-500/10",
	},
	security_alert: {
		icon: Shield,
		color: "text-destructive",
		bgColor: "bg-destructive/10",
	},
	delivery_failure_spike: {
		icon: AlertTriangle,
		color: "text-warning",
		bgColor: "bg-warning/10",
	},
	approval_requested: {
		icon: Shield,
		color: "text-primary",
		bgColor: "bg-primary/10",
	},
	budget_alert: {
		icon: AlertTriangle,
		color: "text-warning",
		bgColor: "bg-warning/10",
	},
	api_key_expiring: {
		icon: Key,
		color: "text-warning",
		bgColor: "bg-warning/10",
	},
	approval_expired: {
		icon: Clock,
		color: "text-muted-foreground",
		bgColor: "bg-muted",
	},
	outcome_unknown: {
		icon: HelpCircle,
		color: "text-warning",
		bgColor: "bg-warning/10",
	},
	connection_broken: {
		icon: PlugZap,
		color: "text-destructive",
		bgColor: "bg-destructive/10",
	},
};

const PRIORITY_CONFIG: Record<
	NotificationPriority,
	{
		label: string;
		variant: "default" | "secondary" | "destructive" | "outline";
	}
> = {
	low: { label: "Low", variant: "secondary" },
	medium: { label: "Medium", variant: "outline" },
	high: { label: "High", variant: "outline" },
	critical: { label: "Critical", variant: "destructive" },
};

interface NotificationItemProps {
	notification: Notification;
	onMarkRead: () => void;
	onDismiss: () => void;
}

function NotificationItem({ notification }: NotificationItemProps) {
	const config = NOTIFICATION_CONFIG[notification.type];
	const priorityConfig = PRIORITY_CONFIG[notification.priority];
	const Icon = config?.icon || Info;
	const timeAgo = formatDistanceToNow(new Date(notification.createdAt), {
		addSuffix: true,
	});

	return (
		<div
			className={cn(
				"group relative flex gap-3 p-4 transition-colors",
				!notification.isRead && "bg-primary/[0.02]",
			)}
		>
			{!notification.isRead && (
				<div className="absolute left-1 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full bg-primary" />
			)}

			<div
				className={cn(
					"flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
					config?.bgColor || "bg-muted",
				)}
			>
				<Icon
					className={cn("h-4 w-4", config?.color || "text-muted-foreground")}
				/>
			</div>

			<div className="flex-1 min-w-0">
				<p className="text-sm font-medium leading-tight">
					{notification.title}
				</p>
				<p className="mt-1 text-xs text-muted-foreground line-clamp-2">
					{notification.message}
				</p>
				<div className="mt-2 flex items-center gap-2">
					<span className="text-[10px] text-muted-foreground">{timeAgo}</span>
					{notification.actionUrl && notification.actionLabel && (
						<>
							<span className="text-muted-foreground/50">·</span>
							<Link
								to={
									notification.actionUrl.replace(/^https?:\/\/[^/]+/, "") || "/"
								}
								className="inline-flex items-center gap-0.5 text-[10px] font-medium text-primary hover:underline"
							>
								{notification.actionLabel}
								<ChevronRight className="h-3 w-3" />
							</Link>
						</>
					)}
					{notification.priority === "critical" ||
					notification.priority === "high" ? (
						<Badge
							variant={priorityConfig.variant}
							className="shrink-0 text-[10px] h-5 px-1.5"
						>
							{priorityConfig.label}
						</Badge>
					) : null}
				</div>
			</div>

		</div>
	);
}

function NotificationEmpty() {
	return (
		<div className="flex flex-col items-center justify-center py-10 px-4 text-center">
			<p className="text-sm font-medium">All caught up</p>
			<p className="text-xs text-muted-foreground mt-1">No new notifications</p>
		</div>
	);
}

function NotificationLoading() {
	return (
		<div className="space-y-4 p-4">
			{[1, 2, 3].map((i) => (
				<div key={i} className="flex gap-3">
					<Skeleton className="h-9 w-9 rounded-lg shrink-0" />
					<div className="flex-1 space-y-2">
						<Skeleton className="h-4 w-3/4" />
						<Skeleton className="h-3 w-full" />
						<Skeleton className="h-3 w-1/3" />
					</div>
				</div>
			))}
		</div>
	);
}

export function NotificationPopover({
	variant = "default",
}: {
	variant?: "default" | "rail";
} = {}) {
	const [open, setOpen] = useState(false);
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;

	const { data: notifications, isLoading } = useNotifications(workspaceId);
	const { data: unreadCount = 0 } = useUnreadNotificationCount(workspaceId);
	const markRead = useMarkNotificationRead();
	const markAllRead = useMarkAllNotificationsRead();
	const dismiss = useDismissNotification();

	const handleMarkRead = (notificationId: string) => {
		if (!workspaceId) return;
		markRead.mutate({ workspaceId, notificationId });
	};

	const handleDismiss = (notificationId: string) => {
		if (!workspaceId) return;
		dismiss.mutate({ workspaceId, notificationId });
	};

	const handleMarkAllRead = () => {
		if (!workspaceId) return;
		markAllRead.mutate(workspaceId);
	};

	const label =
		unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications";
	const count = unreadCount > 99 ? "99+" : unreadCount;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			{variant === "rail" ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<PopoverTrigger
								render={
									<button
										aria-label={label}
										className={cn(
											RAIL_ITEM,
											"data-[popup-open]:bg-sidebar-accent",
										)}
										type="button"
									/>
								}
							/>
						}
					>
						<Bell aria-hidden="true" />
						{unreadCount > 0 ? (
							<span
								aria-hidden="true"
								className={cn(RAIL_BADGE, "bg-destructive text-white")}
								data-slot="rail-badge"
							>
								{count}
							</span>
						) : null}
					</TooltipTrigger>
					<TooltipContent side="right">Notifications</TooltipContent>
				</Tooltip>
			) : (
				<PopoverTrigger
					render={
						<Button
							variant="outline"
							size="icon"
							className="relative flex justify-center items-center group h-7 w-7"
							aria-label={label}
						>
							<BellIcon className="group-hover:text-primary h-4 w-4" />
							{unreadCount > 0 && (
								<span
									aria-hidden="true"
									className="absolute -right-3 top-1 flex h-3 w-3 min-w-3 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-white"
								>
									{count}
								</span>
							)}
						</Button>
					}
				/>
			)}
			<PopoverContent
				align="end"
				className="w-[380px] p-0"
				side={variant === "rail" ? "right" : "bottom"}
				sideOffset={8}
			>
				<div className="flex items-center justify-between px-4 py-3 border-b">
					<div className="flex items-center gap-2">
						<h4 className="text-sm font-semibold">Notifications</h4>
						{unreadCount > 0 && (
							<Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
								{unreadCount} new
							</Badge>
						)}
					</div>
					{unreadCount > 0 && (
						<Button
							variant="ghost"
							size="sm"
							className="h-7 text-xs"
							onClick={handleMarkAllRead}
							disabled={markAllRead.isPending}
						>
							Mark all read
						</Button>
					)}
				</div>

				{isLoading ? (
					<NotificationLoading />
				) : notifications && notifications.length > 0 ? (
					<ScrollArea className="max-h-[400px]">
						<div className="divide-y">
							{notifications.map((notification) => (
								<NotificationItem
									key={notification.id}
									notification={notification}
									onMarkRead={() => handleMarkRead(notification.id)}
									onDismiss={() => handleDismiss(notification.id)}
								/>
							))}
						</div>
					</ScrollArea>
				) : (
					<NotificationEmpty />
				)}

			</PopoverContent>
		</Popover>
	);
}
