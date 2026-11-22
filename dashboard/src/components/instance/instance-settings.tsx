import { Check, Copy, Lock } from "lucide-react";
import { type ReactNode, useCallback, useId, useMemo, useState } from "react";
import { CopyValue } from "@/components/settings/identity-shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import {
	type CheckResult,
	type InstanceAdmin,
	type InstanceSetting,
	type InstanceSettingGroup,
	type InstanceStatus,
	useConfirmRootKeyBackup,
	useGrantInstanceAdmin,
	useInstanceAdmins,
	usePreviewLicense,
	useRevokeInstanceAdmin,
	useSendTestEmail,
	useTelemetryPreview,
	useTestStorage,
	useUpdateInstanceSettings,
} from "@/hooks/api/use-instance";
import { API_BASE_URL } from "@/lib/constants";
import {
	checkSettingValue,
	groupStatus,
	type StatusLine,
	shortDate,
} from "@/lib/instance-onboarding";
import { cn, copyToClipboard } from "@/lib/utils";
import { StatusDot } from "./status-dot";

export const GROUPS: Record<
	InstanceSettingGroup,
	{ title: string; description: string }
> = {
	email: {
		title: "Email",
		description:
			"Invitations, password resets and notifications. Without it, invitation links are shown in the console for you to pass on, and new accounts skip address confirmation.",
	},
	storage: {
		title: "File storage",
		description:
			"Where log archives are kept: a directory on this server, or any S3-compatible store (AWS S3, MinIO, Ceph).",
	},
	accounts: {
		title: "Sign-up",
		description:
			"Who may create an account. Invite only is the safe default: people join when a workspace admin invites them.",
	},
	license: {
		title: "Licence",
		description:
			"A Team or Enterprise key unlocks single sign-on, directory sync, audit streaming and more. It is verified on this server; nothing is sent anywhere.",
	},
	telemetry: {
		title: "Anonymous telemetry",
		description:
			"One small anonymous report a day, so Anlyon can tell how many installs exist and which features are used. Turn it off at any time.",
	},
	oauth: {
		title: "OAuth apps",
		description:
			"One OAuth app per integration people sign in to. An integration without one is not offered on this server.",
	},
	slack: {
		title: "Slack app",
		description:
			"The Slack app that posts notifications and approval requests, and receives approve and deny clicks.",
	},
	mcp: {
		title: "MCP servers",
		description:
			"How often Anlyon lists each MCP server again, so people hear that a tool changed before an agent calls it. Every call checks its tool whatever this is set to.",
	},
	network: {
		title: "Network",
		description:
			"Whether audit sinks and secret stores may reach addresses on your private network, such as an internal Splunk or a Vault at 10.0.0.5. Left to each workspace's admins by default; turn it off to keep every workspace on public addresses.",
	},
};

const CHOICES: Record<string, { value: string; label: string }[]> = {
	"storage.backend": [
		{ value: "none", label: "None" },
		{ value: "local", label: "A directory on this server" },
		{ value: "s3", label: "S3-compatible store" },
	],
	"accounts.signup_mode": [
		{ value: "invite", label: "Invite only" },
		{ value: "open", label: "Anyone who can reach this console" },
		{ value: "closed", label: "Nobody (accounts from the command line)" },
	],
	"network.private_destinations": [
		{ value: "workspace", label: "Each workspace's admins decide" },
		{ value: "off", label: "Never: public addresses only" },
	],
};
const SWITCHES = new Set([
	"storage.s3_force_path_style",
	"storage.audit_archive_paused",
	"telemetry.enabled",
]);

function apiOrigin(): string {
	return API_BASE_URL || window.location.origin;
}

export function useAdminNames(): (userId: string | null) => string | null {
	const { data } = useInstanceAdmins();
	return useCallback(
		(userId: string | null) => {
			if (!userId) return null;
			const admin = (data ?? []).find(
				(a: InstanceAdmin) => a.userId === userId,
			);
			return admin?.name || admin?.email || null;
		},
		[data],
	);
}

