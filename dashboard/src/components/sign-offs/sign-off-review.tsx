import { ArrowRight, Check, ChevronRight, X } from "lucide-react";
import { useId, useState } from "react";
import { ListFrame, PageSection } from "@/components/layout/page";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { RelativeTime } from "@/components/ui/relative-time";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api-client";
import {
	diffLineKind,
	formatChangeValue,
	isDecidable,
	loosens,
	SIGN_OFF_STATUS_LABEL,
	type SignOffChange,
	type SignOffRequest,
	type SignOffStatus,
} from "@/lib/sign-offs";
import { cn } from "@/lib/utils";

const STATUS_VARIANT: Record<
	SignOffStatus,
	"warning" | "success" | "secondary" | "error" | "outline"
> = {
	pending: "warning",
	applied: "success",
	rejected: "secondary",
	expired: "outline",
	cancelled: "outline",
	failed: "error",
};

export function SignOffStatusBadge({ status }: { status: SignOffStatus }) {
	return (
		<Badge data-testid="sign-off-status" variant={STATUS_VARIANT[status]}>
			{SIGN_OFF_STATUS_LABEL[status] ?? status}
		</Badge>
	);
}

export function SignOffChanges({ changes }: { changes: SignOffChange[] }) {
	if (changes.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				The request lists no field changes. The plain diff below shows what it
				does.
			</p>
		);
	}
	return (
		<ListFrame>
			<ul aria-label="Changes" className="divide-y">
				{changes.map((change) => (
					<li
						className="flex min-w-0 flex-col gap-2.5 px-3.5 py-3"
						data-testid="sign-off-change"
						key={change.field}
					>
						<div className="flex min-w-0 items-start justify-between gap-3">
							<div className="min-w-0">
								<span
									className="block break-all font-medium font-mono text-[13px]"
									translate="no"
								>
									{change.field}
								</span>
								{change.reason ? (
									<span className="mt-0.5 block text-pretty text-muted-foreground text-xs">
										{change.reason}
									</span>
								) : null}
							</div>
							{change.direction === "loosening" ? (
								<Badge className="shrink-0" variant="warning">
									loosens
								</Badge>
							) : change.direction === "tightening" ? (
								<Badge className="shrink-0" variant="success">
									tightens
								</Badge>
							) : null}
						</div>
						<div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-stretch">
							<ChangeValue label="Before" value={change.from} />
							<ArrowRight
								aria-hidden="true"
								className="hidden size-3.5 self-center text-muted-foreground md:block"
							/>
							<ChangeValue label="After" value={change.to} />
						</div>
					</li>
				))}
			</ul>
		</ListFrame>
	);
}

function displayValue(value: unknown): string {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (/^[[{]/.test(trimmed)) {
			try {
				return JSON.stringify(JSON.parse(trimmed), null, 2);
			} catch {
				return value;
			}
		}
		return formatChangeValue(value);
	}
	if (value !== null && typeof value === "object") {
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return formatChangeValue(value);
		}
	}
	return formatChangeValue(value);
}

function ChangeValue({
	value,
	label,
}: {
	value: unknown;
	label: "Before" | "After";
}) {
	const none = value === null || value === undefined || value === "";
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
				{label}
			</span>
			<pre
				className={cn(
					"max-h-64 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border px-2.5 py-1.5 font-mono text-xs tabular-nums leading-5 [overflow-wrap:anywhere]",
					label === "Before"
						? "bg-muted/40 text-muted-foreground"
						: "bg-background text-foreground",
					none && "text-muted-foreground italic",
				)}
				translate="no"
			>
				{none ? "none" : displayValue(value)}
			</pre>
		</div>
	);
}

export function SignOffPlainDiff({ diff }: { diff: string }) {
	if (!diff.trim()) return null;
	return (
		<Collapsible>
			<CollapsibleTrigger className="group inline-flex items-center gap-1 rounded-sm font-medium text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
				<ChevronRight
					aria-hidden="true"
					className="size-3.5 transition-transform duration-150 group-data-[panel-open]:rotate-90 motion-reduce:transition-none"
				/>
				Plain diff
			</CollapsibleTrigger>
			<CollapsiblePanel>
				<pre
					className="mt-2 max-h-80 overflow-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed"
					data-testid="sign-off-diff"
					translate="no"
				>
					{diff.split("\n").map((line, index) => {
						const kind = diffLineKind(line);
						return (
							<span
								className={cn(
									"block whitespace-pre-wrap break-words",
									kind === "removed" && "text-rose-700 dark:text-rose-300",
									kind === "added" && "text-emerald-700 dark:text-emerald-300",
								)}
								// biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity and never reorder
								key={index}
							>
								{line || " "}
							</span>
						);
					})}
				</pre>
			</CollapsiblePanel>
		</Collapsible>
	);
}

export interface DecideInput {
	decision: "approve" | "reject";
	note?: string;
}

