import {
	Hash,
	MessageSquare,
	MoreHorizontal,
	Play,
	Settings2,
	Trash2,
} from "lucide-react";
import {
	ListEmpty,
	SettingsTableFrame,
} from "@/components/settings/settings-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { IntegrationConnection } from "@/lib/types";

function getIntegrationIcon(type: string) {
	switch (type) {
		case "slack":
			return <Hash aria-hidden="true" className="size-4" />;
		default:
			return <MessageSquare aria-hidden="true" className="size-4" />;
	}
}

export interface IntegrationsListProps {
	integrations: IntegrationConnection[] | undefined;
	isLoading: boolean;
	isTestPending: boolean;
	onSelectChannel: (integration: IntegrationConnection) => void;
	onToggle: (integration: IntegrationConnection) => void;
	onTest: (integrationId: string, type: "slack" | "discord") => void;
	onEdit: (integration: IntegrationConnection) => void;
	onDelete: (integration: IntegrationConnection) => void;
	readOnly?: boolean;
}

export function IntegrationsList({
	integrations,
	isLoading,
	isTestPending,
	onSelectChannel,
	onToggle,
	onTest,
	onEdit,
	onDelete,
	readOnly = false,
}: IntegrationsListProps) {
	if (isLoading) {
		return (
			<SettingsTableFrame>
				<div className="space-y-2 p-4">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			</SettingsTableFrame>
		);
	}
	if (!integrations || integrations.length === 0) {
		return (
			<SettingsTableFrame>
				<ListEmpty>
					{readOnly
						? "No channels yet. When an admin adds Slack or Discord, workspace alerts are posted there."
						: "No channels yet. Add Slack or Discord to get workspace alerts there."}
				</ListEmpty>
			</SettingsTableFrame>
		);
	}
	return (
		<SettingsTableFrame
			footer={
				<span className="tabular-nums">
					{integrations.length}{" "}
					{integrations.length === 1 ? "channel" : "channels"}
				</span>
			}
		>
			<ul className="divide-y">
				{integrations.map((integration) => {
					const needsChannel =
						integration.type === "slack" && !integration.slackChannelId;
					return (
						<li
							key={integration.id}
							className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3"
						>
							<div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
								<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-foreground/80">
									{getIntegrationIcon(integration.type)}
								</span>
								<div className="min-w-0">
									<div className="flex flex-wrap items-center gap-2">
										<span className="truncate font-medium text-sm">
											{integration.name}
										</span>
										{needsChannel ? (
											<Badge size="sm" variant="warning">
												Channel not configured
											</Badge>
										) : (
											<Badge
												size="sm"
												variant={integration.isActive ? "success" : "secondary"}
											>
												{integration.isActive ? "Active" : "Inactive"}
											</Badge>
										)}
									</div>
									<p className="mt-0.5 truncate text-muted-foreground text-xs">
										{integration.type === "slack" ? (
											<>
												{integration.slackTeamName}
												{integration.slackChannelName ? (
													<> · #{integration.slackChannelName}</>
												) : needsChannel ? (
													" · Select a channel to enable notifications"
												) : null}
											</>
										) : (
											"Discord webhook"
										)}
									</p>
									{integration.lastError ? (
										<p className="mt-0.5 text-destructive text-xs">
											Last error: {integration.lastError}
										</p>
									) : null}
								</div>
							</div>
							{readOnly ? null : (
								<div className="flex shrink-0 items-center gap-1.5">
									{needsChannel ? (
										<Button
											size="sm"
											onClick={() => onSelectChannel(integration)}
										>
											<Hash aria-hidden="true" />
											Select channel
										</Button>
									) : (
										<>
											<Switch
												aria-label={`Send alerts to ${integration.name}`}
												checked={integration.isActive}
												onCheckedChange={() => onToggle(integration)}
											/>
											<Button
												variant="ghost"
												size="sm"
												onClick={() => onTest(integration.id, integration.type)}
												disabled={!integration.isActive || isTestPending}
												title="Send test notification"
											>
												<Play aria-hidden="true" />
												Test
											</Button>
										</>
									)}
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												aria-label={`More for ${integration.name}`}
												size="icon-xs"
												variant="ghost"
												className="max-sm:size-11"
											>
												<MoreHorizontal aria-hidden="true" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											{integration.type === "slack" &&
											integration.slackChannelId ? (
												<DropdownMenuItem
													onSelect={() => onSelectChannel(integration)}
												>
													<Hash aria-hidden="true" />
													Change channel
												</DropdownMenuItem>
											) : null}
											<DropdownMenuItem onSelect={() => onEdit(integration)}>
												<Settings2 aria-hidden="true" />
												Edit events
											</DropdownMenuItem>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												variant="destructive"
												onSelect={() => onDelete(integration)}
											>
												<Trash2 aria-hidden="true" />
												Delete
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							)}
						</li>
					);
				})}
			</ul>
		</SettingsTableFrame>
	);
}