export type Draft = Record<string, string | null>;

export function useSettingsDraft(settings: InstanceSetting[] | undefined) {
	const [draft, setDraftState] = useState<Draft>({});
	const byKey = useMemo(
		() => new Map((settings ?? []).map((s) => [s.key, s])),
		[settings],
	);
	const set = useCallback(
		(key: string, value: string | null) => {
			setDraftState((previous) => {
				const next = { ...previous };
				const saved = byKey.get(key);
				const unchanged =
					saved &&
					!saved.secret &&
					value !== null &&
					value === (saved.value ?? saved.default ?? "");
				if (unchanged || (saved?.secret && value === "")) delete next[key];
				else next[key] = value;
				return next;
			});
		},
		[byKey],
	);
	const reset = useCallback((keys?: string[]) => {
		setDraftState((previous) => {
			if (!keys) return {};
			const next = { ...previous };
			for (const key of keys) delete next[key];
			return next;
		});
	}, []);
	const errors = useMemo(() => {
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(draft)) {
			const problem = value === null ? null : checkSettingValue(key, value);
			if (problem) out[key] = problem;
		}
		return out;
	}, [draft]);
	return { draft, set, reset, errors, changed: Object.keys(draft) };
}

function EnvironmentValue({ setting }: { setting: InstanceSetting }) {
	return (
		<div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border border-dashed px-3 py-1.5 text-[13px]">
			<span className="inline-flex items-center gap-1.5 text-muted-foreground">
				<Lock aria-hidden="true" className="size-3.5" />
				<span className="ed-label">Environment</span>
			</span>
			<code className="font-mono text-[12px]">{setting.env}</code>
			<span className="min-w-0 truncate text-muted-foreground">
				{setting.secret ? "set" : setting.value ? `= ${setting.value}` : "set"}
			</span>
		</div>
	);
}

function SecretValue({
	setting,
	draft,
	id,
	describedBy,
	onChange,
}: {
	setting: InstanceSetting;
	draft: string | null | undefined;
	id: string;
	describedBy: string;
	onChange: (value: string | null) => void;
}) {
	const [replacing, setReplacing] = useState(false);
	if (draft === null) {
		return (
			<div className="flex min-h-9 items-center justify-between gap-3 border border-dashed px-3 text-[13px]">
				<span className="text-muted-foreground">Cleared when you save</span>
				<Button onClick={() => onChange("")} size="xs" variant="ghost">
					Undo
				</Button>
			</div>
		);
	}
	if (setting.set && !replacing && !draft) {
		return (
			<div className="flex min-h-9 flex-wrap items-center justify-between gap-2 border px-3 py-1 text-[13px]">
				<span className="inline-flex items-center gap-2">
					<StatusDot tone="ok" />
					Set
					{setting.updatedAt ? (
						<span className="text-muted-foreground">
							· updated {shortDate(setting.updatedAt)}
						</span>
					) : null}
				</span>
				<span className="flex gap-1">
					<Button
						aria-label={`Replace ${setting.label}`}
						onClick={() => setReplacing(true)}
						size="xs"
						variant="ghost"
					>
						Replace
					</Button>
					<Button
						aria-label={`Clear ${setting.label}`}
						onClick={() => onChange(null)}
						size="xs"
						variant="ghost"
					>
						Clear
					</Button>
				</span>
			</div>
		);
	}
	return (
		<div className="flex gap-2">
			<Input
				aria-describedby={describedBy}
				aria-labelledby={`${id}-label`}
				autoComplete="off"
				// biome-ignore lint/a11y/noAutofocus: focus follows the Replace press
				autoFocus={replacing}
				id={id}
				onChange={(event) => onChange(event.target.value)}
				placeholder={setting.set ? "New value" : "Not set"}
				spellCheck={false}
				type="password"
				value={draft ?? ""}
			/>
			{replacing ? (
				<Button
					onClick={() => {
						setReplacing(false);
						onChange("");
					}}
					variant="ghost"
				>
					Cancel
				</Button>
			) : null}
		</div>
	);
}

