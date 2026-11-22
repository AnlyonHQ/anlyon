"use client";

import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import {
	DetailList,
	DetailRow,
	DetailSection,
	IdValue,
} from "@/components/actions/detail-sheet";
import {
	TONE_PILL,
	TONE_SURFACE,
	type Tone,
} from "@/components/approvals/tone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useActorNames } from "@/hooks/api/use-actor-names";
import {
	useAddEffectNote,
	useReconcileEffect,
	useReplayEffect,
	useResolveEffect,
} from "@/hooks/api/use-effects";
import { useCan } from "@/hooks/api/use-permissions";
import type {
	EffectDetail,
	EffectGrade,
	EffectOutcome,
	EffectVerification,
	ImpactQuantity,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatQuantity, PreviewBlocks } from "./preview-blocks";

export const OUTCOME_LABEL: Record<EffectOutcome, string> = {
	not_dispatched: "Not dispatched",
	pending: "Pending",
	succeeded: "Succeeded",
	failed: "Failed",
	unknown: "Unknown",
};

export const OUTCOME_TONE: Record<EffectOutcome, Tone> = {
	not_dispatched: "neutral",
	pending: "sky",
	succeeded: "emerald",
	failed: "rose",
	unknown: "amber",
};

export const VERIFICATION_LABEL: Record<EffectVerification, string> = {
	provider: "Verified by provider",
	manual: "Resolved manually",
	unverified: "Not yet verified",
	not_dispatched: "Never sent",
};

export function verificationLabel(effect: {
	verification: EffectVerification;
	grade: EffectGrade;
}): string {
	if (effect.verification === "provider" && effect.grade !== "confirmed") {
		return "Reported by provider";
	}
	return VERIFICATION_LABEL[effect.verification];
}

export const GRADES: EffectGrade[] = [
	"confirmed",
	"acknowledged",
	"unknown",
	"failed",
	"refused",
	"denied",
	"pending",
];

export const GRADE_LABEL: Record<EffectGrade, string> = {
	confirmed: "Confirmed",
	acknowledged: "Acknowledged",
	unknown: "Unknown",
	failed: "Failed",
	refused: "Refused",
	denied: "Denied",
	pending: "Pending",
};

export const GRADE_MEANING: Record<EffectGrade, string> = {
	confirmed: "A read-back matched the request.",
	acknowledged: "The provider accepted the request. Nothing read it back.",
	unknown:
		"No usable response. Anlyon does not send it again. It stays unknown until a read-back or an operator settles it.",
	failed: "The provider rejected the request, or it never left Anlyon.",
	refused: "Anlyon refused it at dispatch.",
	denied: "The approval was denied.",
	pending: "No receipt yet.",
};

export const GRADE_TONE: Record<EffectGrade, Tone> = {
	confirmed: "emerald",
	acknowledged: "sky",
	unknown: "amber",
	failed: "rose",
	refused: "rose",
	denied: "rose",
	pending: "neutral",
};

export function GradePill({ grade }: { grade: EffectGrade }) {
	return (
		<span
			className={cn(
				"inline-flex rounded px-1.5 py-0.5 font-medium text-xs",
				TONE_PILL[GRADE_TONE[grade] ?? "neutral"],
			)}
			title={GRADE_MEANING[grade]}
		>
			{GRADE_LABEL[grade] ?? grade}
		</span>
	);
}

export function OutcomePill({ outcome }: { outcome: EffectOutcome }) {
	return (
		<span
			className={cn(
				"inline-flex rounded px-1.5 py-0.5 font-medium text-xs",
				TONE_PILL[OUTCOME_TONE[outcome]],
			)}
		>
			{OUTCOME_LABEL[outcome]}
		</span>
	);
}

const SOURCE_LABEL: Record<EffectDetail["evidence"][number]["source"], string> =
	{
		preview: "Review",
		provider_response: "Provider response",
		provider_lookup: "Provider lookup",
		system: "Anlyon",
		operator_note: "Operator note",
		manual_resolution: "Manual resolution",
	};

function When({ value }: { value: string | null }) {
	return value ? (
		<time dateTime={value}>{new Date(value).toLocaleString()}</time>
	) : (
		"—"
	);
}

