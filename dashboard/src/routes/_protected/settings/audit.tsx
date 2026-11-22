import { createFileRoute } from "@tanstack/react-router";
import {
	Activity,
	Archive,
	Check,
	Copy,
	Download,
	KeyRound,
	MoreHorizontal,
	Pause,
	Play,
	Plus,
	RotateCcw,
	Search,
	Send,
	Trash2,
	Webhook,
} from "lucide-react";
import { useId, useState } from "react";
import { TeamPlanNotice } from "@/components/plan/team-plan-notice";
import { DisplaySecretDialog, maskSecret } from "@/components/settings";
import {
	ListEmpty,
	SettingsPage,
	SettingsRow,
	SettingsSection,
	SettingsTableFrame,
} from "@/components/settings/settings-page";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogForm,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuTrigger,
} from "@/components/ui/menu";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useWorkspace } from "@/contexts/workspace-context";
import {
	useAuditDeadLetters,
	useAuditSettings,
	useAuditSinks,
	useCreateAuditSink,
	useDeleteAuditSink,
	useRecentAuditEvents,
	useRedeliverDeadLetter,
	useTestAuditSink,
	useUpdateAuditSettings,
	useUpdateAuditSink,
} from "@/hooks/api/use-audit";
import { useEnvironments } from "@/hooks/api/use-environments";
import { useWorkspaceMembers } from "@/hooks/api/use-workspaces";
import { useAuth } from "@/hooks/use-auth";
import { usePlanAccess } from "@/hooks/use-plan-access";
import { ApiError } from "@/lib/api-client";
import {
	type AuditSink,
	type AuditSinkType,
	actorLabel,
	DATADOG_SITES,
	describeEnvironments,
	describeRecords,
	EMPTY_SINK_FORM,
	eventLabel,
	exportPath,
	RECORD_CATEGORIES,
	RETENTION_CHOICES,
	type RecordsSelection,
	recordsToEventTypes,
	SINK_HEALTH_LABEL,
	SINK_TYPE_LABEL,
	type SinkForm,
	type SinkHealth,
	sinkDestination,
	sinkHealth,
	sinkHost,
	sinkRequest,
	withSinkType,
} from "@/lib/audit";
import { API_BASE_URL } from "@/lib/constants";
import { isSelfHosted } from "@/lib/runtime-config";
import { cn, copyToClipboard } from "@/lib/utils";

export const Route = createFileRoute("/_protected/settings/audit")({
	component: AuditSettingsPage,
});

export function AuditSettingsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const { user } = useAuth();
	const members = useWorkspaceMembers(workspaceId ?? "");
	const role = members.data?.find((m) => m.userId === user?.id)?.role;
	const isAdmin = role === "admin";
	const settings = useAuditSettings(isAdmin ? workspaceId : undefined);
	const notInEdition =
		settings.error instanceof ApiError && settings.error.status === 404;

	return (
		<SettingsPage
			title="Audit streaming"
			description="Stream audit records to your SIEM or a bucket, set how long they are kept, and export evidence."
		>
			{role !== undefined && !isAdmin ? (
				<p className="text-sm text-muted-foreground">
					Only a workspace admin can manage audit streaming.
				</p>
			) : notInEdition ? (
				<SettingsSection
					title="Not included in this edition"
					description="Audit streaming is part of the Enterprise edition and the Team plan."
				/>
			) : settings.isLoading || !workspaceId || role === undefined ? (
				<div className="space-y-3">
					<Skeleton className="h-28 w-full rounded-lg" />
					<Skeleton className="h-28 w-full rounded-lg" />
				</div>
			) : settings.error ? (
				<p aria-live="polite" className="text-destructive text-sm">
					{errorText(settings.error)}
				</p>
			) : (
				<>
					<SinksSection workspaceId={workspaceId} />
					<RetentionSection
						workspaceId={workspaceId}
						retentionDays={settings.data?.retentionDays ?? null}
						planRetentionMonths={settings.data?.planRetentionMonths ?? null}
						graceUntil={settings.data?.retentionGraceUntil ?? null}
						hotDays={settings.data?.hotDays ?? null}
						archiveAvailable={settings.data?.archiveAvailable ?? false}
					/>
					{settings.data?.privateDestinationsAvailable ? (
						<PrivateDestinationsSection
							workspaceId={workspaceId}
							allowed={settings.data.allowPrivateDestinations}
						/>
					) : settings.data && isSelfHosted() ? (
						<PrivateDestinationsOff />
					) : null}
					<ExportSection workspaceId={workspaceId} />
					<RecentSection workspaceId={workspaceId} />
				</>
			)}
		</SettingsPage>
	);
}