export function SettingField({
	setting,
	draft,
	error,
	onChange,
	stacked = false,
}: {
	setting: InstanceSetting;
	draft: string | null | undefined;
	error?: string;
	onChange: (value: string | null) => void;
	stacked?: boolean;
}) {
	const id = `setting-${setting.key}`;
	const hintId = `${id}-hint`;
	const current = draft ?? setting.value ?? "";
	let control: ReactNode;
	if (setting.source === "environment") {
		control = <EnvironmentValue setting={setting} />;
	} else if (setting.secret) {
		control = (
			<SecretValue
				describedBy={hintId}
				draft={draft}
				id={id}
				onChange={onChange}
				setting={setting}
			/>
		);
	} else if (SWITCHES.has(setting.key)) {
		control = (
			<div className="flex min-h-9 items-center">
				<Switch
					aria-describedby={hintId}
					checked={(current || setting.default) === "true"}
					id={id}
					onCheckedChange={(checked) => onChange(checked ? "true" : "false")}
				/>
			</div>
		);
	} else if (CHOICES[setting.key]) {
		control = (
			<NativeSelect
				aria-describedby={hintId}
				id={id}
				onChange={(event) => onChange(event.target.value)}
				value={current || setting.default || ""}
			>
				{!setting.default && !current ? (
					<NativeSelectOption value="">Not set</NativeSelectOption>
				) : null}
				{CHOICES[setting.key]!.map((choice) => (
					<NativeSelectOption key={choice.value} value={choice.value}>
						{choice.label}
					</NativeSelectOption>
				))}
			</NativeSelect>
		);
	} else {
		control = (
			<Input
				aria-describedby={hintId}
				aria-invalid={error ? true : undefined}
				autoComplete="off"
				id={id}
				onChange={(event) => onChange(event.target.value)}
				placeholder={setting.default ?? ""}
				spellCheck={false}
				value={current}
			/>
		);
	}
	const labelled =
		setting.source === "environment" || (setting.secret && setting.set);
	return (
		<div
			className={cn(
				"grid gap-x-8 gap-y-2 py-4 first:pt-0 last:pb-0",
				!stacked && "sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]",
			)}
			data-setting={setting.key}
		>
			<div className="min-w-0">
				{labelled ? (
					<span className="font-medium text-[13px]" id={`${id}-label`}>
						{setting.label}
					</span>
				) : (
					<label
						className="font-medium text-[13px]"
						htmlFor={id}
						id={`${id}-label`}
					>
						{setting.label}
					</label>
				)}
				{draft !== undefined ? (
					<span className="ml-2 text-[11px] text-muted-foreground">Edited</span>
				) : null}
			</div>
			<div className="flex min-w-0 flex-col gap-1.5">
				{control}
				{error ? (
					<p className="text-[12px] text-destructive-foreground" id={hintId}>
						{error}
					</p>
				) : (
					<p className="text-[12px] text-muted-foreground" id={hintId}>
						{setting.source === "environment"
							? `Set where this server is deployed. Change ${setting.env} there and restart.`
							: setting.description}
					</p>
				)}
			</div>
		</div>
	);
}

