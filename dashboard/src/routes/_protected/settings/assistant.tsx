import { createFileRoute } from "@tanstack/react-router";
import { Check, Plus, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Pill,
	TONE_SURFACE,
	TONE_TEXT,
	type Tone,
} from "@/components/approvals/tone";
import { FeatureStageBadge } from "@/components/feature-stage-badge";
import {
	SettingsPage,
	SettingsSection,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useWorkspace } from "@/contexts/workspace-context";
import { useActions } from "@/hooks/api/use-actions";
import { useApprovals } from "@/hooks/api/use-approvals";
import {
	useAssistantSettings,
	useUpdateAssistantSettings,
} from "@/hooks/api/use-assistant";
import { useCan } from "@/hooks/api/use-permissions";
import {
	MIN_CONFIDENCE_FLOOR,
	projectMonthly,
	RISK_LABEL,
	RISK_LEVELS,
	replayLimits,
} from "@/lib/assistant";
import { requireFeature } from "@/lib/feature-flags";
import type {
	AssistantAutoApprove,
	AssistantSettings,
	AssistantSettingsPatch,
	AssistantUsageCounter,
} from "@/lib/types";
import { useUnsavedChangesGuard } from "@/lib/unsaved-changes";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_protected/settings/assistant")({
	beforeLoad: () => requireFeature("ai-assistant"),
	component: AssistantSettingsPage,
});

export function AssistantSettingsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const {
		data: settings,
		isLoading,
		error,
	} = useAssistantSettings(workspaceId);
	const update = useUpdateAssistantSettings(workspaceId);
	const canManage = useCan(workspaceId)("assistant.manage");

	return (
		<SettingsPage
			title="Vigil"
			description="An AI reviewer that reads each approval your policies send for review and suggests a decision, so your approvers decide faster. Your policies always decide before it does."
		>
			{error ? (
				<p aria-live="polite" className="text-destructive text-sm">
					{error.message}
				</p>
			) : isLoading || !settings ? (
				<div className="space-y-3">
					<Skeleton className="h-28 w-full rounded-lg" />
					<Skeleton className="h-28 w-full rounded-lg" />
				</div>
			) : (
				<>
					{!canManage ? (
						<p className="text-muted-foreground text-sm">
							A workspace admin changes these settings.
						</p>
					) : null}
					<AssistantSettingsForm
						key={settings.consentedAt ?? "none"}
						onSave={(patch) => {
							if (canManage) update.mutate(patch);
						}}
						saving={update.isPending || !canManage}
						settings={settings}
						workspaceId={workspaceId}
					/>
				</>
			)}
		</SettingsPage>
	);
}

