import { createFileRoute } from "@tanstack/react-router";
import { Hash, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import {
	AddDiscordDialog,
	DeleteIntegrationDialog,
	EditIntegrationDialog,
	SlackChannelDialog,
} from "@/components/settings";
import { IntegrationsList } from "@/components/settings/integrations-list";
import {
	SettingsPage,
	SettingsSection,
} from "@/components/settings/settings-page";
import { SlackApprovalsSection } from "@/components/settings/slack-approvals-section";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useWorkspace } from "@/contexts/workspace-context";
import {
	useCreateDiscordIntegration,
	useDeleteIntegration,
	useIntegrations,
	useSlackChannels,
	useStartSlackOAuth,
	useTestIntegration,
	useToggleIntegration,
	useUpdateIntegrationEvents,
	useUpdateSlackChannel,
} from "@/hooks/api/use-integrations";
import { useCan } from "@/hooks/api/use-permissions";
import type { IntegrationConnection, IntegrationEventType } from "@/lib/types";

export const Route = createFileRoute("/_protected/settings/integrations")({
	component: IntegrationsSettingsPage,
});

const DEFAULT_EVENT_TYPES: IntegrationEventType[] = [
	"quota_warning",
	"quota_exceeded",
	"payment_failed",
	"security_alert",
	"approval_requested",
	"budget_alert",
	"approval_expired",
	"outcome_unknown",
	"connection_broken",
];

function IntegrationsSettingsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id ?? "";
	const { data: integrations, isLoading } = useIntegrations(workspaceId);
	const startSlackOAuth = useStartSlackOAuth();
	const createDiscord = useCreateDiscordIntegration();
	const deleteIntegration = useDeleteIntegration();
	const testIntegration = useTestIntegration();
	const toggleIntegration = useToggleIntegration();
	const updateEvents = useUpdateIntegrationEvents();
	const updateSlackChannel = useUpdateSlackChannel();
	const canManage = useCan(workspaceId || undefined)("integrations.manage");

	const [dialog, setDialog] = useState<
		"add-discord" | "edit" | "delete" | "slack-channel" | null
	>(null);
	const [selectedIntegration, setSelectedIntegration] =
		useState<IntegrationConnection | null>(null);
	const [slackIntegrationId, setSlackIntegrationId] = useState<string | null>(
		null,
	);
	const [selectedSlackChannel, setSelectedSlackChannel] = useState<{
		id: string;
		name: string;
	} | null>(null);
	const [discordName, setDiscordName] = useState("");
	const [discordWebhookUrl, setDiscordWebhookUrl] = useState("");
	const [selectedEventTypes, setSelectedEventTypes] =
		useState<IntegrationEventType[]>(DEFAULT_EVENT_TYPES);

	const { data: slackChannels, isLoading: isLoadingChannels } =
		useSlackChannels(workspaceId, slackIntegrationId ?? "");

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const error = params.get("error");
		const slackSuccess = params.get("slack_success");
		const integrationId = params.get("integration_id");
		const linkError = params.get("slack_link_error");
		if (params.get("slack_linked") === "true") {
			toast.success(
				"Slack account linked. Your decisions in Slack are recorded as yours.",
			);
		} else if (linkError) {
			toast.error(`Slack account not linked. ${linkError}`);
		}
		if (error) {
			toast.error(`Slack connection failed. ${error}`);
		} else if (slackSuccess === "true" && integrationId) {
			toast.success("Slack connected. Select a channel.");
			setSlackIntegrationId(integrationId);
			setDialog("slack-channel");
		}
	}, []);

	return (
		<SettingsPage
			title="Notification channels"
			description="Send workspace alerts, such as quota warnings, payment failures and security alerts, to Slack or Discord. Each connection chooses which event types it receives."
			actions={
				canManage ? (
					<>
						<Button
							size="sm"
							variant="outline"
							onClick={() => setDialog("add-discord")}
						>
							<MessageSquare aria-hidden="true" />
							Add Discord
						</Button>
						<Button
							size="sm"
							onClick={() => {
								if (workspaceId) startSlackOAuth.mutate(workspaceId);
							}}
							disabled={startSlackOAuth.isPending}
							loading={startSlackOAuth.isPending}
						>
							<Hash aria-hidden="true" />
							Add Slack
						</Button>
					</>
				) : undefined
			}
		>
			<IntegrationsList
				readOnly={!canManage}
				integrations={integrations}
				isLoading={isLoading}
				isTestPending={testIntegration.isPending}
				onSelectChannel={(integration) => {
					setSlackIntegrationId(integration.id);
					setDialog("slack-channel");
				}}
				onToggle={(integration) => {
					if (!workspaceId) return;
					toggleIntegration.mutate({
						workspaceId,
						integrationId: integration.id,
						isActive: !integration.isActive,
					});
				}}
				onTest={(integrationId, type) => {
					if (!workspaceId) return;
					testIntegration.mutate({ integrationId, type, workspaceId });
				}}
				onEdit={(integration) => {
					setSelectedIntegration(integration);
					setSelectedEventTypes(integration.enabledEventTypes);
					setDialog("edit");
				}}
				onDelete={(integration) => {
					setSelectedIntegration(integration);
					setDialog("delete");
				}}
			/>

			<SettingsSection
				className="border-t pt-8"
				title="Slack approvals"
				description="Post each environment's approval requests to a Slack channel, with the request preview and Approve and Deny buttons. Deciding in Slack runs the same checks as deciding here, and whoever requested an approval cannot decide it."
			>
				{workspaceId ? (
					<SlackApprovalsSection workspaceId={workspaceId} />
				) : null}
			</SettingsSection>

			<AddDiscordDialog
				open={dialog === "add-discord"}
				onOpenChange={(open) => setDialog(open ? "add-discord" : null)}
				integrationName={discordName}
				webhookUrl={discordWebhookUrl}
				selectedEventTypes={selectedEventTypes}
				onIntegrationNameChange={setDiscordName}
				onWebhookUrlChange={setDiscordWebhookUrl}
				onEventTypesChange={setSelectedEventTypes}
				isPending={createDiscord.isPending}
				onSubmit={async () => {
					if (
						!workspaceId ||
						!discordWebhookUrl.trim() ||
						!discordName.trim()
					) {
						toast.error("Fill in all required fields.");
						return;
					}
					await createDiscord.mutateAsync({
						workspaceId,
						data: {
							name: discordName.trim(),
							webhookUrl: discordWebhookUrl.trim(),
							enabledEventTypes: selectedEventTypes,
						},
					});
					setDialog(null);
					setDiscordName("");
					setDiscordWebhookUrl("");
					setSelectedEventTypes(DEFAULT_EVENT_TYPES);
				}}
			/>

			<EditIntegrationDialog
				open={dialog === "edit"}
				onOpenChange={(open) => setDialog(open ? "edit" : null)}
				integrationName={selectedIntegration?.name ?? ""}
				selectedEventTypes={selectedEventTypes}
				onEventTypesChange={setSelectedEventTypes}
				isPending={updateEvents.isPending}
				onSubmit={async () => {
					if (!workspaceId || !selectedIntegration) return;
					await updateEvents.mutateAsync({
						workspaceId,
						integrationId: selectedIntegration.id,
						enabledEventTypes: selectedEventTypes,
					});
					setDialog(null);
					setSelectedIntegration(null);
				}}
			/>

			<DeleteIntegrationDialog
				open={dialog === "delete"}
				onOpenChange={(open) => setDialog(open ? "delete" : null)}
				integrationName={selectedIntegration?.name ?? ""}
				isPending={deleteIntegration.isPending}
				onConfirm={async () => {
					if (!workspaceId || !selectedIntegration) return;
					await deleteIntegration.mutateAsync({
						workspaceId,
						integrationId: selectedIntegration.id,
					});
					setDialog(null);
					setSelectedIntegration(null);
				}}
			/>

			<SlackChannelDialog
				open={dialog === "slack-channel"}
				onOpenChange={(open) => setDialog(open ? "slack-channel" : null)}
				channels={slackChannels}
				isLoading={isLoadingChannels}
				selectedChannel={selectedSlackChannel}
				onSelectChannel={setSelectedSlackChannel}
				isPending={updateSlackChannel.isPending}
				onSubmit={async () => {
					if (!workspaceId || !slackIntegrationId || !selectedSlackChannel) {
						toast.error("Select a channel.");
						return;
					}
					await updateSlackChannel.mutateAsync({
						workspaceId,
						integrationId: slackIntegrationId,
						channelId: selectedSlackChannel.id,
						channelName: selectedSlackChannel.name,
					});
					setDialog(null);
					setSlackIntegrationId(null);
					setSelectedSlackChannel(null);
				}}
				onClose={() => {
					setSlackIntegrationId(null);
					setSelectedSlackChannel(null);
				}}
			/>
		</SettingsPage>
	);
}