export function GroupFields({
	group,
	settings,
	draft,
	errors,
	onChange,
	stacked,
}: {
	group: InstanceSettingGroup;
	settings: InstanceSetting[];
	draft: Draft;
	errors: Record<string, string>;
	onChange: (key: string, value: string | null) => void;
	stacked?: boolean;
}) {
	const inGroup = settings.filter((setting) => setting.group === group);
	const saved = settings.find((s) => s.key === "storage.backend");
	const backend =
		draft["storage.backend"] ?? saved?.value ?? saved?.default ?? "none";
	const shown = inGroup.filter((setting) => {
		if (group !== "storage" || setting.key === "storage.backend") return true;
		if (setting.key.startsWith("storage.audit_")) return true;
		if (setting.key === "storage.local_dir") return backend === "local";
		return backend === "s3";
	});
	return (
		<div className="divide-y">
			{shown.map((setting) => (
				<SettingField
					draft={draft[setting.key]}
					error={errors[setting.key]}
					key={`${setting.key}:${setting.updatedAt ?? ""}`}
					onChange={(value) => onChange(setting.key, value)}
					setting={setting}
					stacked={stacked}
				/>
			))}
		</div>
	);
}

export function SettingGroupForm({
	group,
	settings,
	children,
	onSaved,
}: {
	group: InstanceSettingGroup;
	settings: InstanceSetting[];
	children?: (unsaved: boolean) => ReactNode;
	onSaved?: () => void;
}) {
	const { draft, set, reset, errors, changed } = useSettingsDraft(settings);
	const update = useUpdateInstanceSettings();
	const blocked = Object.keys(errors).length > 0;
	return (
		<div className="flex flex-col gap-4">
			<form
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					if (changed.length === 0 || blocked) return;
					update.mutate(draft, {
						onSuccess: () => {
							reset();
							onSaved?.();
						},
					});
				}}
			>
				<GroupFields
					draft={draft}
					errors={errors}
					group={group}
					onChange={set}
					settings={settings}
					stacked
				/>
				<div className="flex items-center justify-end gap-2">
					{changed.length > 0 ? (
						<Button onClick={() => reset()} size="sm" variant="ghost">
							Discard
						</Button>
					) : null}
					<Button
						disabled={changed.length === 0 || blocked}
						loading={update.isPending}
						size="sm"
						type="submit"
					>
						Save
					</Button>
				</div>
			</form>
			{children?.(changed.length > 0)}
		</div>
	);
}

export function StatusText({
	status,
	nameOf,
	className,
	compact = false,
}: {
	status: StatusLine;
	nameOf?: (userId: string | null) => string | null;
	className?: string;
	compact?: boolean;
}) {
	const who = nameOf?.(status.updatedBy) ?? null;
	return (
		<span
			className={cn(
				"inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted-foreground",
				className,
			)}
		>
			<span className="inline-flex items-center gap-1.5 text-foreground">
				<StatusDot tone={status.tone} />
				{status.label}
			</span>
			{status.detail ? <span>{status.detail}</span> : null}
			{status.updatedAt && !compact ? (
				<span>
					updated {shortDate(status.updatedAt)}
					{who ? ` by ${who}` : ""}
				</span>
			) : null}
		</span>
	);
}

export function useGroupStatus(
	group: InstanceSettingGroup,
	settings: InstanceSetting[],
): StatusLine {
	return useMemo(() => groupStatus(group, settings), [group, settings]);
}

function CheckLine({
	pending,
	pendingText,
	result,
	idleText,
}: {
	pending: boolean;
	pendingText: string;
	result: CheckResult | undefined;
	idleText?: string;
}) {
	return (
		<p
			aria-live="polite"
			className="flex min-h-5 items-start gap-2 text-[12px]"
			role="status"
		>
			{pending ? (
				<>
					<Spinner className="mt-0.5 size-3 text-muted-foreground" />
					<span className="text-muted-foreground">{pendingText}</span>
				</>
			) : result ? (
				<span
					className="onboarding-enter inline-flex items-start gap-2"
					key={result.message}
				>
					<StatusDot className="mt-[5px]" tone={result.ok ? "ok" : "warn"} />
					<span
						className={
							result.ok ? "text-foreground" : "text-destructive-foreground"
						}
					>
						{result.message}
					</span>
				</span>
			) : idleText ? (
				<span className="text-muted-foreground">{idleText}</span>
			) : null}
		</p>
	);
}

