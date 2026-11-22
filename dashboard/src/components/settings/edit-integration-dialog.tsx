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

export interface EditIntegrationDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	integrationName: string;
	selectedEventTypes: IntegrationEventType[];
	onEventTypesChange: (types: IntegrationEventType[]) => void;
	onSubmit: () => void;
	isPending: boolean;
}

export function EditIntegrationDialog({
	open,
	onOpenChange,
	integrationName,
	selectedEventTypes,
	onEventTypesChange,
	onSubmit,
	isPending,
}: EditIntegrationDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Edit Integration</DialogTitle>
					<DialogDescription>
						Configure which events trigger notifications for {integrationName}.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
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
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>
						Cancel
					</DialogClose>
					<Button onClick={onSubmit} disabled={isPending}>
						{isPending ? "Saving..." : "Save Changes"}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