export function SignOffDecision({
	signOff,
	canDecide,
	pending,
	error,
	onDecide,
	decidedByName,
}: {
	signOff: SignOffRequest;
	canDecide: boolean;
	pending: boolean;
	error?: Error | null;
	onDecide: (input: DecideInput, options?: { onSuccess?: () => void }) => void;
	decidedByName?: string;
}) {
	const noteId = useId();
	const [note, setNote] = useState("");
	const [confirming, setConfirming] = useState(false);
	const decidable = isDecidable(signOff);
	const trimmed = note.trim() || undefined;

	if (!decidable) {
		return <SignOffOutcome decidedByName={decidedByName} signOff={signOff} />;
	}

	const message =
		error && !(error instanceof ApiError && error.status === 409)
			? error.message || "The decision could not be recorded."
			: null;

	return (
		<PageSection
			description={
				<>
					Expires <RelativeTime value={signOff.expiresAt} />. Until someone
					decides, nothing changes.
				</>
			}
			title="Decision"
		>
			<p className="max-w-2xl text-pretty text-sm">
				Your agent asked for this. It cannot approve its own request; a person
				in this workspace has to.
			</p>
			{canDecide ? (
				<div className="flex max-w-2xl flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={noteId}>Note (optional)</Label>
						<Textarea
							id={noteId}
							name="note"
							onChange={(event) => setNote(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
									event.preventDefault();
									setConfirming(true);
								}
							}}
							placeholder="Recorded with your decision…"
							size="sm"
							value={note}
						/>
					</div>
					{message ? (
						<p className="text-destructive text-sm" role="alert">
							{message}
						</p>
					) : null}
					<div className="flex flex-wrap items-center gap-2">
						<Button
							disabled={pending}
							onClick={() => setConfirming(true)}
							type="button"
						>
							<Check />
							Approve and apply
						</Button>
						<Button
							disabled={pending}
							loading={pending && !confirming}
							onClick={() => onDecide({ decision: "reject", note: trimmed })}
							type="button"
							variant="outline"
						>
							<X />
							Reject
						</Button>
					</div>
				</div>
			) : (
				<p
					className="text-muted-foreground text-sm"
					data-testid="sign-off-not-allowed"
				>
					A workspace admin decides sign-offs. Your role can view this request.
				</p>
			)}

			<AlertDialog onOpenChange={setConfirming} open={confirming}>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle className="text-lg leading-snug">
							{signOff.summary}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{loosens(signOff)
								? "This loosens what the agent may do. Apply it?"
								: "Apply this change?"}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose
							render={<Button variant="outline">Cancel</Button>}
						/>
						<Button
							loading={pending}
							onClick={() =>
								onDecide(
									{ decision: "approve", note: trimmed },
									{ onSuccess: () => setConfirming(false) },
								)
							}
						>
							Apply
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</PageSection>
	);
}

const NOTHING_CHANGED: Partial<Record<SignOffStatus, string>> = {
	rejected: "Nothing changed.",
	expired: "Nobody decided within its time. Nothing changed.",
	cancelled: "The agent withdrew it. Nothing changed.",
};

function SignOffOutcome({
	signOff,
	decidedByName,
}: {
	signOff: SignOffRequest;
	decidedByName?: string;
}) {
	const via =
		signOff.decidedBy?.via === "email_link"
			? " from the email link"
			: signOff.decidedBy?.via === "console"
				? " in the console"
				: "";
	const verb =
		signOff.status === "rejected"
			? "Rejected"
			: signOff.status === "applied" || signOff.status === "failed"
				? "Approved"
				: "Decided";
	const status: SignOffStatus =
		signOff.status === "pending" ? "expired" : signOff.status;

	return (
		<PageSection title="Decision">
			<div
				className="flex flex-col gap-2 text-sm"
				data-testid="sign-off-outcome"
			>
				<div className="flex flex-wrap items-center gap-2">
					<SignOffStatusBadge status={status} />
					{signOff.decidedBy && signOff.decidedAt ? (
						<span className="text-muted-foreground">
							{verb} by{" "}
							<span className="text-foreground">
								{decidedByName ?? "a workspace admin"}
							</span>
							{via}, <RelativeTime value={signOff.decidedAt} />.
						</span>
					) : null}
				</div>
				{signOff.decisionNote ? (
					<p className="text-muted-foreground italic">
						“{signOff.decisionNote}”
					</p>
				) : null}
				{NOTHING_CHANGED[status] ? (
					<p className="text-muted-foreground">{NOTHING_CHANGED[status]}</p>
				) : null}
				{status === "failed" ? (
					<div className="flex flex-col gap-1">
						<p className="text-destructive">
							{signOff.error?.message ?? "The change could not be applied."}
						</p>
						<p className="text-muted-foreground">
							Nothing changed. Your agent can ask again.
						</p>
					</div>
				) : null}
			</div>
			{status === "applied" ? (
				<div className="flex flex-col gap-1.5">
					<p className="text-muted-foreground text-xs">
						The change is applied. What it returned:
					</p>
					<pre
						className="max-h-80 overflow-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed"
						data-testid="sign-off-result"
						translate="no"
					>
						{signOff.result === null || signOff.result === undefined
							? "No details returned."
							: JSON.stringify(signOff.result, null, 2)}
					</pre>
				</div>
			) : null}
		</PageSection>
	);
}