function CheckBox({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-2 border-t pt-4">
			<span className="ed-label text-muted-foreground">{title}</span>
			{children}
		</div>
	);
}

const SAVE_FIRST = "Save your changes first: the test uses the saved settings.";

export function EmailTest({
	defaultTo = "",
	unsaved = false,
}: {
	defaultTo?: string;
	unsaved?: boolean;
}) {
	const [to, setTo] = useState(defaultTo);
	const send = useSendTestEmail();
	const id = useId();
	return (
		<CheckBox title="Test">
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (to && !unsaved) send.mutate(to);
				}}
			>
				<label className="sr-only" htmlFor={id}>
					Send a test email to
				</label>
				<Input
					autoComplete="email"
					id={id}
					onChange={(event) => setTo(event.target.value)}
					placeholder="you@example.com"
					type="email"
					value={to}
				/>
				<Button
					disabled={!to || unsaved || send.isPending}
					type="submit"
					variant="outline"
				>
					Send test email
				</Button>
			</form>
			<CheckLine
				idleText={
					unsaved ? SAVE_FIRST : "Sends one message with the saved settings."
				}
				pending={send.isPending}
				pendingText={`Sending to ${to}`}
				result={unsaved ? undefined : send.data}
			/>
		</CheckBox>
	);
}

export function StorageTest({ unsaved = false }: { unsaved?: boolean }) {
	const test = useTestStorage();
	return (
		<CheckBox title="Test">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<CheckLine
					idleText={
						unsaved
							? SAVE_FIRST
							: "Writes, reads back and deletes one small object."
					}
					pending={test.isPending}
					pendingText="Writing, reading back, deleting"
					result={unsaved ? undefined : test.data}
				/>
				<Button
					disabled={unsaved || test.isPending}
					onClick={() => test.mutate()}
					variant="outline"
				>
					Test storage
				</Button>
			</div>
		</CheckBox>
	);
}

export function LicensePreviewBox() {
	const [key, setKey] = useState("");
	const preview = usePreviewLicense();
	const result = preview.data;
	const id = useId();
	return (
		<CheckBox title="Check a key">
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (key) preview.mutate(key);
				}}
			>
				<label className="sr-only" htmlFor={id}>
					Licence key to check
				</label>
				<Input
					autoComplete="off"
					id={id}
					onChange={(event) => setKey(event.target.value)}
					placeholder="anlyon_lic_v1"
					spellCheck={false}
					value={key}
				/>
				<Button
					disabled={!key || preview.isPending}
					type="submit"
					variant="outline"
				>
					Verify
				</Button>
			</form>
			<CheckLine
				idleText="Verified on this server without saving it."
				pending={preview.isPending}
				pendingText="Verifying"
				result={
					result
						? {
								ok: result.valid,
								message: result.tier
									? `${result.message} ${result.tier === "team" ? "Team" : "Enterprise"} for ${result.org}, ${result.seats} seats, expires ${shortDate(result.expiresAt)}.`
									: result.message,
							}
						: undefined
				}
			/>
		</CheckBox>
	);
}

export function TelemetryExplainer() {
	const [show, setShow] = useState(false);
	const preview = useTelemetryPreview(show);
	return (
		<CheckBox title="What the report holds">
			<ul className="flex flex-col gap-1 text-[13px] text-muted-foreground">
				<li>A random id made for this install, not derived from it</li>
				<li>The version and the edition</li>
				<li>How many workspaces, members and actions exist</li>
				<li>
					For the last day: invocations run, effects by receipt grade, approvals
					requested and decided
				</li>
			</ul>
			<p className="text-[12px] text-muted-foreground">
				No names, email addresses, hostnames, IP addresses, URLs, payloads,
				action names or licence details. A report that cannot be delivered is
				dropped.
			</p>
			<div>
				<Button
					aria-expanded={show}
					onClick={() => setShow((value) => !value)}
					size="xs"
					variant="outline"
				>
					{show ? "Hide the next report" : "Show the next report"}
				</Button>
			</div>
			{show ? (
				preview.data ? (
					<pre className="onboarding-enter max-h-64 overflow-auto bg-muted p-3 font-mono text-[12px]">
						{JSON.stringify(preview.data, null, 2)}
					</pre>
				) : (
					<CheckLine
						pending
						pendingText="Building the report"
						result={undefined}
					/>
				)
			) : null}
		</CheckBox>
	);
}