function AssistantSettingsForm({
	settings,
	onSave,
	saving,
	workspaceId,
}: {
	settings: AssistantSettings;
	onSave: (patch: AssistantSettingsPatch) => void;
	saving: boolean;
	workspaceId?: string;
}) {
	const [consenting, setConsenting] = useState(false);
	const [dirtySections, setDirtySections] = useState<Record<string, boolean>>(
		{},
	);
	const markDirty = useCallback(
		(section: string) => (dirty: boolean) =>
			setDirtySections((current) =>
				current[section] === dirty ? current : { ...current, [section]: dirty },
			),
		[],
	);
	const onExcludedDirty = useMemo(() => markDirty("excluded"), [markDirty]);
	const onLimitsDirty = useMemo(() => markDirty("limits"), [markDirty]);
	const blocker = useUnsavedChangesGuard(
		Object.values(dirtySections).some(Boolean),
	);

	return (
		<>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open && blocker.status === "blocked") blocker.reset();
				}}
				open={blocker.status === "blocked"}
			>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>Leave without saving?</AlertDialogTitle>
						<AlertDialogDescription>
							Your changes to{" "}
							{[
								dirtySections.excluded ? "excluded fields" : null,
								dirtySections.limits ? "auto-approve limits" : null,
							]
								.filter(Boolean)
								.join(" and ")}{" "}
							are not saved. Leaving discards them.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose
							onClick={() => blocker.reset?.()}
							render={<Button variant="ghost" />}
						>
							Stay
						</AlertDialogClose>
						<AlertDialogClose
							onClick={() => blocker.proceed?.()}
							render={<Button variant="outline" />}
						>
							Leave without saving
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>

			<SettingsSection
				title="Suggestions"
				description="Each approval a policy routes for review gets a verdict and the checks behind it: risk, how it compares with this agent's history, the amount, and signs of injected instructions. Reviewers see it in the inbox and in Slack."
			>
				<div className="flex items-center justify-between gap-4">
					<div className="flex items-center gap-2">
						<Label htmlFor="assistant-enabled">
							Vigil suggestions for approvals
						</Label>
						<FeatureStageBadge feature="ai-assistant" />
					</div>
					<Switch
						checked={settings.enabled}
						disabled={!settings.available || saving}
						id="assistant-enabled"
						onCheckedChange={(checked) => {
							if (checked) setConsenting(true);
							else onSave({ enabled: false });
						}}
					/>
				</div>
				{!settings.available ? (
					<p className="mt-3 text-muted-foreground text-sm">
						Vigil is not available on this deployment.
					</p>
				) : settings.consentVersion &&
					settings.consentVersion !== settings.currentConsentVersion ? (
					<p className={cn("mt-3 text-sm", TONE_TEXT.amber)}>
						What is shared has changed since you agreed. Turn it on again to
						review and accept the current terms.
					</p>
				) : (
					<p className="mt-3 text-muted-foreground text-sm">
						Turning it off stops all calls at once and also turns auto-approve
						off.
					</p>
				)}
			</SettingsSection>

			<UsageSection settings={settings} />

			<ExcludedFieldsSection
				onDirtyChange={onExcludedDirty}
				onSave={onSave}
				saving={saving}
				settings={settings}
			/>

			{settings.enabled ? (
				<AutoApproveSection
					key={JSON.stringify(settings.autoApprove) + settings.auditSampleRate}
					onDirtyChange={onLimitsDirty}
					onSave={onSave}
					saving={saving}
					settings={settings}
					workspaceId={workspaceId}
				/>
			) : null}

			<AlertDialog onOpenChange={setConsenting} open={consenting}>
				<AlertDialogPopup className="sm:max-w-xl">
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2">
							<ShieldAlert aria-hidden="true" className="size-4" />
							Turn on Vigil?
						</AlertDialogTitle>
						<AlertDialogDescription render={<div />}>
							<p>
								For each approval your policies send for review, Vigil reviews
								it through an upstream AI provider, bound by our data processing
								terms. Write to support@anlyon.com for the provider's name.
							</p>
							<div className="mt-3 grid gap-3 text-left sm:grid-cols-2">
								<div
									className={cn("rounded-lg border p-3", TONE_SURFACE.neutral)}
								>
									<p className="mb-1.5 font-medium text-foreground text-xs">
										Sent
									</p>
									<ul className="space-y-1 text-xs">
										<li>The approval title and description</li>
										<li>The request kind and the agent id</li>
										<li>Action, method and destination host</li>
										<li>The amount, if there is one</li>
										<li>
											Input, with sensitive keys redacted and your excluded
											fields removed, cut at 8,000 characters
										</li>
										<li>The matched policy</li>
										<li>A 30-day summary of similar decisions</li>
									</ul>
								</div>
								<div
									className={cn("rounded-lg border p-3", TONE_SURFACE.emerald)}
								>
									<p className="mb-1.5 font-medium text-foreground text-xs">
										Never sent
									</p>
									<ul className="space-y-1 text-xs">
										<li>Secret values</li>
										<li>URL paths and query strings</li>
										<li>Who approved what</li>
										<li>Anything from workspaces that did not opt in</li>
									</ul>
								</div>
							</div>
							<p className="mt-3">
								Suggestions are advice. Your approvers still decide unless you
								separately turn on auto-approve. You can turn it off at any
								time.
							</p>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<AlertDialogClose
							onClick={() =>
								onSave({
									enabled: true,
									consentVersion: settings.currentConsentVersion,
								})
							}
							render={<Button loading={saving} />}
						>
							I agree, turn it on
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</>
	);
}

