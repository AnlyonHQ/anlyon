"use client";

import { Copy, Eye, EyeOff, KeyRound, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
	useCreateSubscription,
	useDeleteSubscription,
	useEventSubscriptions,
	useRotateSubscriptionSecret,
	useUpdateSubscription,
} from "@/hooks/api/use-events";
import type { EventSubscription } from "@/lib/types";

export function SubscriptionsList({
	workspaceId,
	topicRef,
}: {
	workspaceId?: string;
	topicRef: string;
}) {
	const { data: subs, isLoading } = useEventSubscriptions(
		topicRef,
		workspaceId,
	);
	const update = useUpdateSubscription();
	const deleteSub = useDeleteSubscription();
	const rotate = useRotateSubscriptionSecret();
	const [secretDialog, setSecretDialog] = useState<{
		secret: string;
		show: boolean;
	} | null>(null);
	const [copied, setCopied] = useState(false);

	if (isLoading) {
		return (
			<div className="space-y-2">
				{[1, 2].map((i) => (
					<Skeleton key={i} className="h-16 w-full rounded-lg" />
				))}
			</div>
		);
	}

	if (!subs?.length) {
		return (
			<p className="text-muted-foreground text-sm">
				No subscriptions. Add a webhook URL to start receiving events for this
				topic.
			</p>
		);
	}

	return (
		<>
			<ul className="divide-y overflow-hidden rounded-lg border">
				{subs.map((sub) => (
					<SubscriptionItem
						key={sub.id}
						sub={sub}
						workspaceId={workspaceId}
						isUpdating={update.isPending}
						isDeleting={deleteSub.isPending}
						isRotating={rotate.isPending}
						onToggle={(enabled) =>
							workspaceId &&
							update.mutate({
								subscriptionId: sub.id,
								data: { enabled },
								workspaceId,
							})
						}
						onDelete={() =>
							workspaceId &&
							deleteSub.mutate({ subscriptionId: sub.id, workspaceId })
						}
						onRotate={() =>
							workspaceId &&
							rotate.mutate(
								{ subscriptionId: sub.id, workspaceId },
								{
									onSuccess: (res) => {
										setSecretDialog({ secret: res.secret, show: false });
										setCopied(false);
									},
								},
							)
						}
					/>
				))}
			</ul>

			<SecretOnceDialog
				open={!!secretDialog}
				secret={secretDialog?.secret ?? ""}
				show={secretDialog?.show ?? false}
				copied={copied}
				onToggleShow={() =>
					setSecretDialog((s) => (s ? { ...s, show: !s.show } : s))
				}
				onCopy={async () => {
					if (!secretDialog) return;
					await navigator.clipboard.writeText(secretDialog.secret);
					setCopied(true);
				}}
				onClose={() => {
					setSecretDialog(null);
					setCopied(false);
				}}
			/>
		</>
	);
}

function SubscriptionItem({
	sub,
	workspaceId,
	isUpdating,
	isDeleting,
	isRotating,
	onToggle,
	onDelete,
	onRotate,
}: {
	sub: EventSubscription;
	workspaceId?: string;
	isUpdating: boolean;
	isDeleting: boolean;
	isRotating: boolean;
	onToggle: (enabled: boolean) => void;
	onDelete: () => void;
	onRotate: () => void;
}) {
	return (
		<li className="space-y-2.5 px-3.5 py-3">
			<div className="flex items-start justify-between gap-3">
				<span className="min-w-0 break-all font-mono text-xs">{sub.url}</span>
				<Switch
					checked={sub.enabled}
					onCheckedChange={(checked) => onToggle(!!checked)}
					disabled={!workspaceId || isUpdating}
					aria-label={
						sub.enabled ? "Disable subscription" : "Enable subscription"
					}
				/>
			</div>
			<div className="flex flex-wrap items-center gap-1.5">
				{(sub.eventTypes ?? ["*"]).map((t) => (
					<Badge key={t} variant="outline" className="font-mono text-[10px]">
						{t}
					</Badge>
				))}
				<span className="ms-auto text-muted-foreground text-xs">
					{sub.hasCustomSecret
						? "signed with its own secret"
						: "signed with the workspace secret, if one exists"}
				</span>
			</div>
			<div className="-mb-1 -me-2 flex justify-end gap-1">
				<Button
					size="sm"
					variant="ghost"
					disabled={!workspaceId || isRotating}
					onClick={onRotate}
				>
					<KeyRound className="size-4" />
					Rotate secret
				</Button>
				<AlertDialog>
					<AlertDialogTrigger
						render={
							<Button
								size="sm"
								variant="ghost"
								aria-label="Delete subscription"
								disabled={!workspaceId || isDeleting}
							>
								<Trash2 className="size-4" />
								Delete
							</Button>
						}
					/>
					<AlertDialogPopup>
						<AlertDialogHeader>
							<AlertDialogTitle>Delete subscription?</AlertDialogTitle>
							<AlertDialogDescription>
								This endpoint will stop receiving events for this topic.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogClose
								render={<Button variant="ghost">Cancel</Button>}
							/>
							<Button variant="destructive" onClick={onDelete}>
								Delete
							</Button>
						</AlertDialogFooter>
					</AlertDialogPopup>
				</AlertDialog>
			</div>
		</li>
	);
}