const AUDIT_DOCS =
	"https://docs.anlyon.com/trust-control/audit#delivery-retries-and-dead-letters";

const SINK_ICON: Record<AuditSinkType, typeof Webhook> = {
	webhook: Webhook,
	s3: Archive,
	datadog: Activity,
	splunk: Search,
};

function SinksSection({ workspaceId }: { workspaceId: string }) {
	const sinks = useAuditSinks(workspaceId);
	const environments = useEnvironments(workspaceId);
	const [adding, setAdding] = useState(false);
	const [secret, setSecret] = useState<string | null>(null);
	const { teamPlanRequired } = usePlanAccess(workspaceId);
	const hasSinks = (sinks.data ?? []).length > 0;

	return (
		<SettingsSection
			title="Sinks"
			description={
				<>
					Each record is delivered at least once.{" "}
					<a
						className="text-foreground underline underline-offset-2 hover:no-underline"
						href={AUDIT_DOCS}
						rel="noreferrer"
						target="_blank"
					>
						Learn more
					</a>
				</>
			}
			actions={
				hasSinks && !teamPlanRequired ? (
					<Button size="sm" onClick={() => setAdding(true)}>
						<Plus aria-hidden="true" />
						Add sink
					</Button>
				) : null
			}
		>
			{teamPlanRequired && !sinks.isLoading ? (
				<TeamPlanNotice
					feature="Audit streaming"
					hasConfiguration={hasSinks}
					variant="inline"
				/>
			) : null}
			<SettingsTableFrame>
				{sinks.isLoading ? (
					<div className="space-y-2 p-4">
						<Skeleton className="h-12 w-full" />
						<Skeleton className="h-12 w-full" />
					</div>
				) : sinks.error ? (
					<p aria-live="polite" className="px-4 py-4 text-destructive text-sm">
						{errorText(sinks.error)}
					</p>
				) : (sinks.data ?? []).length === 0 ? (
					<ListEmpty
						action={
							teamPlanRequired ? undefined : (
								<Button size="sm" onClick={() => setAdding(true)}>
									<Plus aria-hidden="true" />
									Add sink
								</Button>
							)
						}
					>
						No sinks yet. Add one to send records to your SIEM or a bucket. They
						are stored and exportable either way.
					</ListEmpty>
				) : (
					<ul className="divide-y">
						{sinks.data?.map((sink) => (
							<SinkRow
								key={sink.sinkId}
								sink={sink}
								workspaceId={workspaceId}
								environments={environments.data ?? []}
								onSecret={setSecret}
							/>
						))}
					</ul>
				)}
			</SettingsTableFrame>

			<AddSinkDialog
				open={adding}
				onOpenChange={setAdding}
				workspaceId={workspaceId}
				onCreated={(created) => {
					setAdding(false);
					if (created.signingSecret) setSecret(created.signingSecret);
				}}
			/>
			<OneTimeSecretDialog secret={secret} onClose={() => setSecret(null)} />
		</SettingsSection>
	);
}

function OneTimeSecretDialog({
	secret,
	onClose,
}: {
	secret: string | null;
	onClose: () => void;
}) {
	const [showSecret, setShowSecret] = useState(false);
	const [copied, setCopied] = useState(false);
	const close = () => {
		setShowSecret(false);
		setCopied(false);
		onClose();
	};
	return (
		<DisplaySecretDialog
			open={secret !== null}
			onOpenChange={(open) => {
				if (!open) close();
			}}
			displayValue={showSecret ? (secret ?? "") : maskSecret(secret ?? "")}
			showValue={showSecret}
			onToggleShow={() => setShowSecret((value) => !value)}
			isCopied={copied}
			onCopy={async () => {
				if (!secret) return;
				const result = await copyToClipboard(secret);
				if (result.success) {
					setCopied(true);
					toast.success("Secret copied");
					setTimeout(() => setCopied(false), 2000);
				} else toast.error(result.error || "Copy failed");
			}}
			onClose={close}
		/>
	);
}

const HEALTH_DOT: Record<SinkHealth, string> = {
	delivering: "bg-success",
	paused: "bg-muted-foreground/40",
	failing: "bg-destructive",
};