function UsageSection({ settings }: { settings: AssistantSettings }) {
	const { reviews, autoApprovals } = settings.usage;
	const now = new Date();
	const pace = projectMonthly(reviews.used, now);
	const reviewCap = reviews.cap === "unlimited" ? null : reviews.cap;
	const overPace = reviewCap !== null && pace.projected > reviewCap;
	const capDay =
		overPace && pace.perDay > 0
			? new Date(
					Date.UTC(
						now.getUTCFullYear(),
						now.getUTCMonth(),
						Math.min(
							pace.daysInMonth,
							Math.ceil((reviewCap as number) / pace.perDay),
						),
					),
				)
			: null;
	const midnight = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
	);
	const hoursLeft = Math.max(
		1,
		Math.round((midnight.getTime() - now.getTime()) / 3_600_000),
	);
	const monthDay = new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});

	return (
		<SettingsSection
			title="Usage"
			description="Hard limits from your plan. Nothing is billed for going over: at the review limit requests still reach your approvers, without a suggestion. At the approval limit they wait for an approver."
		>
			<div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
				<UsageTile
					counter={reviews}
					label="Reviews this month"
					note={
						reviewCap === null
							? `About ${Math.round(pace.perDay)} a day.`
							: overPace && capDay
								? `About ${Math.round(pace.perDay)} a day: at this pace suggestions pause around ${monthDay.format(capDay)}.`
								: `About ${Math.round(pace.perDay)} a day, on pace for ${pace.projected.toLocaleString()} this month.`
					}
					tone={overPace ? "amber" : "neutral"}
					unit="reviews"
				/>
				<UsageTile
					counter={autoApprovals}
					label="Vigil approvals today"
					note={`Resets at 00:00 UTC, in about ${hoursLeft}h.`}
					tone={
						autoApprovals.cap !== "unlimited" &&
						autoApprovals.used >= autoApprovals.cap
							? "amber"
							: "neutral"
					}
					unit="approvals"
				/>
			</div>
		</SettingsSection>
	);
}

function UsageTile({
	label,
	counter,
	unit,
	note,
	tone,
}: {
	label: string;
	counter: AssistantUsageCounter;
	unit: string;
	note: string;
	tone: Tone;
}) {
	const unlimited = counter.cap === "unlimited";
	const left = unlimited
		? null
		: Math.max(0, (counter.cap as number) - counter.used);
	const share = unlimited
		? 0
		: Math.min(100, (counter.used / Math.max(1, counter.cap as number)) * 100);
	return (
		<div className="flex min-w-0 flex-col">
			<div className="flex items-baseline justify-between gap-3">
				<p className="text-muted-foreground text-xs">{label}</p>
				{left !== null ? (
					<p className="text-muted-foreground text-xs tabular-nums">
						{left.toLocaleString()} left
					</p>
				) : null}
			</div>
			<p className="mt-1 flex items-baseline gap-1.5 tabular-nums">
				<span className="font-semibold text-2xl tracking-tight">
					{counter.used.toLocaleString()}
				</span>
				<span className="text-muted-foreground text-sm">
					{unlimited
						? `${unit}, no limit`
						: `/ ${(counter.cap as number).toLocaleString()} ${unit}`}
				</span>
			</p>
			{unlimited ? null : (
				<div
					aria-hidden="true"
					className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted"
				>
					<div
						className={cn(
							"h-full rounded-full",
							tone === "neutral" ? "bg-foreground/70" : "bg-amber-500",
						)}
						style={{ width: `${share}%` }}
					/>
				</div>
			)}
			<p
				className={cn(
					"mt-2 text-xs",
					tone === "neutral" ? "text-muted-foreground" : TONE_TEXT[tone],
				)}
			>
				{note}
			</p>
		</div>
	);
}