export function CreateSubscriptionDialog({
	workspaceId,
	topicRef,
}: {
	workspaceId?: string;
	topicRef: string;
}) {
	const [open, setOpen] = useState(false);
	const [url, setUrl] = useState("");
	const [eventTypes, setEventTypes] = useState("*");
	const [generateSecret, setGenerateSecret] = useState(false);
	const [secretDialog, setSecretDialog] = useState<{
		secret: string;
		show: boolean;
	} | null>(null);
	const [copied, setCopied] = useState(false);
	const create = useCreateSubscription();
	const urlId = useId();
	const typesId = useId();
	const secretCheckId = useId();

	const submit = () => {
		if (!workspaceId || !url.trim()) return;
		const types = eventTypes
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		create.mutate(
			{
				topicRef,
				data: {
					url: url.trim(),
					eventTypes: types.length > 0 ? types : undefined,
					generateSecret: generateSecret || undefined,
				},
				workspaceId,
			},
			{
				onSuccess: (sub) => {
					setUrl("");
					setEventTypes("*");
					setGenerateSecret(false);
					setOpen(false);
					if (sub.secret) {
						setSecretDialog({ secret: sub.secret, show: false });
						setCopied(false);
					}
				},
			},
		);
	};

	return (
		<>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogTrigger
					render={
						<Button size="sm">
							<Plus className="size-4" />
							Subscribe
						</Button>
					}
				/>
				<DialogPopup>
					<DialogHeader>
						<DialogTitle>New subscription</DialogTitle>
						<DialogDescription>
							Deliver events from “{topicRef}” to a webhook URL.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel className="grid gap-3">
						<Field>
							<FieldLabel htmlFor={urlId}>Webhook URL</FieldLabel>
							<Input
								id={urlId}
								name="webhookUrl"
								type="url"
								inputMode="url"
								autoComplete="url"
								spellCheck={false}
								placeholder="https://example.com/webhooks/events"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && submit()}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={typesId}>
								Event types (comma-separated)
							</FieldLabel>
							<Input
								id={typesId}
								name="eventTypes"
								autoComplete="off"
								spellCheck={false}
								placeholder="* or order.created, payment.*"
								value={eventTypes}
								onChange={(e) => setEventTypes(e.target.value)}
							/>
						</Field>
						<div className="flex items-center gap-2 text-sm">
							<Checkbox
								id={secretCheckId}
								checked={generateSecret}
								onCheckedChange={(v) => setGenerateSecret(v === true)}
							/>
							<label htmlFor={secretCheckId} className="cursor-pointer">
								Generate a custom delivery secret
							</label>
						</div>
					</DialogPanel>
					<DialogFooter>
						<DialogClose render={<Button variant="ghost">Cancel</Button>} />
						<Button
							disabled={!workspaceId || !url.trim() || create.isPending}
							onClick={submit}
						>
							Create
						</Button>
					</DialogFooter>
				</DialogPopup>
			</Dialog>

			<SecretOnceDialog
				open={!!secretDialog}
				secret={secretDialog?.secret ?? ""}
				show={secretDialog?.show ?? false}
				copied={copied}
				onToggleShow={() =>
					setSecretDialog((s) => (s ? { ...s, show: !s.show } : s))
				}
				onCopy={async () => {
					if (!secretDialog) return;
					await navigator.clipboard.writeText(secretDialog.secret);
					setCopied(true);
				}}
				onClose={() => {
					setSecretDialog(null);
					setCopied(false);
				}}
			/>
		</>
	);
}

export function SecretOnceDialog({
	open,
	secret,
	show,
	copied,
	onToggleShow,
	onCopy,
	onClose,
}: {
	open: boolean;
	secret: string;
	show: boolean;
	copied: boolean;
	onToggleShow: () => void;
	onCopy: () => void;
	onClose: () => void;
}) {
	const display = show ? secret : "•".repeat(Math.min(secret.length || 32, 40));

	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			<DialogPopup className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Subscription signing secret</DialogTitle>
					<DialogDescription>
						Copy this secret now. You won’t be able to see it again.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<Alert variant="warning">
						<AlertTitle>Important</AlertTitle>
						<AlertDescription>
							Store this secret securely. It is shown once, after create or
							rotate, and never again.
						</AlertDescription>
					</Alert>
					<Field className="mt-4">
						<FieldLabel>Signing secret</FieldLabel>
						<div className="flex gap-2">
							<div className="relative flex-1 min-w-0">
								<Input
									readOnly
									value={display}
									className="pr-10 font-mono text-sm"
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
									onClick={onToggleShow}
									aria-label={show ? "Hide secret" : "Show secret"}
								>
									{show ? (
										<EyeOff className="h-4 w-4 text-muted-foreground" />
									) : (
										<Eye className="h-4 w-4 text-muted-foreground" />
									)}
								</Button>
							</div>
							<Button
								size="icon"
								variant="outline"
								onClick={onCopy}
								aria-label="Copy secret"
							>
								{copied ? (
									<span className="text-success text-xs font-medium">✓</span>
								) : (
									<Copy className="h-4 w-4" />
								)}
							</Button>
						</div>
					</Field>
				</DialogPanel>
				<DialogFooter>
					<Button onClick={onClose}>I’ve saved my secret</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