function SinkRow({
	sink,
	workspaceId,
	environments,
	onSecret,
}: {
	sink: AuditSink;
	workspaceId: string;
	environments: Array<{ id: string; name: string }>;
	onSecret: (secret: string) => void;
}) {
	const update = useUpdateAuditSink(workspaceId);
	const remove = useDeleteAuditSink(workspaceId);
	const test = useTestAuditSink(workspaceId);
	const [confirm, setConfirm] = useState<"delete" | "rotate" | null>(null);
	const [showDeadLetters, setShowDeadLetters] = useState(false);
	const health = sinkHealth(sink);
	const Icon = SINK_ICON[sink.type];
	const destination = sinkDestination(sink);

	const setEnabled = (enabled: boolean) =>
		update.mutate(
			{ sinkId: sink.sinkId, patch: { enabled } },
			{
				onSuccess: () =>
					toast.success(
						enabled ? `${sink.name} resumed` : `${sink.name} paused`,
					),
			},
		);

	return (
		<li className="px-4 py-4">
			<div className="flex items-start gap-3">
				<span
					aria-hidden="true"
					className="mt-0.5 hidden text-muted-foreground sm:block [&_svg]:size-4"
				>
					<Icon />
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
						<span className="min-w-0 truncate font-medium text-sm">
							{sink.name}
						</span>
						<span className="flex items-center gap-1.5 text-sm">
							<span
								aria-hidden="true"
								className={cn("size-1.5 rounded-full", HEALTH_DOT[health])}
							/>
							<span>{SINK_HEALTH_LABEL[health]}</span>
						</span>
					</div>
					<div className="mt-0.5 flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
						<span className="shrink-0">{SINK_TYPE_LABEL[sink.type]}</span>
						<span aria-hidden="true">·</span>
						<span className="min-w-0 truncate" title={destination}>
							{sinkHost(sink)}
						</span>
						<CopyButton value={destination} label="destination" />
					</div>
					<dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground text-xs">
						<div className="flex gap-1">
							<dt>Last delivery</dt>
							<dd className="text-foreground">
								{sink.lastSuccessAt ? (
									<RelativeTime value={sink.lastSuccessAt} />
								) : (
									"None yet"
								)}
							</dd>
						</div>
						<div className="flex gap-1">
							<dt>Delivered</dt>
							<dd className="text-foreground tabular-nums">
								{sink.deliveredCount.toLocaleString()}
							</dd>
						</div>
						<div className="flex gap-1">
							<dt className="sr-only">Records</dt>
							<dd>{describeRecords(sink.eventTypes)}</dd>
						</div>
						<div className="flex gap-1">
							<dt className="sr-only">Environments</dt>
							<dd>{describeEnvironments(sink.environmentIds, environments)}</dd>
						</div>
						{sink.includeHistory ? (
							<div>
								<dt className="sr-only">History</dt>
								<dd>Includes records from history</dd>
							</div>
						) : null}
					</dl>
					{sink.status === "retrying" && sink.lastError ? (
						<p aria-live="polite" className="mt-2 text-destructive text-xs">
							Attempt {sink.attempts} failed: {sink.lastError}. Next try{" "}
							<RelativeTime value={sink.nextAttemptAt} />.
						</p>
					) : null}
					{sink.openDeadLetters > 0 || showDeadLetters ? (
						<Button
							size="sm"
							variant="link"
							className="mt-1 h-auto p-0 text-xs"
							onClick={() => setShowDeadLetters((value) => !value)}
						>
							{showDeadLetters
								? "Hide dead letters"
								: `${sink.openDeadLetters} dead ${sink.openDeadLetters === 1 ? "letter" : "letters"}`}
						</Button>
					) : null}
					{showDeadLetters ? (
						<DeadLetters workspaceId={workspaceId} sinkId={sink.sinkId} />
					) : null}
				</div>
				<Menu>
					<MenuTrigger
						render={
							<Button
								size="icon"
								variant="ghost"
								aria-label={`Actions for ${sink.name}`}
								className="-mr-2 shrink-0"
							/>
						}
					>
						<MoreHorizontal aria-hidden="true" />
					</MenuTrigger>
					<MenuPopup align="end">
						<MenuItem
							disabled={test.isPending || !sink.enabled}
							onClick={() => test.mutate(sink.sinkId)}
						>
							<Send aria-hidden="true" />
							Send test event
						</MenuItem>
						<MenuItem
							disabled={update.isPending}
							onClick={() => setEnabled(!sink.enabled)}
						>
							{sink.enabled ? (
								<Pause aria-hidden="true" />
							) : (
								<Play aria-hidden="true" />
							)}
							{sink.enabled ? "Pause" : "Resume"}
						</MenuItem>
						{sink.type === "webhook" ? (
							<MenuItem onClick={() => setConfirm("rotate")}>
								<KeyRound aria-hidden="true" />
								Rotate signing secret
							</MenuItem>
						) : null}
						<MenuSeparator />
						<MenuItem
							variant="destructive"
							onClick={() => setConfirm("delete")}
						>
							<Trash2 aria-hidden="true" />
							Delete
						</MenuItem>
					</MenuPopup>
				</Menu>
			</div>

			<AlertDialog
				open={confirm !== null}
				onOpenChange={(open) => {
					if (!open) setConfirm(null);
				}}
			>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{confirm === "rotate"
								? `Rotate the signing secret of ${sink.name}?`
								: `Delete ${sink.name}?`}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{confirm === "rotate"
								? "The current secret stops working at once. Update your receiver with the new one, shown next."
								: "Delivery to this sink stops and its dead letters are removed. Stored records stay, and the deletion is itself recorded."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="outline" />}>
							Cancel
						</AlertDialogClose>
						{confirm === "rotate" ? (
							<Button
								loading={update.isPending}
								onClick={() =>
									update.mutate(
										{
											sinkId: sink.sinkId,
											patch: { rotateSigningSecret: true },
										},
										{
											onSuccess: (updated) => {
												setConfirm(null);
												toast.success("Signing secret rotated");
												if (updated.signingSecret)
													onSecret(updated.signingSecret);
											},
										},
									)
								}
							>
								Rotate secret
							</Button>
						) : (
							<Button
								variant="destructive"
								loading={remove.isPending}
								onClick={() =>
									remove.mutate(sink.sinkId, {
										onSuccess: () => setConfirm(null),
									})
								}
							>
								Delete {sink.name}
							</Button>
						)}
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</li>
	);
}

