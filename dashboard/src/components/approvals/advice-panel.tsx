"use client";

import {
	ChevronDown,
	CircleAlert,
	CircleCheck,
	CircleX,
	ScanSearch,
	ThumbsDown,
	ThumbsUp,
} from "lucide-react";
import { useId, useState } from "react";
import { FeatureStageBadge } from "@/components/feature-stage-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuditAdvice } from "@/hooks/api/use-assistant";
import { useCan } from "@/hooks/api/use-permissions";
import { summarizePayload } from "@/lib/approvals";
import {
	adviceReasons,
	adviceSignals,
	autoApproveNote,
	type Signal,
	type SignalState,
} from "@/lib/assistant";
import type { Approval, AssistantAdvice } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Pill, TONE_SURFACE, TONE_TEXT, type Tone } from "./tone";

type Recommendation = NonNullable<AssistantAdvice["recommendation"]>;

const VERDICT: Record<Recommendation, { tone: Tone; title: string }> = {
	approve: { tone: "emerald", title: "Looks routine" },
	review: { tone: "amber", title: "Needs your judgement" },
	deny: { tone: "rose", title: "Looks wrong" },
};

const SUGGESTS: Record<Recommendation, string> = {
	approve: "Suggests approving",
	review: "Suggests a closer look",
	deny: "Suggests denying",
};

const STATE_TONE: Record<SignalState, Tone> = {
	pass: "emerald",
	warn: "amber",
	fail: "rose",
};

const STATE_ICON = {
	pass: CircleCheck,
	warn: CircleAlert,
	fail: CircleX,
} as const;

const STATE_WORD: Record<SignalState, string> = {
	pass: "OK",
	warn: "Check",
	fail: "Concern",
};

const UNAVAILABLE: Record<string, string> = {
	quota_exceeded: "This workspace has used its Vigil reviews for the month.",
	platform_limit: "Suggestions are paused for now.",
	assistant_disabled: "Vigil was turned off.",
	already_decided: "It was decided before the review finished.",
};

export function AdviceBadge({ advice }: { advice?: AssistantAdvice }) {
	if (advice?.status !== "ready" || !advice.recommendation) return null;
	const verdict = VERDICT[advice.recommendation];
	return (
		<Pill tone={verdict.tone} title="Vigil suggestion, not a decision">
			<span className="sr-only">Vigil: </span>
			{verdict.title}
		</Pill>
	);
}

export function AdvicePanel({
	approval,
	workspaceId,
}: {
	approval: Approval;
	workspaceId?: string;
}) {
	if (!approval.advice) return null;
	return (
		<AdviceContent
			advice={approval.advice}
			approval={approval}
			workspaceId={workspaceId}
		/>
	);
}