export function OAuthRedirects() {
	return (
		<CheckBox title="Register in each OAuth app">
			<CopyValue
				label="Redirect URI"
				value={`${apiOrigin()}/api/v2/connection-consent/callback`}
			/>
		</CheckBox>
	);
}

export function SlackUrls() {
	return (
		<CheckBox title="Set in the Slack app">
			<div className="flex flex-col gap-2">
				<CopyValue
					label="Redirect URL (OAuth)"
					value={`${apiOrigin()}/api/v2/integrations/slack/callback`}
				/>
				<CopyValue
					label="Redirect URL (linking members)"
					value={`${apiOrigin()}/api/slack/identity/callback`}
				/>
				<CopyValue
					label="Interactivity request URL"
					value={`${apiOrigin()}/api/slack/interactions`}
				/>
			</div>
		</CheckBox>
	);
}

export function GroupExtras({
	group,
	unsaved = false,
	email,
}: {
	group: InstanceSettingGroup;
	unsaved?: boolean;
	email?: string;
}) {
	switch (group) {
		case "email":
			return <EmailTest defaultTo={email} unsaved={unsaved} />;
		case "storage":
			return <StorageTest unsaved={unsaved} />;
		case "license":
			return <LicensePreviewBox />;
		case "telemetry":
			return <TelemetryExplainer />;
		case "oauth":
			return <OAuthRedirects />;
		case "slack":
			return <SlackUrls />;
		default:
			return null;
	}
}

export const ROOT_KEY_COMMAND = "sudo grep ANLYON_ROOT_KEY /opt/anlyon/.env";

function CommandLine({ command }: { command: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex min-w-0 items-center gap-2 border bg-muted/40 py-1 pr-1 pl-3">
			<code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
				<span aria-hidden="true" className="select-none text-muted-foreground">
					${" "}
				</span>
				{command}
			</code>
			<Button
				aria-label="Copy the command"
				onClick={async () => {
					const result = await copyToClipboard(command);
					if (!result.success) {
						toast.error(result.error || "Copy failed");
						return;
					}
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1600);
				}}
				size="icon-xs"
				variant="ghost"
			>
				{copied ? <Check /> : <Copy />}
			</Button>
		</div>
	);
}

