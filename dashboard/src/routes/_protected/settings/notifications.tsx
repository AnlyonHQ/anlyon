import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import {
	SettingsPage,
	SettingsSection,
} from "@/components/settings/settings-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useWorkspace } from "@/contexts/workspace-context";
import {
	useMyNotificationPreferences,
	useNotificationPreferences,
	useUpdateMyNotificationPreferences,
	useUpdateNotificationPreferences,
} from "@/hooks/api/use-notifications";
import { useWorkspacePermissions } from "@/hooks/api/use-permissions";
import type { NotificationType } from "@/lib/types";

export const Route = createFileRoute("/_protected/settings/notifications")({
	component: NotificationsSettingsPage,
});

const TYPE_LABELS: Partial<
	Record<NotificationType, { label: string; hint: string }>
> = {
	approval_requested: {
		label: "Approval requests",
		hint: "An agent is waiting on an approval decision. The one you never want to miss.",
	},
	approval_expired: {
		label: "Expired requests",
		hint: "Nobody answered a request your team decides in time, so the call was cancelled.",
	},
	outcome_unknown: {
		label: "Unknown outcomes",
		hint: "A provider never confirmed whether a call went through. Someone needs to check.",
	},
	connection_broken: {
		label: "Broken connections",
		hint: "One of your connected accounts stopped working and needs to be reconnected.",
	},
	budget_alert: {
		label: "Budget alerts",
		hint: "A key crossed the alert threshold on its budget.",
	},
	quota_warning: { label: "Quota warnings", hint: "Approaching a plan limit." },
	quota_exceeded: {
		label: "Quota exceeded",
		hint: "A plan limit was hit. Requests are stopping.",
	},
	payment_failed: {
		label: "Payment failures",
		hint: "A charge didn't go through.",
	},
	security_alert: {
		label: "Security alerts",
		hint: "Suspicious auth or key activity.",
	},
	api_key_expiring: {
		label: "API key expiring",
		hint: "A key is about to expire.",
	},
	system_alert: {
		label: "System alerts",
		hint: "Notices about the Anlyon service.",
	},
};

const TYPE_ENTRIES = Object.entries(TYPE_LABELS) as [
	NotificationType,
	{ label: string; hint: string },
][];

function ChannelRow({
	label,
	hint,
	checked,
	onChange,
	disabled,
	ariaLabel,
}: {
	label: string;
	hint: string;
	checked: boolean;
	onChange: (v: boolean) => void;
	disabled?: boolean;
	ariaLabel?: string;
}) {
	return (
		<div className="flex items-start justify-between gap-4 py-3">
			<div>
				<p className="text-sm font-medium">{label}</p>
				<p className="text-xs text-muted-foreground">{hint}</p>
			</div>
			<Switch
				checked={checked}
				onCheckedChange={onChange}
				disabled={disabled}
				aria-label={ariaLabel ?? label}
			/>
		</div>
	);
}

function MyNotificationsSection({ workspaceId }: { workspaceId: string }) {
	const mine = useMyNotificationPreferences(workspaceId);
	const update = useUpdateMyNotificationPreferences();
	const muted = mine.data?.mutedTypes ?? [];

	return (
		<SettingsSection
			title="My notifications"
			description="Turn a type off to leave it out of your own bell and unread count. Nothing changes for anyone else. Email, Slack, Discord and webhook delivery is unaffected."
		>
			{mine.isLoading ? (
				<Skeleton className="h-32 w-full" />
			) : mine.isError ? (
				<p className="text-sm text-muted-foreground">
					Your preferences could not be loaded. Reload the page to try again.
				</p>
			) : (
				<div className="divide-y divide-border">
					{TYPE_ENTRIES.map(([type, meta]) => (
						<ChannelRow
							key={type}
							label={meta.label}
							hint={meta.hint}
							ariaLabel={`Show ${meta.label} in my notifications`}
							checked={!muted.includes(type)}
							disabled={update.isPending}
							onChange={(show) =>
								update.mutate({
									workspaceId,
									mutedTypes: show
										? muted.filter((t) => t !== type)
										: [...muted, type],
								})
							}
						/>
					))}
				</div>
			)}
		</SettingsSection>
	);
}