function ExcludedFieldsSection({
	settings,
	onSave,
	saving,
	onDirtyChange,
}: {
	settings: AssistantSettings;
	onSave: (patch: AssistantSettingsPatch) => void;
	saving: boolean;
	onDirtyChange: (dirty: boolean) => void;
}) {
	const [fields, setFields] = useState<string[]>(settings.excludedFields);
	const [draft, setDraft] = useState("");
	const dirty =
		fields.join("\n") !== settings.excludedFields.join("\n") ||
		draft.trim() !== "";
	useEffect(() => {
		onDirtyChange(dirty);
	}, [dirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
	const add = () => {
		const value = draft.trim();
		if (value && !fields.includes(value)) setFields([...fields, value]);
		setDraft("");
	};

	return (
		<SettingsSection
			description="Input fields never sent for review. They are removed before anything else happens, including redaction."
			footer={
				<Button
					disabled={
						saving || fields.join("\n") === settings.excludedFields.join("\n")
					}
					onClick={() => onSave({ excludedFields: fields })}
					size="sm"
				>
					Save excluded fields
				</Button>
			}
			title="Excluded fields"
		>
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					add();
				}}
			>
				<Label className="sr-only" htmlFor="excluded-field">
					Field to exclude
				</Label>
				<Input
					autoComplete="off"
					className="flex-1 font-mono max-sm:[&_input]:text-base"
					id="excluded-field"
					name="excluded-field"
					onChange={(e) => setDraft(e.target.value)}
					placeholder="customer.email"
					spellCheck={false}
					value={draft}
				/>
				<Button disabled={!draft.trim()} type="submit" variant="outline">
					<Plus className="size-4" />
					Exclude
				</Button>
			</form>
			{fields.length > 0 ? (
				<ul
					aria-label="Excluded fields"
					className="mt-3 flex flex-wrap gap-1.5"
				>
					{fields.map((field) => (
						<li
							className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2 font-mono text-xs max-sm:mr-2"
							key={field}
						>
							{field}
							<button
								aria-label={`Stop excluding ${field}`}
								className="relative inline-flex size-6 items-center justify-center rounded text-muted-foreground after:absolute after:-inset-2.5 after:content-[''] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-fine:after:hidden"
								onClick={() => setFields(fields.filter((f) => f !== field))}
								type="button"
							>
								<X className="size-3" />
							</button>
						</li>
					))}
				</ul>
			) : (
				<p className="mt-3 text-muted-foreground text-xs">
					Nothing excluded. Sensitive-looking keys (passwords, tokens, API keys)
					are always redacted.
				</p>
			)}
		</SettingsSection>
	);
}

const AUDIT_STEPS = [0, 0.05, 0.1, 0.25, 0.5] as const;

function numberOr(value: string, fallback: number): number {
	const n = Number(value);
	return value.trim() !== "" && Number.isFinite(n) ? n : fallback;
}

