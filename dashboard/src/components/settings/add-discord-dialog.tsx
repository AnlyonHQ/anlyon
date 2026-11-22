import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { IntegrationEventType } from "@/lib/types";

type OfferedEventType = Exclude<IntegrationEventType, "delivery_failure_spike">;

const EVENT_TYPE_LABELS: Record<OfferedEventType, string> = {
	quota_warning: "Quota Warnings",
	quota_exceeded: "Quota Exceeded",
	payment_failed: "Payment Failed",
	security_alert: "Security Alerts",
	system_alert: "System Alerts",
	approval_requested: "Approval Requests",
	budget_alert: "Budget Alerts",
	approval_expired: "Expired Requests",
	outcome_unknown: "Unknown Outcomes",
	connection_broken: "Broken Connections",
};

export interface AddDiscordDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	integrationName: string;
	webhookUrl: string;
	selectedEventTypes: IntegrationEventType[];
	onIntegrationNameChange: (value: string) => void;
	onWebhookUrlChange: (value: string) => void;
	onEventTypesChange: (types: IntegrationEventType[]) => void;
	onSubmit: () => void;
	isPending: boolean;
}

export function AddDiscordDialog({
	open,
	onOpenChange,
	integrationName,
	webhookUrl,
	selectedEventTypes,
	onIntegrationNameChange,
	onWebhookUrlChange,
	onEventTypesChange,
	onSubmit,
	isPending,
}: AddDiscordDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add Discord Integration</DialogTitle>
					<DialogDescription>
						Connect a Discord channel to receive notifications via webhook.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<div className="flex flex-col gap-4">
						<Field>
							<FieldLabel htmlFor="discord-name">Integration Name</FieldLabel>
							<Input
								id="discord-name"
								placeholder="e.g., Production Alerts"
								value={integrationName}
								onChange={(e) => onIntegrationNameChange(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="discord-webhook">
								Discord Webhook URL
							</FieldLabel>
							<Input
								id="discord-webhook"
								placeholder="https://discord.com/api/webhooks/"
								value={webhookUrl}
								onChange={(e) => onWebhookUrlChange(e.target.value)}
							/>
							<p className="mt-1 text-xs text-muted-foreground">
								You can create a webhook in Discord Server Settings {">"}{" "}
								Integrations {">"} Webhooks
							</p>
						</Field>
						<Field>
							<FieldLabel>Event Types</FieldLabel>
							<p className="mb-2 text-xs text-muted-foreground">
								Select which events should trigger notifications
							</p>
							<div className="grid grid-cols-2 gap-2">
								{(Object.keys(EVENT_TYPE_LABELS) as OfferedEventType[]).map(
									(eventType) => (
										<label
											key={eventType}
											className="flex cursor-pointer items-center gap-2 text-sm"
										>
											<input
												type="checkbox"
												checked={selectedEventTypes.includes(eventType)}
												onChange={(e) => {
													if (e.target.checked) {
														onEventTypesChange([
															...selectedEventTypes,
															eventType,
														]);
													} else {
														onEventTypesChange(
															selectedEventTypes.filter((t) => t !== eventType),
														);
													}
												}}
												className="rounded border-gray-300"
											/>
											{EVENT_TYPE_LABELS[eventType]}
										</label>
									),
								)}
							</div>
						</Field>
					</div>
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>
						Cancel
					</DialogClose>
					<Button
						onClick={onSubmit}
						disabled={
							isPending || !webhookUrl.trim() || !integrationName.trim()
						}
					>
						{isPending ? "Adding..." : "Add Integration"}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