function AdviceContent({
	advice,
	approval,
	workspaceId,
}: {
	advice: AssistantAdvice;
	approval: Approval;
	workspaceId?: string;
}) {
	const headingId = useId();
	const ready = advice.status === "ready" && advice.recommendation !== null;

	return (
		<section
			aria-labelledby={headingId}
			aria-live="polite"
			className="space-y-3"
		>
			<header className="flex items-center gap-2">
				<ScanSearch
					aria-hidden="true"
					className="size-4 text-muted-foreground"
				/>
				<h3 className="font-medium text-sm" id={headingId}>
					Vigil review
				</h3>
				<FeatureStageBadge feature="ai-assistant" />
				<span className="ml-auto hidden text-muted-foreground text-xs sm:inline">
					A second reader. You decide.
				</span>
			</header>

			{advice.status === "pending" ? (
				<div className="space-y-3" data-testid="advice-pending">
					<span className="sr-only">Reviewing…</span>
					<Skeleton className="h-5 w-56" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : !ready ? (
				<p className="text-muted-foreground text-sm">
					Suggestion unavailable.{" "}
					{(advice.statusReason && UNAVAILABLE[advice.statusReason]) ??
						"Review it as usual."}
				</p>
			) : (
				<ReadyAdvice advice={advice} approval={approval} />
			)}

			{ready && approval.status !== "pending" ? (
				<Feedback
					advice={advice}
					approval={approval}
					workspaceId={workspaceId}
				/>
			) : null}
		</section>
	);
}

function ReadyAdvice({
	advice,
	approval,
}: {
	advice: AssistantAdvice;
	approval: Approval;
}) {
	const recommendation = advice.recommendation as Recommendation;
	const verdict = VERDICT[recommendation];
	const { amount } = summarizePayload(approval);
	const signals = adviceSignals(advice, amount);
	const leftForPerson = autoApproveNote(advice);
	const extraReasons = adviceReasons(advice).filter(
		(r) => !r.startsWith("Suggests ") && !r.startsWith("Risk: "),
	);

	return (
		<div className="space-y-3">
			<div
				className={cn(
					"flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg px-3 py-2.5",
					TONE_SURFACE[verdict.tone],
				)}
			>
				<span className={cn("font-semibold text-sm", TONE_TEXT[verdict.tone])}>
					{verdict.title}
				</span>
				<span className="text-muted-foreground text-sm">
					{SUGGESTS[recommendation]}
					{advice.confidence !== null
						? `, ${Math.round(advice.confidence * 100)}% sure`
						: ""}
				</span>
			</div>

			{signals.length > 0 ? (
				<ul className="divide-y divide-border/60 overflow-hidden rounded-lg border">
					{signals.map((signal) => (
						<SignalRow
							advice={advice}
							amount={amount}
							key={signal.id}
							signal={signal}
						/>
					))}
				</ul>
			) : null}

			{extraReasons.length > 0 ? (
				<ul className="space-y-1 text-muted-foreground text-xs">
					{extraReasons.map((reason) => (
						<li key={reason}>{reason}</li>
					))}
				</ul>
			) : null}

			{leftForPerson && approval.status === "pending" ? (
				<p className="text-muted-foreground text-xs">
					<span className="font-medium text-foreground">
						Why this is with you:
					</span>{" "}
					{leftForPerson}.
				</p>
			) : null}

			<p className="font-mono text-[11px] text-muted-foreground/70">
				{advice.model}
			</p>
		</div>
	);
}

function SignalRow({
	signal,
	advice,
	amount,
}: {
	signal: Signal;
	advice: AssistantAdvice;
	amount: number | undefined;
}) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	const Icon = STATE_ICON[signal.state];
	const tone = STATE_TONE[signal.state];

	return (
		<li>
			<button
				aria-controls={panelId}
				aria-expanded={open}
				className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
				onClick={() => setOpen((v) => !v)}
				type="button"
			>
				<Icon
					aria-hidden="true"
					className={cn("size-4 shrink-0", TONE_TEXT[tone])}
				/>
				<span className="sr-only">{STATE_WORD[signal.state]}:</span>
				<span className="min-w-0 flex-1">
					<span className="block font-medium text-sm">{signal.label}</span>
					<span className="block truncate text-muted-foreground text-xs">
						{signal.detail}
					</span>
				</span>
				<span className="shrink-0 font-medium text-sm tabular-nums">
					{signal.value}
				</span>
				<ChevronDown
					aria-hidden="true"
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
						open && "rotate-180",
					)}
				/>
			</button>
			{open ? (
				<div className="space-y-3 px-3 pb-3 pl-10" id={panelId}>
					<p className="text-muted-foreground text-xs leading-relaxed">
						{signal.explain}
					</p>
					{signal.id === "risk" && advice.risk !== null ? (
						<RiskScale risk={advice.risk} />
					) : null}
					{signal.id === "amount" &&
					amount !== undefined &&
					advice.history?.maxAmount != null ? (
						<AmountInContext
							amount={amount}
							max={advice.history.maxAmount}
							median={advice.history.medianAmount}
						/>
					) : null}
				</div>
			) : null}
		</li>
	);
}