export function NotificationsSettingsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const permissions = useWorkspacePermissions(workspaceId);
	const { data: prefs, isLoading } = useNotificationPreferences(workspaceId);
	const update = useUpdateNotificationPreferences();
	const [newRecipient, setNewRecipient] = useState("");
	const [webhookUrl, setWebhookUrl] = useState<string | null>(null);

	const canManage =
		permissions.data?.permissions.includes("notifications.manage") ?? false;
	const roleKnown = permissions.data !== undefined;

	const patch = (
		preferences: Parameters<typeof update.mutate>[0]["preferences"],
	) => {
		if (!workspaceId || !canManage) return;
		update.mutate({ workspaceId, preferences });
	};

	if (isLoading || !prefs || !workspaceId) {
		return (
			<SettingsPage
				title="Notifications"
				description="How this workspace reaches you."
			>
				<Skeleton className="h-48 w-full" />
				<Skeleton className="h-48 w-full" />
			</SettingsPage>
		);
	}

	const recipients = prefs.emailRecipients ?? [];
	const enabledTypes = prefs.enabledTypes ?? [];

	return (
		<SettingsPage
			title="Notifications"
			description="Choose what you hear about, such as an approval waiting on you, and where the workspace's alerts go. In-app and email are on by default."
		>
			<MyNotificationsSection workspaceId={workspaceId} />

			<div
				data-testid="workspace-alert-routing"
				className="space-y-1 border-t pt-8"
			>
				<h2 className="font-heading text-lg leading-tight tracking-tight">
					Workspace alert routing
				</h2>
				<p className="text-sm text-muted-foreground">
					Where this workspace's alerts are sent, for every member.
					{roleKnown && !canManage ? " An admin changes these." : ""}
				</p>
			</div>

			<SettingsSection
				title="Channels"
				description="Every enabled channel receives the alert types selected below."
			>
				<div className="divide-y divide-border">
					<ChannelRow
						label="In-app"
						hint="The bell in the dashboard header, updated live."
						checked={prefs.inAppEnabled}
						disabled={!canManage}
						onChange={(v) => patch({ inAppEnabled: v })}
					/>
					<ChannelRow
						label="Email"
						hint="Sent to the recipients listed below. Early Beta Access includes up to 500 emails per workspace each UTC month."
						checked={prefs.emailEnabled}
						disabled={!canManage}
						onChange={(v) => patch({ emailEnabled: v })}
					/>
					<ChannelRow
						label="Slack"
						hint="Requires a connected Slack integration."
						checked={prefs.slackEnabled}
						disabled={!canManage}
						onChange={(v) => patch({ slackEnabled: v })}
					/>
					<ChannelRow
						label="Discord"
						hint="Requires a connected Discord integration."
						checked={prefs.discordEnabled}
						disabled={!canManage}
						onChange={(v) => patch({ discordEnabled: v })}
					/>
					<ChannelRow
						label="Webhook"
						hint="A POST to your own endpoint. It carries an HMAC signature header when a webhook secret is set."
						checked={prefs.webhookEnabled}
						disabled={!canManage}
						onChange={(v) => patch({ webhookEnabled: v })}
					/>
				</div>
				<p className="mt-3 text-xs text-muted-foreground">
					Slack and Discord deliver through your{" "}
					<Link
						className="underline underline-offset-2"
						to="/settings/integrations"
					>
						notification channels
					</Link>
					, honoring each connection's own event filter.
				</p>
			</SettingsSection>

			<SettingsSection
				title="Email recipients"
				description="Who gets email alerts. Whoever created the workspace is added automatically."
			>
				<ul className="divide-y divide-border">
					{recipients.map((email) => (
						<li
							key={email}
							className="flex items-center justify-between gap-3 py-2"
						>
							<span className="truncate text-sm">{email}</span>
							{canManage && (
								<Button
									variant="ghost"
									size="sm"
									aria-label={`Remove ${email}`}
									onClick={() =>
										patch({
											emailRecipients: recipients.filter((r) => r !== email),
										})
									}
								>
									<X className="size-4" aria-hidden="true" />
								</Button>
							)}
						</li>
					))}
					{recipients.length === 0 && (
						<li className="py-2 text-sm text-muted-foreground">
							No recipients. Email alerts have nowhere to go.
						</li>
					)}
				</ul>
				{canManage && (
					<form
						className="mt-3 flex max-w-md gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							const email = newRecipient.trim().toLowerCase();
							if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
								toast.error("Enter a valid email address");
								return;
							}
							if (recipients.includes(email)) {
								toast.error("Already a recipient");
								return;
							}
							patch({ emailRecipients: [...recipients, email] });
							setNewRecipient("");
						}}
					>
						<Input
							value={newRecipient}
							onChange={(e) => setNewRecipient(e.target.value)}
							placeholder="oncall@yourcompany.com"
							type="email"
							aria-label="Add email recipient"
						/>
						<Button
							type="submit"
							size="sm"
							variant="outline"
							disabled={!newRecipient.trim()}
						>
							<Plus className="size-4" aria-hidden="true" /> Add
						</Button>
					</form>
				)}
			</SettingsSection>

			<SettingsSection
				title="Alert types"
				description="What the workspace raises an alert for. Approval requests are on by default."
			>
				<div className="divide-y divide-border">
					{TYPE_ENTRIES.map(([type, meta]) => (
						<ChannelRow
							key={type}
							label={meta.label}
							hint={meta.hint}
							ariaLabel={`Alert the workspace on ${meta.label}`}
							checked={enabledTypes.includes(type)}
							disabled={!canManage}
							onChange={(v) =>
								patch({
									enabledTypes: v
										? [...enabledTypes, type]
										: enabledTypes.filter((t) => t !== type),
								})
							}
						/>
					))}
				</div>
			</SettingsSection>

			<SettingsSection
				title="Webhook endpoint"
				description="Alerts as JSON to your own URL. Route them into PagerDuty, ntfy or another tool."
				footer={
					canManage ? (
						<Button
							size="sm"
							disabled={update.isPending || webhookUrl === null}
							onClick={() => {
								if (webhookUrl === null) return;
								patch({
									webhookUrl:
										webhookUrl.trim() === "" ? null : webhookUrl.trim(),
								});
								setWebhookUrl(null);
							}}
						>
							Save
						</Button>
					) : undefined
				}
			>
				<div className="max-w-md space-y-1.5">
					<Label htmlFor="notif-webhook-url">Webhook URL</Label>
					<Input
						id="notif-webhook-url"
						value={webhookUrl ?? prefs.webhookUrl ?? ""}
						onChange={(e) => setWebhookUrl(e.target.value)}
						placeholder={
							canManage ? "https://ops.yourcompany.com/hooks/anlyon" : "Not set"
						}
						readOnly={!canManage}
					/>
					{canManage && (
						<p className="text-xs text-muted-foreground">
							Leave empty and save to remove. Set a webhook secret through the
							API to have each payload carry an HMAC signature header.
						</p>
					)}
				</div>
			</SettingsSection>
		</SettingsPage>
	);
}
