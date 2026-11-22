import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { useEnvironments } from "@/hooks/api/use-environments";
import { useSlackChannels } from "@/hooks/api/use-integrations";
import {
	type SlackApprovalRoute,
	useRemoveSlackApprovalRoute,
	useSetSlackApprovalRoute,
	useSlackApprovals,
	useStartSlackLink,
	useUnlinkSlack,
} from "@/hooks/api/use-slack-approvals";
import type { Environment } from "@/lib/types";

export function SlackApprovalsSection({
	workspaceId,
}: {
	workspaceId: string;
}) {
	const { data: settings, isLoading } = useSlackApprovals(workspaceId);
	const { data: environments, isLoading: envLoading } =
		useEnvironments(workspaceId);
	const install = settings?.installs.find((i) => i.isActive && i.teamId);

	if (isLoading || envLoading) {
		return (
			<div className="space-y-2">
				<Skeleton className="h-12 w-full" />
				<Skeleton className="h-12 w-full" />
			</div>
		);
	}
	if (!settings) return null;

	if (!install) {
		return (
			<p className="text-muted-foreground text-sm">
				Add Slack above first. Then choose a channel for each environment: its
				approval requests are posted there with Approve and Deny buttons.
			</p>
		);
	}

	return (
		<div className="space-y-6">
			{!settings.ready ? (
				<Alert variant="warning">
					<AlertTitle>
						Slack cannot send decisions to this deployment yet
					</AlertTitle>
					<AlertDescription>
						Set <code>SLACK_SIGNING_SECRET</code>, and in the Slack app turn on
						Interactivity with this Request URL:{" "}
						<code className="break-all">
							{settings.requestUrl ?? "<API origin>/api/slack/interactions"}
						</code>
						. Nothing is posted until then.
					</AlertDescription>
				</Alert>
			) : null}

			<ul className="divide-y divide-border/70 overflow-hidden rounded-lg border bg-card">
				{(environments ?? []).map((environment) => (
					<EnvironmentRow
						environment={environment}
						integrationId={install.integrationId}
						key={environment.id}
						route={settings.routes.find(
							(r) => r.environmentId === environment.id,
						)}
						workspaceId={workspaceId}
					/>
				))}
			</ul>

			<SlackIdentity
				linked={settings.links.length > 0}
				slackUserId={settings.links[0]?.slackUserId}
				teamName={install.teamName}
				workspaceId={workspaceId}
			/>
		</div>
	);
}

function EnvironmentRow({
	environment,
	route,
	integrationId,
	workspaceId,
}: {
	environment: Environment;
	route: SlackApprovalRoute | undefined;
	integrationId: string;
	workspaceId: string;
}) {
	const [editing, setEditing] = useState(false);
	const [channelId, setChannelId] = useState(route?.channelId ?? "");
	const { data: channels, isLoading } = useSlackChannels(
		workspaceId,
		editing ? integrationId : "",
	);
	const setRoute = useSetSlackApprovalRoute(workspaceId);
	const removeRoute = useRemoveSlackApprovalRoute(workspaceId);
	const production = environment.kind === "production";

	return (
		<li
			className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
			data-testid={`slack-route-${environment.slug}`}
		>
			<div className="min-w-0 space-y-0.5">
				<p className="flex items-center gap-2 font-medium text-sm">
					{environment.name}
					<Badge variant={production ? "error" : "outline"}>
						{environment.kind}
					</Badge>
				</p>
				<p className="text-muted-foreground text-xs">
					{route
						? `Approval requests are posted to #${route.channelName}`
						: "Not posted to Slack"}
				</p>
			</div>
			{editing ? (
				<div className="flex flex-wrap items-center gap-2">
					<NativeSelect
						aria-label={`Slack channel for ${environment.name}`}
						disabled={isLoading}
						onChange={(event) => setChannelId(event.target.value)}
						size="sm"
						value={channelId}
					>
						<NativeSelectOption value="">
							{isLoading ? "Loading channels…" : "Choose a channel"}
						</NativeSelectOption>
						{(channels ?? []).map((channel) => (
							<NativeSelectOption key={channel.id} value={channel.id}>
								{channel.isPrivate ? "🔒 " : "#"}
								{channel.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<Button
						disabled={!channelId || setRoute.isPending}
						onClick={() => {
							const channel = channels?.find((c) => c.id === channelId);
							if (!channel) return;
							setRoute.mutate(
								{
									environmentId: environment.id,
									integrationId,
									channelId: channel.id,
									channelName: channel.name,
								},
								{ onSuccess: () => setEditing(false) },
							);
						}}
						size="sm"
					>
						Save
					</Button>
					<Button onClick={() => setEditing(false)} size="sm" variant="ghost">
						Cancel
					</Button>
				</div>
			) : (
				<div className="flex items-center gap-2">
					<Button onClick={() => setEditing(true)} size="sm" variant="outline">
						{route ? "Change channel" : "Choose channel"}
					</Button>
					{route ? (
						<Button
							disabled={removeRoute.isPending}
							onClick={() => removeRoute.mutate(environment.id)}
							size="sm"
							variant="ghost"
						>
							Stop posting
						</Button>
					) : null}
				</div>
			)}
		</li>
	);
}

function SlackIdentity({
	linked,
	slackUserId,
	teamName,
	workspaceId,
}: {
	linked: boolean;
	slackUserId: string | undefined;
	teamName: string | null;
	workspaceId: string;
}) {
	const startLink = useStartSlackLink(workspaceId);
	const unlink = useUnlinkSlack(workspaceId);
	return (
		<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<div className="min-w-0 space-y-0.5">
				<p className="font-medium text-sm">Your Slack account</p>
				<p className="text-muted-foreground text-xs">
					{linked
						? `Linked to ${slackUserId ?? "your Slack user"}${teamName ? ` in ${teamName}` : ""}. Your decisions in Slack are recorded as yours.`
						: "Decisions you make in Slack are matched to you by email when your Slack email equals your verified Anlyon email. If it does not, or you are a guest in this Slack workspace, link your account."}
				</p>
			</div>
			{linked ? (
				<Button
					disabled={unlink.isPending}
					onClick={() => unlink.mutate()}
					size="sm"
					variant="ghost"
				>
					Unlink
				</Button>
			) : (
				<Button
					disabled={startLink.isPending}
					onClick={() => startLink.mutate()}
					size="sm"
					variant="outline"
				>
					Link your Slack account
				</Button>
			)}
		</div>
	);
}