function Recovery({
	effect,
	workspaceId,
	environmentId,
}: {
	effect: EffectDetail;
	workspaceId?: string;
	environmentId?: string;
}) {
	const id = useId();
	const reconcile = useReconcileEffect(workspaceId, environmentId, effect.id);
	const replay = useReplayEffect(workspaceId, environmentId, effect.id);
	const resolve = useResolveEffect(workspaceId, environmentId, effect.id);
	const can = useCan(workspaceId);
	const canInvoke = can("actions.invoke", environmentId);
	const canSettle = can("actions.resolve", environmentId);
	const [outcome, setOutcome] = useState<"" | "succeeded" | "failed">("");
	const [partial, setPartial] = useState<"none" | "possible" | "confirmed">(
		"none",
	);
	const [actual, setActual] = useState("");
	const [reason, setReason] = useState("");
	const [reference, setReference] = useState("");
	const [error, setError] = useState<string | null>(null);

	const open = effect.outcome === "pending" || effect.outcome === "unknown";
	const possiblePartial =
		effect.outcome === "failed" && effect.partialEffect === "possible";
	const caps = effect.capabilities as {
		sameKeyReplay?: { supported?: boolean; description?: string };
	};
	const canReplay =
		effect.outcome === "unknown" && caps.sameKeyReplay?.supported === true;
	const primary: ImpactQuantity | undefined = effect.impact[0];

	if (!open && !possiblePartial) return null;
	if (!canInvoke && !canSettle) return null;

	const submitResolution = () => {
		setError(null);
		const chosen = possiblePartial ? "failed" : outcome;
		if (!chosen) return setError("Choose what the provider shows.");
		if (reason.trim().length < 10) {
			return setError("Explain what you checked (at least 10 characters).");
		}
		const amount = Number(actual);
		if (
			partial === "confirmed" &&
			(!primary || !Number.isInteger(amount) || amount < 0)
		) {
			return setError(
				"A confirmed partial needs the whole-unit quantity that did happen.",
			);
		}
		resolve.mutate(
			{
				outcome: chosen,
				...(chosen === "failed" ? { partialEffect: partial } : {}),
				...(partial === "confirmed" && primary
					? { actualImpact: [{ ...primary, amount }] }
					: {}),
				reason: reason.trim(),
				...(reference.trim() ? { externalReference: reference.trim() } : {}),
			},
			{ onError: (e: Error) => setError(e.message) },
		);
	};

	return (
		<section
			aria-labelledby={`${id}-title`}
			className={cn("space-y-4 rounded-lg border p-4", TONE_SURFACE.amber)}
		>
			<h3 className="font-medium text-sm" id={`${id}-title`}>
				Recover this action
			</h3>
			<p className="text-muted-foreground text-sm">
				Do not retry blindly: the provider may already have applied it. Ask the
				provider first. Resolve manually only with evidence.
			</p>
			<div className="flex flex-wrap gap-2">
				{open && canInvoke ? (
					<Button
						disabled={reconcile.isPending}
						onClick={() =>
							reconcile.mutate(undefined, {
								onError: (e: Error) => setError(e.message),
							})
						}
						size="sm"
						variant="outline"
					>
						{reconcile.isPending ? (
							<Loader2
								aria-hidden="true"
								className="animate-spin motion-reduce:animate-none"
								data-icon="inline-start"
							/>
						) : null}
						Ask the provider now (read-only)
					</Button>
				) : null}
				{canReplay && canSettle ? (
					<Button
						disabled={replay.isPending}
						onClick={() =>
							replay.mutate(undefined, {
								onError: (e: Error) => setError(e.message),
							})
						}
						size="sm"
						title={caps.sameKeyReplay?.description}
						variant="outline"
					>
						Replay under the same identity (a write)
					</Button>
				) : null}
			</div>

			{canSettle && (
				<div className="space-y-3 border-border/60 border-t pt-3">
					<h4 className="font-medium text-sm">Record a manual resolution</h4>
					{!possiblePartial ? (
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-outcome`}>
								What does the provider show?
							</Label>
							<NativeSelect
								className="w-full"
								id={`${id}-outcome`}
								onChange={(e) => setOutcome(e.target.value as typeof outcome)}
								value={outcome}
							>
								<NativeSelectOption value="">Choose…</NativeSelectOption>
								<NativeSelectOption value="failed">
									It did not happen
								</NativeSelectOption>
								<NativeSelectOption value="succeeded">
									It happened
								</NativeSelectOption>
							</NativeSelect>
						</div>
					) : null}
					{possiblePartial || outcome === "failed" ? (
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-partial`}>Did any of it happen?</Label>
							<NativeSelect
								className="w-full"
								id={`${id}-partial`}
								onChange={(e) => setPartial(e.target.value as typeof partial)}
								value={partial}
							>
								<NativeSelectOption value="none">
									No: release the allowance
								</NativeSelectOption>
								<NativeSelectOption value="possible">
									Possibly: keep the allowance held
								</NativeSelectOption>
								<NativeSelectOption value="confirmed">
									Yes, partly: settle what happened
								</NativeSelectOption>
							</NativeSelect>
						</div>
					) : null}
					{partial === "confirmed" && primary ? (
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-actual`}>
								Quantity that happened (
								{primary.dimension === "money"
									? `${(primary.currency ?? "").toUpperCase()} minor units`
									: primary.dimension === "resource_mutations"
										? "changes"
										: primary.dimension}
								)
							</Label>
							<Input
								id={`${id}-actual`}
								inputMode="numeric"
								onChange={(e) => setActual(e.target.value)}
								value={actual}
							/>
						</div>
					) : null}
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-reason`}>What you checked and why</Label>
						<Textarea
							id={`${id}-reason`}
							maxLength={2000}
							onChange={(e) => setReason(e.target.value)}
							value={reason}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-reference`}>
							Provider reference (optional)
						</Label>
						<Input
							autoComplete="off"
							id={`${id}-reference`}
							maxLength={200}
							onChange={(e) => setReference(e.target.value)}
							value={reference}
						/>
					</div>
					{error ? (
						<p className="text-destructive text-sm" role="alert">
							{error}
						</p>
					) : null}
					<Button
						disabled={resolve.isPending}
						onClick={submitResolution}
						size="sm"
					>
						Record resolution
					</Button>
					<p className="text-muted-foreground text-xs">
						Recorded as a manual resolution with your identity. A manual “it
						happened” grades acknowledged, never confirmed.
					</p>
				</div>
			)}
		</section>
	);
}

function formatAmount(
	dimension: string,
	currency: string | null,
	amount: number,
): string {
	if (dimension === "money") {
		return `${(amount / 100).toFixed(2)} ${currency?.toUpperCase() ?? ""}`.trim();
	}
	return dimension === "resource_mutations"
		? `${amount} change${amount === 1 ? "" : "s"}`
		: `${amount} ${dimension}`;
}

const DOT: Record<Tone, string> = {
	neutral: "bg-muted-foreground/50",
	amber: "bg-amber-500",
	rose: "bg-rose-500",
	emerald: "bg-emerald-500",
	sky: "bg-sky-500",
};

function toneFor(outcome: string | null): Tone {
	return outcome && outcome in OUTCOME_TONE
		? OUTCOME_TONE[outcome as EffectOutcome]
		: "neutral";
}

function NoteForm({
	effect,
	workspaceId,
	environmentId,
}: {
	effect: EffectDetail;
	workspaceId?: string;
	environmentId?: string;
}) {
	const id = useId();
	const note = useAddEffectNote(workspaceId, environmentId, effect.id);
	const [text, setText] = useState("");
	return (
		<form
			aria-labelledby={`${id}-label`}
			className="space-y-2 rounded-lg border border-border/70 p-3"
			onSubmit={(e) => {
				e.preventDefault();
				if (text.trim().length >= 3)
					note.mutate(text.trim(), { onSuccess: () => setText("") });
			}}
		>
			<Label htmlFor={`${id}-text`} id={`${id}-label`}>
				Add an investigation note
			</Label>
			<Textarea
				className="min-h-16"
				id={`${id}-text`}
				maxLength={2000}
				onChange={(e) => setText(e.target.value)}
				placeholder="What you checked, and what you found"
				value={text}
			/>
			<div className="flex items-center justify-between gap-3">
				<p className="text-muted-foreground text-xs">
					Appended to the evidence with your name. Notes can't be edited.
				</p>
				<Button
					disabled={text.trim().length < 3}
					loading={note.isPending}
					size="xs"
					type="submit"
				>
					Add note
				</Button>
			</div>
		</form>
	);
}

export function EffectDetailView({
	effect,
	workspaceId,
	environmentId,
}: {
	effect: EffectDetail;
	workspaceId?: string;
	environmentId?: string;
}) {
	const [headline, ...otherImpact] = effect.impact.map(formatQuantity);
	const closed =
		effect.outcome !== "pending" &&
		effect.outcome !== "unknown" &&
		!(effect.outcome === "failed" && effect.partialEffect === "possible");
	const nameOf = useActorNames(workspaceId);
	const canAnnotate = useCan(workspaceId)("actions.resolve", environmentId);

	return (
		<div className="space-y-6">
			<div className="space-y-3 rounded-lg border bg-muted/30 p-4">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="inline-flex items-center gap-2">
						<span className="text-muted-foreground text-xs">Receipt</span>
						<GradePill grade={effect.grade} />
						{effect.partialEffect !== "none" ? (
							<span className="text-muted-foreground text-xs">
								partial: {effect.partialEffect}
							</span>
						) : null}
					</span>
					<span className="text-muted-foreground text-xs">
						{verificationLabel(effect)}
					</span>
				</div>
				<p className="text-sm" data-testid="grade-meaning">
					{GRADE_MEANING[effect.grade]}
				</p>
				<div>
					<p className="font-semibold text-2xl tabular-nums tracking-tight">
						{headline ?? "No impact declared"}
					</p>
					{otherImpact.length > 0 ? (
						<p className="text-muted-foreground text-sm">
							and {otherImpact.join(", ")}
						</p>
					) : null}
				</div>
				<p className="text-muted-foreground text-xs">
					Outcome{" "}
					<span className="text-foreground">
						{OUTCOME_LABEL[effect.outcome]}
					</span>
					{" · "}stage <span className="text-foreground">{effect.stage}</span>
					{effect.firstDispatchedAt ? (
						<>
							{" · "}dispatched <When value={effect.firstDispatchedAt} />
						</>
					) : null}
				</p>
				{effect.rejectionReason ? (
					<p className="border-t pt-3 text-sm">
						<span className="text-muted-foreground">
							Not dispatched because{" "}
						</span>
						<span className="font-mono text-xs">{effect.rejectionReason}</span>
					</p>
				) : null}
				{effect.stage === "reconciling" ? (
					<p className="border-t pt-3 text-sm">
						{effect.reconciliation.attempts} lookup
						{effect.reconciliation.attempts === 1 ? "" : "s"} so far.{" "}
						{effect.reconciliation.exhausted
							? "Automatic reconciliation has stopped. An operator must act."
							: effect.reconciliation.nextAt
								? `Next lookup ${new Date(effect.reconciliation.nextAt).toLocaleString()}.`
								: ""}
					</p>
				) : null}
			</div>

			<Recovery
				effect={effect}
				environmentId={environmentId}
				workspaceId={workspaceId}
			/>

			<DetailSection title="Details">
				<DetailList>
					<DetailRow label="Provider reference">
						{effect.providerReference ? (
							<IdValue
								label="provider reference"
								value={effect.providerReference}
							/>
						) : (
							<span className="text-muted-foreground">None yet</span>
						)}
					</DetailRow>
					<DetailRow label="Target">
						<IdValue
							label="target"
							value={String(effect.target.resourceKey ?? "")}
						/>
					</DetailRow>
					<DetailRow label="Operation key">
						<IdValue label="operation key" value={effect.operationKey} />
					</DetailRow>
					<DetailRow label="Action version">
						<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
							<IdValue label="action version" value={effect.action.versionId} />
							<span className="text-muted-foreground text-xs">
								{effect.adapter.type} v{effect.adapter.version}
							</span>
						</span>
					</DetailRow>
					<DetailRow label="First dispatched">
						<When value={effect.firstDispatchedAt} />
					</DetailRow>
					<DetailRow label="Outcome established">
						<When value={effect.outcomeAt} />
					</DetailRow>
				</DetailList>
			</DetailSection>

			<DetailSection
				description="Append-only. Every observation, oldest first."
				title="Evidence"
			>
				<ol className="relative space-y-5 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-border">
					{effect.evidence.map((item) => (
						<li className="relative pl-6" key={item.id}>
							<span
								aria-hidden="true"
								className={cn(
									"absolute top-1.5 left-0 size-[11px] rounded-full ring-4 ring-background",
									DOT[toneFor(item.impliedOutcome)],
								)}
							/>
							<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
								<span className="flex items-center gap-2">
									<span className="font-medium text-sm">
										{SOURCE_LABEL[item.source]}
									</span>
									{item.impliedOutcome ? (
										<span
											className={cn(
												"rounded px-1.5 py-0.5 font-medium text-[11px]",
												TONE_PILL[toneFor(item.impliedOutcome)],
											)}
										>
											implies {item.impliedOutcome}
										</span>
									) : null}
								</span>
								<span className="text-muted-foreground text-xs tabular-nums">
									<When value={item.observedAt} />
								</span>
							</div>
							{item.actor.id ? (
								<p className="text-muted-foreground text-xs">
									by{" "}
									<span title={nameOf(item.actor).title}>
										{nameOf(item.actor).text}
									</span>
								</p>
							) : null}
							<p className="mt-1.5 text-muted-foreground text-sm leading-relaxed">
								{item.summary}
							</p>
							{Object.keys(item.providerIds).length > 0 ? (
								<dl className="mt-2.5 flex flex-wrap gap-x-4 gap-y-2">
									{Object.entries(item.providerIds).map(([key, value]) => (
										<div className="flex items-center gap-1.5" key={key}>
											<dt className="text-muted-foreground text-xs">{key}</dt>
											<dd>
												<IdValue label={key} value={value} />
											</dd>
										</div>
									))}
								</dl>
							) : null}
						</li>
					))}
				</ol>
				{closed && canAnnotate ? (
					<NoteForm
						effect={effect}
						environmentId={environmentId}
						workspaceId={workspaceId}
					/>
				) : null}
			</DetailSection>

			{effect.reservations.length > 0 ? (
				<DetailSection
					description="What this action drew from your impact limits."
					title="Impact reservations"
				>
					<ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
						{effect.reservations.map((r) => {
							const amount = (value: number) =>
								formatAmount(r.dimension, r.currency, value);
							return (
								<li
									className="flex items-start justify-between gap-4 px-3.5 py-3"
									key={r.limitId}
								>
									<div className="min-w-0">
										<p className="truncate font-medium text-sm">{r.name}</p>
										<p className="text-muted-foreground text-xs">
											{r.period}
											{r.exposure ? ` · held as ${r.exposure}` : ""}
										</p>
									</div>
									<div className="shrink-0 text-right">
										<p className="font-medium text-sm tabular-nums">
											{amount(r.amount)}{" "}
											<span className="font-normal text-muted-foreground">
												{r.state}
											</span>
										</p>
										{r.state !== "reserved" ? (
											<p className="text-muted-foreground text-xs tabular-nums">
												settled {amount(r.settled)} · released{" "}
												{amount(r.released)}
											</p>
										) : null}
									</div>
								</li>
							);
						})}
					</ul>
				</DetailSection>
			) : null}

			<DetailSection title="Attempts">
				{effect.attempts.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No attempts: nothing was sent.
					</p>
				) : (
					<ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
						{effect.attempts.map((a) => (
							<li className="px-3.5 py-3" key={a.number}>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<span className="flex items-center gap-2 text-sm">
										<span className="font-mono text-muted-foreground text-xs">
											#{a.number}
										</span>
										<span className="font-medium capitalize">{a.kind}</span>
										<span className="text-muted-foreground">{a.status}</span>
										{a.observedOutcome ? (
											<span
												className={cn(
													"rounded px-1.5 py-0.5 font-medium text-[11px]",
													TONE_PILL[toneFor(a.observedOutcome)],
												)}
											>
												{a.observedOutcome}
											</span>
										) : null}
									</span>
									<span className="text-muted-foreground text-xs tabular-nums">
										<When value={a.startedAt} />
									</span>
								</div>
								{a.error ? (
									<p className="mt-1.5 break-words font-mono text-destructive text-xs">
										{a.error}
									</p>
								) : null}
							</li>
						))}
					</ul>
				)}
			</DetailSection>

			{effect.preview ? (
				<DetailSection
					description="The request bound to this action when it was reviewed."
					title="What was reviewed"
				>
					<PreviewBlocks preview={effect.preview} />
				</DetailSection>
			) : null}
		</div>
	);
}