const RISK_STEPS = ["Routine", "Low", "Moderate", "High", "Critical"] as const;

function RiskScale({ risk }: { risk: number }) {
	const at = Math.min(4, Math.max(0, Math.round(risk)));
	return (
		<ol aria-label="Risk scale" className="grid grid-cols-5 gap-1">
			{RISK_STEPS.map((label, i) => (
				<li
					aria-current={i === at ? "step" : undefined}
					className={cn(
						"rounded-md px-1.5 py-1 text-center text-[11px]",
						i === at
							? cn(
									"font-medium",
									i <= 1
										? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
										: i === 2
											? "bg-amber-500/10 text-amber-800 dark:text-amber-200"
											: "bg-rose-500/10 text-rose-700 dark:text-rose-200",
								)
							: "text-muted-foreground",
					)}
					key={label}
				>
					{label}
				</li>
			))}
		</ol>
	);
}

function AmountInContext({
	amount,
	median,
	max,
}: {
	amount: number;
	median: number | null;
	max: number;
}) {
	const top = Math.max(max, amount) * 1.08 || 1;
	const at = (n: number) => `${Math.min(100, (n / top) * 100)}%`;
	const beyond = amount > max;
	return (
		<figure className="space-y-1.5">
			<div
				className="relative h-8"
				role="img"
				aria-label={`This amount is ${amount.toLocaleString()}. Approvers approved up to ${max.toLocaleString()}${median !== null ? `, median ${median.toLocaleString()}` : ""}.`}
			>
				<div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
				<div
					className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-emerald-500/25"
					style={{ left: 0, width: at(max) }}
				/>
				{median !== null ? (
					<div
						className="absolute top-1/2 h-3.5 w-px -translate-y-1/2 bg-muted-foreground/60"
						style={{ left: at(median) }}
					/>
				) : null}
				<div
					className={cn(
						"-translate-x-1/2 -translate-y-1/2 absolute top-1/2 size-3.5 rounded-full border-2 border-background shadow-sm",
						beyond ? "bg-amber-500" : "bg-foreground",
					)}
					style={{ left: at(amount) }}
				/>
			</div>
			<figcaption className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
				<span>0</span>
				{median !== null ? <span>median {median.toLocaleString()}</span> : null}
				<span>largest approved {max.toLocaleString()}</span>
			</figcaption>
		</figure>
	);
}

function Feedback({
	advice,
	approval,
	workspaceId,
}: {
	advice: AssistantAdvice;
	approval: Approval;
	workspaceId?: string;
}) {
	const audit = useAuditAdvice(workspaceId);
	const canAudit = useCan(workspaceId)("assistant.manage");
	if (!advice.auditVerdict && !advice.auditRequested) return null;
	return (
		<div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-3 py-2">
			<span className="text-muted-foreground text-sm">
				{advice.auditVerdict
					? `Audited: ${advice.auditVerdict === "agree" ? "agreed" : "disagreed"} with Vigil here.`
					: canAudit
						? "Picked for audit: would you have approved this?"
						: "Picked for audit. A workspace admin can record a verdict."}
			</span>
			{advice.auditVerdict || !canAudit ? null : (
				<span className="ml-auto flex gap-2">
					<Button
						disabled={!workspaceId || audit.isPending}
						onClick={() =>
							audit.mutate({ approvalId: approval.id, verdict: "agree" })
						}
						size="sm"
						variant="outline"
					>
						<ThumbsUp aria-hidden="true" className="size-4" />
						Agree
					</Button>
					<Button
						disabled={!workspaceId || audit.isPending}
						onClick={() =>
							audit.mutate({ approvalId: approval.id, verdict: "disagree" })
						}
						size="sm"
						variant="outline"
					>
						<ThumbsDown aria-hidden="true" className="size-4" />
						Disagree
					</Button>
				</span>
			)}
		</div>
	);
}