export function RootKeyBackup({
	status,
	confirmLabel = "Confirm",
	onConfirmed,
	nameOf,
}: {
	status: InstanceStatus;
	confirmLabel?: string;
	onConfirmed?: () => void;
	nameOf?: (userId: string | null) => string | null;
}) {
	const [understood, setUnderstood] = useState(false);
	const confirm = useConfirmRootKeyBackup();
	const checkboxId = useId();
	const { rootKey } = status;
	if (!rootKey.inUse) {
		return (
			<p className="text-[13px] text-muted-foreground">
				This server does not use a root key: its master keys are set one by one
				where it is deployed (BETTER_AUTH_SECRET, DELIVERY_SECRET_MASTER_KEY and
				the others). Keep a copy of each the same way.
			</p>
		);
	}
	const who = nameOf?.(rootKey.backupConfirmedBy) ?? null;
	return (
		<div className="flex flex-col gap-5 text-[13px]">
			<div className="flex flex-col gap-2">
				<span className="ed-label text-muted-foreground">Where it is</span>
				<p>
					<code className="font-mono text-[12.5px]">ANLYON_ROOT_KEY</code> in
					the server's <code className="font-mono text-[12.5px]">.env</code>. To
					read it on the server:
				</p>
				<CommandLine command={ROOT_KEY_COMMAND} />
				<p className="text-[12px] text-muted-foreground">
					/opt/anlyon is the installer's default. From a clone of the
					repository, it is deploy/self-host/.env. The console does not show the
					key.
				</p>
			</div>
			<dl className="grid gap-x-6 gap-y-2 border-y py-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
				<dt className="text-muted-foreground">If it is lost</dt>
				<dd>
					Stored secrets and connected accounts cannot be read again. Nobody can
					recover them.
				</dd>
				<dt className="text-muted-foreground">If it changes</dt>
				<dd>Everyone is signed out and every API key stops working.</dd>
				<dt className="text-muted-foreground">If it leaks</dt>
				<dd>
					Anyone with it and a copy of the database can read every stored
					secret. Keep it as private as the database.
				</dd>
			</dl>
			{rootKey.backupConfirmedAt ? (
				<p className="inline-flex items-center gap-2">
					<StatusDot tone="ok" />
					Copy confirmed {shortDate(rootKey.backupConfirmedAt)}
					{who ? ` by ${who}` : ""}.
				</p>
			) : (
				<div className="flex flex-wrap items-center justify-between gap-4">
					<label
						className="flex cursor-pointer items-start gap-2.5"
						htmlFor={checkboxId}
					>
						<Checkbox
							checked={understood}
							className="mt-0.5"
							id={checkboxId}
							onCheckedChange={(checked) => setUnderstood(checked === true)}
						/>
						<span>I have a copy somewhere other than this server.</span>
					</label>
					<Button
						disabled={!understood}
						loading={confirm.isPending}
						onClick={() =>
							confirm.mutate(undefined, { onSuccess: () => onConfirmed?.() })
						}
					>
						{confirmLabel}
					</Button>
				</div>
			)}
		</div>
	);
}

export function InstanceAdminsList({
	currentUserId,
}: {
	currentUserId?: string;
}) {
	const { data: admins, isLoading } = useInstanceAdmins();
	const grant = useGrantInstanceAdmin();
	const revoke = useRevokeInstanceAdmin();
	const [email, setEmail] = useState("");
	const sorted = admins ?? [];
	const emailId = useId();
	return (
		<div className="flex flex-col gap-4">
			<ul className="divide-y border">
				{isLoading ? (
					<li className="px-3 py-2.5 text-[13px] text-muted-foreground">
						Loading
					</li>
				) : null}
				{sorted.map((admin) => (
					<li
						className="flex items-center justify-between gap-3 px-3 py-2"
						key={admin.userId}
					>
						<span className="flex min-w-0 items-baseline gap-2 text-[13px]">
							<span className="truncate font-medium">{admin.name}</span>
							<span className="truncate text-muted-foreground">
								{admin.email}
							</span>
							{admin.userId === currentUserId ? (
								<span className="text-[11px] text-muted-foreground">You</span>
							) : null}
						</span>
						<Button
							aria-label={`Revoke instance admin from ${admin.email}`}
							disabled={sorted.length <= 1 || revoke.isPending}
							onClick={() => revoke.mutate(admin.userId)}
							size="xs"
							title={
								sorted.length <= 1
									? "The last instance admin cannot be removed"
									: undefined
							}
							variant="ghost"
						>
							Revoke
						</Button>
					</li>
				))}
			</ul>
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (email) grant.mutate(email, { onSuccess: () => setEmail("") });
				}}
			>
				<label className="sr-only" htmlFor={emailId}>
					Email of an existing account
				</label>
				<Input
					id={emailId}
					onChange={(event) => setEmail(event.target.value)}
					placeholder="Email of an existing account"
					type="email"
					value={email}
				/>
				<Button
					disabled={!email}
					loading={grant.isPending}
					type="submit"
					variant="outline"
				>
					Make instance admin
				</Button>
			</form>
		</div>
	);
}