function CopyButton({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	if (!value) return null;
	return (
		<Button
			type="button"
			size="icon"
			variant="ghost"
			className="size-6 shrink-0 [&_svg]:size-3.5"
			aria-label={`Copy ${label}`}
			onClick={async () => {
				const result = await copyToClipboard(value);
				if (!result.success) {
					toast.error(result.error || "Copy failed");
					return;
				}
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
		>
			{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
		</Button>
	);
}

function DeadLetters({
	workspaceId,
	sinkId,
}: {
	workspaceId: string;
	sinkId: string;
}) {
	const letters = useAuditDeadLetters(workspaceId, sinkId);
	const redeliver = useRedeliverDeadLetter(workspaceId, sinkId);
	if (letters.isLoading) return <Skeleton className="mt-2 h-10 w-full" />;
	if (letters.error) {
		return (
			<p aria-live="polite" className="mt-2 text-destructive text-xs">
				{errorText(letters.error)}
			</p>
		);
	}
	if ((letters.data ?? []).length === 0) {
		return (
			<p className="mt-2 text-muted-foreground text-xs">No dead letters.</p>
		);
	}
	return (
		<ul className="mt-2 divide-y border-y text-xs">
			{letters.data?.map((letter) => (
				<li
					key={letter.id}
					className="flex flex-wrap items-center justify-between gap-2 py-2"
				>
					<span className="min-w-0">
						{letter.eventCount} {letter.eventCount === 1 ? "record" : "records"}
						, <RelativeTime value={letter.createdAt} />
						<span className="text-muted-foreground">
							{" "}
							· {letter.lastError ?? "refused"}
						</span>
					</span>
					{letter.redeliveredAt ? (
						<span className="text-muted-foreground">Redelivered</span>
					) : (
						<Button
							size="sm"
							variant="outline"
							loading={redeliver.isPending}
							onClick={() => redeliver.mutate(letter.id)}
						>
							<RotateCcw aria-hidden="true" />
							Redeliver
						</Button>
					)}
				</li>
			))}
		</ul>
	);
}

function errorText(error: Error): string {
	return error instanceof ApiError && error.code
		? `${error.message} (${error.code})`
		: error.message;
}

function TextField({
	name,
	label,
	value,
	onChange,
	placeholder,
	type = "text",
	description,
	required,
}: {
	name: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	type?: string;
	description?: string;
	required?: boolean;
}) {
	const id = useId();
	const descriptionId = useId();
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				name={name}
				type={type}
				autoComplete="off"
				spellCheck={false}
				required={required}
				value={value}
				placeholder={placeholder}
				aria-describedby={description ? descriptionId : undefined}
				onChange={(event) => onChange(event.target.value)}
			/>
			{description ? (
				<p className="text-muted-foreground text-xs" id={descriptionId}>
					{description}
				</p>
			) : null}
		</div>
	);
}

function SwitchField({
	label,
	description,
	checked,
	onCheckedChange,
}: {
	label: string;
	description: string;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	const id = useId();
	const descriptionId = useId();
	return (
		<div className="flex items-start justify-between gap-4">
			<div className="min-w-0">
				<Label htmlFor={id}>{label}</Label>
				<p className="mt-0.5 text-muted-foreground text-xs" id={descriptionId}>
					{description}
				</p>
			</div>
			<Switch
				id={id}
				aria-describedby={descriptionId}
				checked={checked}
				onCheckedChange={onCheckedChange}
				className="mt-0.5"
			/>
		</div>
	);
}

export function RecordsField({
	value,
	onChange,
}: {
	value: RecordsSelection;
	onChange: (value: RecordsSelection) => void;
}) {
	const groupId = useId();
	const customId = useId();
	const picked = value.mode === "categories" ? value.categories : [];
	return (
		<fieldset className="space-y-2" aria-labelledby={groupId}>
			<legend className="font-medium text-sm" id={groupId}>
				Records
			</legend>
			<RadioGroup
				value={value.mode}
				onValueChange={(mode) => {
					if (mode === "all") onChange({ mode: "all" });
					else if (mode === "categories")
						onChange({
							mode: "categories",
							categories: value.mode === "categories" ? value.categories : [],
						});
					else
						onChange({
							mode: "custom",
							text:
								value.mode === "custom"
									? value.text
									: recordsToEventTypes(value).join(", "),
						});
				}}
			>
				<Label className="font-normal">
					<Radio value="all" /> All records
				</Label>
				<Label className="font-normal">
					<Radio value="categories" /> Some categories
				</Label>
				{value.mode === "categories" ? (
					<div className="grid gap-x-4 gap-y-2 py-1 ps-6 sm:grid-cols-2">
						{RECORD_CATEGORIES.map((category) => (
							<Label key={category.id} className="font-normal">
								<Checkbox
									checked={picked.includes(category.id)}
									onCheckedChange={(checked) =>
										onChange({
											mode: "categories",
											categories: checked
												? [...picked, category.id]
												: picked.filter((id) => id !== category.id),
										})
									}
								/>
								{category.label}
							</Label>
						))}
						{picked.length === 0 ? (
							<p className="text-muted-foreground text-xs sm:col-span-2">
								Pick at least one, or every record is sent.
							</p>
						) : null}
					</div>
				) : null}
				<Label className="font-normal">
					<Radio value="custom" /> Event types (advanced)
				</Label>
			</RadioGroup>
			{value.mode === "custom" ? (
				<div className="space-y-1.5 ps-6">
					<Input
						id={customId}
						aria-label="Event types"
						autoComplete="off"
						spellCheck={false}
						value={value.text}
						placeholder="approval.*, policy.updated"
						onChange={(event) =>
							onChange({ mode: "custom", text: event.target.value })
						}
					/>
					<p className="text-muted-foreground text-xs">
						Event types or prefixes, separated by commas.
					</p>
				</div>
			) : null}
		</fieldset>
	);
}

function AddSinkDialog({
	open,
	onOpenChange,
	workspaceId,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string;
	onCreated: (sink: AuditSink) => void;
}) {
	const create = useCreateAuditSink(workspaceId);
	const typeId = useId();
	const siteId = useId();
	const [form, setForm] = useState<SinkForm>(EMPTY_SINK_FORM);
	const set = (field: keyof SinkForm) => (value: string) =>
		setForm((current) => ({ ...current, [field]: value }));

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					setForm(EMPTY_SINK_FORM);
					create.reset();
				}
				onOpenChange(next);
			}}
		>
			<DialogPopup className="sm:max-w-lg">
				<DialogForm
					onSubmit={(event) => {
						event.preventDefault();
						create.mutate(sinkRequest(form), {
							onSuccess: (created) => {
								setForm(EMPTY_SINK_FORM);
								onCreated(created);
							},
						});
					}}
				>
					<DialogHeader>
						<DialogTitle>Add a sink</DialogTitle>
						<DialogDescription>
							Credentials are encrypted and never shown again.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel className="space-y-5">
						<TextField
							name="sink-name"
							label="Name"
							value={form.name}
							onChange={set("name")}
							placeholder="Security SIEM"
							required
						/>
						<div className="space-y-1.5">
							<Label htmlFor={typeId}>Destination</Label>
							<NativeSelect
								id={typeId}
								className="w-full"
								value={form.type}
								onChange={(event) =>
									setForm((current) =>
										withSinkType(current, event.target.value as AuditSinkType),
									)
								}
							>
								{(Object.keys(SINK_TYPE_LABEL) as AuditSinkType[]).map(
									(type) => (
										<NativeSelectOption key={type} value={type}>
											{SINK_TYPE_LABEL[type]}
										</NativeSelectOption>
									),
								)}
							</NativeSelect>
						</div>

						{form.type === "webhook" ? (
							<TextField
								name="sink-url"
								label="URL"
								type="url"
								value={form.url}
								onChange={set("url")}
								placeholder="https://siem.example.com/anlyon"
								description="Each POST carries a signed batch. The signing secret is shown once, after you add the sink."
								required
							/>
						) : null}

						{form.type === "s3" ? (
							<>
								<div className="grid gap-3 sm:grid-cols-2">
									<TextField
										name="sink-bucket"
										label="Bucket"
										value={form.bucket}
										onChange={set("bucket")}
										placeholder="acme-audit"
										required
									/>
									<TextField
										name="sink-region"
										label="Region"
										value={form.region}
										onChange={set("region")}
										placeholder="eu-west-1"
										required
									/>
								</div>
								<div className="grid gap-3 sm:grid-cols-2">
									<TextField
										name="sink-access-key"
										label="Access key ID"
										value={form.accessKeyId}
										onChange={set("accessKeyId")}
										required
									/>
									<TextField
										name="sink-secret-key"
										label="Secret access key"
										type="password"
										value={form.secretAccessKey}
										onChange={set("secretAccessKey")}
										required
									/>
								</div>
								<TextField
									name="sink-prefix"
									label="Key prefix"
									value={form.prefix}
									onChange={set("prefix")}
									description="Objects are gzip NDJSON under prefix/yyyy/mm/dd/."
								/>
								<TextField
									name="sink-endpoint"
									label="Endpoint (optional)"
									type="url"
									value={form.endpoint}
									onChange={set("endpoint")}
									placeholder="https://<account>.r2.cloudflarestorage.com"
									description="For an S3-compatible store such as R2. Leave empty for AWS S3."
								/>
							</>
						) : null}

						{form.type === "datadog" ? (
							<>
								<div className="space-y-1.5">
									<Label htmlFor={siteId}>Site</Label>
									<NativeSelect
										id={siteId}
										className="w-full"
										value={form.site}
										onChange={(event) => set("site")(event.target.value)}
									>
										{DATADOG_SITES.map((site) => (
											<NativeSelectOption key={site} value={site}>
												{site}
											</NativeSelectOption>
										))}
									</NativeSelect>
								</div>
								<TextField
									name="sink-dd-key"
									label="API key"
									type="password"
									value={form.apiKey}
									onChange={set("apiKey")}
									required
								/>
								<TextField
									name="sink-service"
									label="Service"
									value={form.service}
									onChange={set("service")}
								/>
							</>
						) : null}

						{form.type === "splunk" ? (
							<>
								<TextField
									name="sink-hec-url"
									label="HEC URL"
									type="url"
									value={form.url}
									onChange={set("url")}
									placeholder="https://splunk.example.com:8088"
									required
								/>
								<TextField
									name="sink-hec-token"
									label="HEC token"
									type="password"
									value={form.token}
									onChange={set("token")}
									required
								/>
								<div className="grid gap-3 sm:grid-cols-2">
									<TextField
										name="sink-sourcetype"
										label="Sourcetype"
										value={form.sourcetype}
										onChange={set("sourcetype")}
									/>
									<TextField
										name="sink-index"
										label="Index (optional)"
										value={form.index}
										onChange={set("index")}
									/>
								</div>
							</>
						) : null}

						<RecordsField
							value={form.records}
							onChange={(records) =>
								setForm((current) => ({ ...current, records }))
							}
						/>

						<div className="space-y-4">
							<SwitchField
								label="Start with stored records"
								description="Send the records already stored before new ones. Off: records from now on."
								checked={form.startFrom === "beginning"}
								onCheckedChange={(checked) =>
									setForm((current) => ({
										...current,
										startFrom: checked ? "beginning" : "now",
									}))
								}
							/>
							<SwitchField
								label="Include records rebuilt from history"
								description="Also send records Anlyon created afterwards from earlier activity."
								checked={form.includeHistory}
								onCheckedChange={(checked) =>
									setForm((current) => ({
										...current,
										includeHistory: checked,
									}))
								}
							/>
						</div>
						{create.error ? (
							<p aria-live="polite" className="text-destructive text-sm">
								{errorText(create.error)}
							</p>
						) : null}
					</DialogPanel>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>
							Cancel
						</DialogClose>
						<Button type="submit" loading={create.isPending}>
							Add sink
						</Button>
					</DialogFooter>
				</DialogForm>
			</DialogPopup>
		</Dialog>
	);
}