function AutoApproveSection({
	settings,
	onSave,
	saving,
	workspaceId,
	onDirtyChange,
}: {
	settings: AssistantSettings;
	onSave: (patch: AssistantSettingsPatch) => void;
	saving: boolean;
	workspaceId?: string;
	onDirtyChange: (dirty: boolean) => void;
}) {
	const cfg = settings.autoApprove;
	const [actions, setActions] = useState<string[]>(cfg.actions);
	const [customAction, setCustomAction] = useState("");
	const [maxAmount, setMaxAmount] = useState(
		cfg.maxAmount === null || cfg.maxAmount === undefined
			? ""
			: String(cfg.maxAmount),
	);
	const [minConfidence, setMinConfidence] = useState(
		Math.max(MIN_CONFIDENCE_FLOOR, cfg.minConfidence),
	);
	const [maxRisk, setMaxRisk] = useState(cfg.maxRisk);
	const [minHistory, setMinHistory] = useState(String(cfg.minHistory));
	const [auditRate, setAuditRate] = useState(settings.auditSampleRate);
	const [confirming, setConfirming] = useState(false);

	const { data: workspaceActions } = useActions(workspaceId);
	const actionNames = useMemo(() => {
		const names = new Set((workspaceActions ?? []).map((a) => a.name));
		for (const name of actions) names.add(name);
		return [...names].sort();
	}, [workspaceActions, actions]);

	const limits: AssistantAutoApprove = {
		enabled: cfg.enabled,
		actions,
		maxAmount: maxAmount.trim() === "" ? null : numberOr(maxAmount, 0),
		minConfidence,
		maxRisk,
		minHistory: Math.max(0, Math.round(numberOr(minHistory, 20))),
	};
	const patch = (enabled: boolean): AssistantSettingsPatch => ({
		autoApprove: { ...limits, enabled },
		auditSampleRate: auditRate,
	});
	const dirty =
		customAction.trim() !== "" ||
		[...actions].sort().join() !== [...cfg.actions].sort().join() ||
		(limits.maxAmount ?? null) !== (cfg.maxAmount ?? null) ||
		Math.abs(
			minConfidence - Math.max(MIN_CONFIDENCE_FLOOR, cfg.minConfidence),
		) > 1e-9 ||
		maxRisk !== cfg.maxRisk ||
		limits.minHistory !== cfg.minHistory ||
		Math.abs(auditRate - settings.auditSampleRate) > 1e-9;
	useEffect(() => {
		onDirtyChange(dirty);
	}, [dirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
	const toggleAction = (name: string) =>
		setActions((current) =>
			current.includes(name)
				? current.filter((a) => a !== name)
				: [...current, name],
		);

	return (
		<SettingsSection
			description="Let Vigil approve routine requests on its own, only when every limit below holds. It never denies, never approves a request a policy says needs more than one approver, and never acts while an environment is halted."
			footer={
				<Button
					disabled={saving}
					onClick={() => onSave(patch(cfg.enabled))}
					size="sm"
					variant="outline"
				>
					Save limits
				</Button>
			}
			stickyFooter
			title="Auto-approve"
		>
			<div className="space-y-6">
				<div className="flex items-center justify-between gap-4 border-b pb-5">
					<div>
						<Label htmlFor="auto-approve-enabled">
							Approve inside these limits
						</Label>
						<p className="text-muted-foreground text-xs">
							{cfg.enabled
								? "On. Saved limits apply now."
								: "Off. Nothing is approved automatically."}
						</p>
					</div>
					<Switch
						checked={cfg.enabled}
						disabled={saving}
						id="auto-approve-enabled"
						onCheckedChange={(checked) => {
							if (checked) setConfirming(true);
							else onSave(patch(false));
						}}
					/>
				</div>

				<fieldset className="space-y-2">
					<legend className="font-medium text-sm">
						Actions it may approve
					</legend>
					<p className="text-muted-foreground text-xs">
						Only these. Pick the routine, reversible ones.
					</p>
					{actionNames.length > 0 ? (
						<div className="flex flex-wrap gap-1.5 pt-1">
							{actionNames.map((name) => {
								const on = actions.includes(name);
								return (
									<button
										aria-pressed={on}
										className={cn(
											"inline-flex h-8 items-center gap-1.5 rounded-full border px-3 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
											on
												? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
												: "border-border/70 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
										)}
										key={name}
										onClick={() => toggleAction(name)}
										type="button"
									>
										{on ? <Check className="size-3.5" /> : null}
										{name}
									</button>
								);
							})}
						</div>
					) : null}
					<form
						className="flex gap-2 pt-1"
						onSubmit={(e) => {
							e.preventDefault();
							const name = customAction.trim();
							if (name && !actions.includes(name))
								setActions([...actions, name]);
							setCustomAction("");
						}}
					>
						<Label className="sr-only" htmlFor="auto-actions">
							Actions
						</Label>
						<Input
							autoComplete="off"
							className="flex-1 max-sm:[&_input]:text-base"
							id="auto-actions"
							name="actions"
							onChange={(e) => setCustomAction(e.target.value)}
							placeholder="Add an action by name"
							spellCheck={false}
							value={customAction}
						/>
						<Button
							disabled={!customAction.trim()}
							type="submit"
							variant="outline"
						>
							<Plus className="size-4" />
							Add
						</Button>
					</form>
				</fieldset>

				<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
					<div className="space-y-6">
						<fieldset className="space-y-2">
							<legend className="font-medium text-sm">
								Highest risk it may approve
							</legend>
							<SegmentedControl
								className="grid grid-cols-5 gap-1 rounded-lg bg-muted/50 p-1"
								label="Highest risk it may approve"
								onChange={setMaxRisk}
								options={RISK_LEVELS.map((level, i) => ({
									value: i,
									label: RISK_LABEL[level],
								}))}
								segmentClassName={(option, on) =>
									cn(
										"rounded-md px-1 py-1.5 text-xs transition-colors",
										on
											? "bg-background font-medium shadow-sm"
											: option.value <= maxRisk
												? "text-foreground/80 hover:bg-background/60"
												: "text-muted-foreground hover:bg-background/60",
									)
								}
								value={maxRisk}
							/>
							{maxRisk >= 2 ? (
								<p className={cn("text-xs", TONE_TEXT.amber)}>
									{RISK_LABEL[RISK_LEVELS[maxRisk]]} lets it approve requests
									with noticeable customer or financial impact.
								</p>
							) : null}
						</fieldset>

						<div className="space-y-3">
							<div className="flex items-baseline justify-between">
								<Label htmlFor="auto-min-confidence">Minimum confidence</Label>
								<span className="font-medium text-sm tabular-nums">
									{Math.round(minConfidence * 100)}%
								</span>
							</div>
							<Slider
								aria-labelledby="auto-min-confidence"
								id="auto-min-confidence"
								max={100}
								min={80}
								onValueChange={(value) =>
									setMinConfidence(
										(Array.isArray(value) ? value[0] : (value as number)) / 100,
									)
								}
								step={1}
								value={Math.round(minConfidence * 100)}
							/>
							<p className="text-muted-foreground text-xs">
								Never below 80%, whatever is set here.
							</p>
						</div>

						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-1.5">
								<Label htmlFor="auto-max-amount">Maximum amount</Label>
								<Input
									className="tabular-nums max-sm:[&_input]:text-base"
									id="auto-max-amount"
									inputMode="decimal"
									name="auto-max-amount"
									onChange={(e) => setMaxAmount(e.target.value)}
									placeholder="No limit"
									value={maxAmount}
								/>
								<p className="text-muted-foreground text-xs">
									With a limit, requests need an amount at or below it.
								</p>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="auto-min-history">Minimum history</Label>
								<Input
									className="tabular-nums max-sm:[&_input]:text-base"
									id="auto-min-history"
									inputMode="numeric"
									name="auto-min-history"
									onChange={(e) => setMinHistory(e.target.value)}
									value={minHistory}
								/>
								<p className="text-muted-foreground text-xs">
									Approvals of the same action and agent in 30 days, by a user
									or by a key that may decide. Policy and Vigil approvals do not
									count.
								</p>
							</div>
						</div>

						<fieldset className="space-y-2">
							<legend className="font-medium text-sm">Send for audit</legend>
							<SegmentedControl
								className="flex flex-wrap gap-1"
								label="Share of Vigil approvals sent for audit"
								onChange={setAuditRate}
								options={AUDIT_STEPS.map((rate) => ({
									value: rate,
									label: rate === 0 ? "None" : `${Math.round(rate * 100)}%`,
								}))}
								segmentClassName={(_option, on) =>
									cn(
										"h-8 rounded-md border px-3 text-xs tabular-nums transition-colors max-sm:h-11",
										on
											? "border-foreground/20 bg-muted font-medium"
											: "border-border/70 text-muted-foreground hover:bg-muted/60",
									)
								}
								value={
									AUDIT_STEPS.find(
										(rate) => Math.abs(rate - auditRate) < 0.001,
									) ?? auditRate
								}
							/>
							<p className="text-muted-foreground text-xs">
								Picked Vigil approvals wait in the inbox for a workspace admin
								to agree or disagree.
							</p>
						</fieldset>
					</div>

					<ReplayPanel limits={limits} workspaceId={workspaceId} />
				</div>
			</div>

			<AlertDialog onOpenChange={setConfirming} open={confirming}>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>Let Vigil approve?</AlertDialogTitle>
						<AlertDialogDescription>
							{actions.length === 0
								? "Choose at least one action first."
								: `It will approve ${actions.join(", ")} requests that meet every limit, without waiting for an approver. Model output can be wrong. Keep the limits tight and review the audit queue.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<AlertDialogClose
							disabled={actions.length === 0}
							onClick={() => onSave(patch(true))}
							render={<Button loading={saving} />}
						>
							Turn on auto-approve
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</SettingsSection>
	);
}

function ReplayPanel({
	limits,
	workspaceId,
}: {
	limits: AssistantAutoApprove;
	workspaceId?: string;
}) {
	const recent = useApprovals(workspaceId, { limit: 100 });
	const result = useMemo(
		() => replayLimits(recent.data?.data ?? [], limits),
		[recent.data, limits],
	);

	return (
		<aside
			aria-label="What these limits would have done"
			aria-live="polite"
			className="h-fit space-y-4 max-lg:border-t max-lg:pt-6 lg:sticky lg:top-20 lg:border-l lg:pl-6"
		>
			<div>
				<p className="font-medium text-sm">On your recent requests</p>
				<p className="text-muted-foreground text-xs">
					These limits, replayed on the last{" "}
					{result.considered.toLocaleString()} reviewed requests. Updates as you
					change them.
				</p>
			</div>
			{recent.isLoading ? (
				<Skeleton className="h-24 w-full" />
			) : result.considered === 0 ? (
				<p className="text-muted-foreground text-sm">
					No reviewed requests yet. Once Vigil has reviewed some, you will see
					what these limits would have done.
				</p>
			) : (
				<>
					<dl className="grid grid-cols-2 gap-4">
						<div>
							<dt className="text-muted-foreground text-xs">Would approve</dt>
							<dd className="font-semibold text-xl tabular-nums">
								{result.wouldApprove.length}
							</dd>
						</div>
						<div>
							<dt className="text-muted-foreground text-xs">
								Left for approvers
							</dt>
							<dd className="font-semibold text-xl tabular-nums">
								{result.leftForPeople}
							</dd>
						</div>
					</dl>
					{result.wouldApproveDenied.length > 0 ? (
						<div className={cn("rounded-md p-3 text-xs", TONE_SURFACE.rose)}>
							<p className={cn("font-medium", TONE_TEXT.rose)}>
								Would have approved {result.wouldApproveDenied.length} request
								{result.wouldApproveDenied.length === 1 ? "" : "s"} an approver
								denied
							</p>
							<ul className="mt-1 space-y-0.5 text-muted-foreground">
								{result.wouldApproveDenied.slice(0, 3).map((a) => (
									<li className="truncate" key={a.id}>
										{a.title}
									</li>
								))}
							</ul>
						</div>
					) : result.wouldApprove.length > 0 ? (
						<p className="flex items-center gap-1.5 text-xs">
							<Pill tone="emerald">None denied</Pill>
							<span className="text-muted-foreground">
								Nothing an approver denied would have been approved.
							</span>
						</p>
					) : null}
					{result.topMiss ? (
						<p className="text-muted-foreground text-xs">
							Most often left for approvers because of:{" "}
							<span className="text-foreground">{result.topMiss.reason}</span> (
							{result.topMiss.count}).
						</p>
					) : null}
				</>
			)}
		</aside>
	);
}