function planRetentionText({
	planRetentionMonths,
	graceUntil,
	hotDays,
	archiveAvailable,
}: {
	planRetentionMonths: number | null;
	graceUntil: string | null;
	hotDays: number | null;
	archiveAvailable: boolean;
}): string {
	const parts: string[] = [];
	parts.push(
		planRetentionMonths === null
			? "Your plan keeps records until you choose otherwise."
			: `Your plan keeps records for ${planRetentionMonths} months.`,
	);
	if (archiveAvailable && hotDays !== null) {
		parts.push(
			`The last ${hotDays} days are listed here; older records move to the archive and are still included in every export.`,
		);
	}
	if (graceUntil) {
		parts.push(
			`Nothing is deleted under a shorter retention before ${new Date(graceUntil).toLocaleDateString(undefined, { dateStyle: "medium" })}.`,
		);
	}
	parts.push("Records past retention are deleted every hour.");
	return parts.join(" ");
}

function RetentionSection({
	workspaceId,
	retentionDays,
	planRetentionMonths,
	graceUntil,
	hotDays,
	archiveAvailable,
}: {
	workspaceId: string;
	retentionDays: number | null;
	planRetentionMonths: number | null;
	graceUntil: string | null;
	hotDays: number | null;
	archiveAvailable: boolean;
}) {
	const update = useUpdateAuditSettings(workspaceId);
	const retentionId = useId();
	const [value, setValue] = useState<string>(
		retentionDays === null ? "" : String(retentionDays),
	);
	const choices = RETENTION_CHOICES.some(
		(choice) => choice.value === retentionDays,
	)
		? RETENTION_CHOICES
		: [
				...RETENTION_CHOICES,
				{ value: retentionDays, label: `${retentionDays} days` },
			];
	const selected = value === "" ? null : Number(value);

	return (
		<SettingsSection
			title="Retention"
			description="How long Anlyon keeps stored records. Copies in your sinks are not affected."
			footer={
				<Button
					size="sm"
					loading={update.isPending}
					disabled={selected === retentionDays}
					onClick={() =>
						update.mutate(
							{ retentionDays: selected },
							{ onSuccess: () => toast.success("Retention saved") },
						)
					}
				>
					Save
				</Button>
			}
		>
			<SettingsRow
				label={<Label htmlFor={retentionId}>Keep records for</Label>}
				description={planRetentionText({
					planRetentionMonths,
					graceUntil,
					hotDays,
					archiveAvailable,
				})}
			>
				<NativeSelect
					id={retentionId}
					value={value}
					onChange={(event) => setValue(event.target.value)}
				>
					{choices.map((choice) => (
						<NativeSelectOption
							key={choice.label}
							value={choice.value === null ? "" : String(choice.value)}
						>
							{choice.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</SettingsRow>
		</SettingsSection>
	);
}

function PrivateDestinationsSection({
	workspaceId,
	allowed,
}: {
	workspaceId: string;
	allowed: boolean;
}) {
	const update = useUpdateAuditSettings(workspaceId);
	const switchId = useId();
	return (
		<SettingsSection title="Private network destinations">
			<SettingsRow
				label={
					<Label htmlFor={switchId}>Allow private network destinations</Label>
				}
				description="For an internal Splunk or MinIO. Cloud metadata and link-local addresses stay refused."
			>
				<Switch
					id={switchId}
					checked={allowed}
					disabled={update.isPending}
					onCheckedChange={(checked) =>
						update.mutate(
							{ allowPrivateDestinations: checked },
							{
								onSuccess: () =>
									toast.success(
										checked
											? "Private destinations allowed"
											: "Private destinations refused",
									),
							},
						)
					}
				/>
			</SettingsRow>
		</SettingsSection>
	);
}

function PrivateDestinationsOff() {
	return (
		<SettingsSection title="Private network destinations">
			<p className="text-sm text-muted-foreground">
				An instance admin has turned off private network destinations on this
				install, so sinks must use public addresses. Instance admins change it
				in Settings, Instance, Network.
			</p>
		</SettingsSection>
	);
}

function isoDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function ExportSection({ workspaceId }: { workspaceId: string }) {
	const environments = useEnvironments(workspaceId);
	const environmentSelectId = useId();
	const formatId = useId();
	const today = new Date();
	const monthAgo = new Date(today.getTime() - 30 * 86_400_000);
	const [from, setFrom] = useState(isoDay(monthAgo));
	const [to, setTo] = useState(isoDay(today));
	const [environmentId, setEnvironmentId] = useState("");
	const [type, setType] = useState("");
	const [action, setAction] = useState("");
	const [format, setFormat] = useState<"json" | "csv">("csv");
	const [downloading, setDownloading] = useState(false);

	async function download() {
		setDownloading(true);
		try {
			const path = exportPath(workspaceId, {
				from,
				to,
				format,
				environmentId,
				type,
				action,
			});
			const response = await fetch(`${API_BASE_URL}/api/v2${path}`, {
				credentials: "include",
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				throw new Error(
					body?.error?.message ??
						`Export failed with status ${response.status}`,
				);
			}
			const blob = await response.blob();
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `anlyon-audit-${from}-to-${to}.${format}`;
			link.click();
			URL.revokeObjectURL(url);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Export failed");
		} finally {
			setDownloading(false);
		}
	}

	return (
		<SettingsSection
			title="Evidence export"
			description="Stored records in a date range, up to a year at a time. Each export is itself recorded."
			footer={
				<Button
					size="sm"
					loading={downloading}
					disabled={!from || !to}
					onClick={download}
				>
					<Download aria-hidden="true" />
					Download
				</Button>
			}
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<TextField
					name="export-from"
					label="From"
					type="date"
					value={from}
					onChange={setFrom}
				/>
				<TextField
					name="export-to"
					label="To (inclusive)"
					type="date"
					value={to}
					onChange={setTo}
				/>
				<div className="space-y-1.5">
					<Label htmlFor={environmentSelectId}>Environment</Label>
					<NativeSelect
						id={environmentSelectId}
						className="w-full"
						value={environmentId}
						onChange={(event) => setEnvironmentId(event.target.value)}
					>
						<NativeSelectOption value="">All environments</NativeSelectOption>
						{(environments.data ?? []).map((environment) => (
							<NativeSelectOption key={environment.id} value={environment.id}>
								{environment.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={formatId}>Format</Label>
					<NativeSelect
						id={formatId}
						className="w-full"
						value={format}
						onChange={(event) =>
							setFormat(event.target.value as "json" | "csv")
						}
					>
						<NativeSelectOption value="csv">CSV</NativeSelectOption>
						<NativeSelectOption value="json">JSON</NativeSelectOption>
					</NativeSelect>
				</div>
				<TextField
					name="export-type"
					label="Record types (optional)"
					value={type}
					onChange={setType}
					placeholder="approval.*, policy.*"
				/>
				<TextField
					name="export-action"
					label="Action (optional)"
					value={action}
					onChange={setAction}
					placeholder="refund_order"
				/>
			</div>
		</SettingsSection>
	);
}

function RecentSection({ workspaceId }: { workspaceId: string }) {
	const events = useRecentAuditEvents(workspaceId);
	const members = useWorkspaceMembers(workspaceId);
	const names = Object.fromEntries(
		(members.data ?? []).map((member) => [
			member.userId,
			member.user?.name || member.user?.email || "A member",
		]),
	);
	const rows = events.data?.data ?? [];
	return (
		<SettingsSection
			title="Latest records"
			description="The 20 most recent stored records."
		>
			{events.isLoading ? (
				<div className="space-y-2">
					<Skeleton className="h-5 w-full" />
					<Skeleton className="h-5 w-full" />
					<Skeleton className="h-5 w-2/3" />
				</div>
			) : events.error ? (
				<p aria-live="polite" className="text-destructive text-sm">
					{errorText(events.error)}
				</p>
			) : rows.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					No records yet. Approvals, invocations and settings changes appear
					here as they happen.
				</p>
			) : (
				<SettingsTableFrame>
					<ul className="divide-y text-sm">
						{rows.map((event) => (
							<li
								key={event.id}
								className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2.5"
							>
								<span title={event.type}>{eventLabel(event.type)}</span>
								<span className="text-muted-foreground text-xs">
									{actorLabel(event.actor, names)}
									{event.outcome ? ` · ${event.outcome}` : ""} ·{" "}
									<RelativeTime value={event.occurredAt} />
								</span>
							</li>
						))}
					</ul>
				</SettingsTableFrame>
			)}
		</SettingsSection>
	);
}
