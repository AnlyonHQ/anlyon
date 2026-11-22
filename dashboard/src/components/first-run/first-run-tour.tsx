import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	useFirstRun,
	useFirstRunMutations,
	useSandboxToken,
} from "@/hooks/api/use-first-run";
import {
	agentSnippet,
	DEMO_ACTION,
	DEMO_INPUT,
	DEMO_SECRET,
	type FirstRunStep,
	formatElapsed,
	isStepDone,
	type SnippetLanguage,
	STEP_ORDER,
	sandboxHost,
	sandboxReceipt,
	sandboxUrl,
	tokenWasRedacted,
} from "@/lib/first-run";
import { useFirstRunClock, useFirstRunHidden } from "@/lib/first-run-storage";
import type { Invocation } from "@/lib/types";
import { cn, copyToClipboard } from "@/lib/utils";
import { Dot, StepItem, StepList, StepProgress } from "./steps";

type Chapter = Exclude<FirstRunStep, "done">;

const CHAPTER: Record<Chapter, { title: string; line: string }> = {
	vault: {
		title: "The credential",
		line: "Anlyon holds the key. Your agent never will.",
	},
	action: {
		title: "The action",
		line: "Describe the call once. Your agent learns just its name.",
	},
	call: {
		title: "The call",
		line: "Your agent asks by name. Anlyon decides whether it goes.",
	},
	approve: {
		title: "The decision",
		line: "The request is held until a person says yes.",
	},
};

const CODING_AGENT_PROMPT =
	"Fetch and execute the appropriate instructions to set me up for Anlyon from https://docs.anlyon.com/agents/prompt.md";

const amountLabel = (DEMO_INPUT.amount / 100).toLocaleString("en-US", {
	style: "currency",
	currency: "USD",
});

export function FirstRunTour({ workspaceId }: { workspaceId?: string }) {
	const tour = useFirstRun(workspaceId);
	const mutations = useFirstRunMutations(workspaceId);
	const clock = useFirstRunClock(workspaceId, tour.step);
	const host = sandboxHost();
	const completed = STEP_ORDER.filter((s) => isStepDone(tour.step, s)).length;

	if (tour.loading) return <TourSkeleton />;

	return (
		<article className="mx-auto w-full max-w-[44rem] pt-2 pb-24">
			<header>
				<div className="flex items-baseline justify-between gap-4 text-[13px] text-muted-foreground">
					<span>Sandbox tour</span>
					<span className="tabular-nums">
						{tour.step === "done"
							? "Done"
							: `${completed} of ${STEP_ORDER.length}`}
						{clock.elapsedMs !== null ? (
							<>
								<span aria-hidden="true" className="px-1.5">
									·
								</span>
								<span className="font-mono">
									{formatElapsed(clock.elapsedMs)}
								</span>
							</>
						) : null}
					</span>
				</div>
				<StepProgress done={completed} total={STEP_ORDER.length} />
				<h2 className="mt-8 text-balance font-heading text-[2rem] leading-[1.1] tracking-[-0.02em]">
					One governed action, start to finish.
				</h2>
				<p className="mt-3 max-w-[36rem] text-pretty text-[15px] text-muted-foreground leading-relaxed">
					Four moves, about three minutes. It runs against Anlyon&rsquo;s
					sandbox, so nothing touches your systems.
				</p>
			</header>

			{tour.error ? (
				<p aria-live="polite" className="mt-8 text-destructive text-sm">
					{tour.error.message}
				</p>
			) : null}

			<StepList>
				<ChapterItem
					chapter="vault"
					current={tour.step}
					number={1}
					result={[`${DEMO_SECRET} sealed`, `sent to ${host}`, "in the header"]}
				>
					<VaultPanel
						error={mutations.storeSecret.error}
						host={host}
						onSeal={(value) => mutations.storeSecret.mutate(value)}
						pending={mutations.storeSecret.isPending}
						workspaceId={workspaceId}
					/>
				</ChapterItem>
				<ChapterItem
					chapter="action"
					current={tour.step}
					number={2}
					result={[`${DEMO_ACTION} defined`, "approval required"]}
				>
					<ActionPanel
						error={mutations.defineAction.error}
						onDefine={() => mutations.defineAction.mutate()}
						pending={mutations.defineAction.isPending}
					/>
				</ChapterItem>
				<ChapterItem
					chapter="call"
					current={tour.step}
					number={3}
					result={["202", "held for approval"]}
				>
					<CallPanel
						error={mutations.callAsAgent.error}
						lastInvocation={tour.invocation}
						onRun={() => mutations.callAsAgent.mutate()}
						pending={mutations.callAsAgent.isPending}
					/>
				</ChapterItem>
				<ChapterItem
					chapter="approve"
					current={tour.step}
					last
					number={4}
					result={[
						"approved by you",
						tour.invocation?.status === "unknown"
							? "outcome unknown"
							: tour.invocation?.status === "running"
								? "running"
								: "sent with the token attached",
					]}
				>
					<ApprovalPanel
						error={mutations.decide.error}
						invocation={tour.invocation}
						onDecide={(decision) => {
							const approvalId = tour.invocation?.approvalId;
							if (approvalId) mutations.decide.mutate({ approvalId, decision });
						}}
						pending={mutations.decide.isPending}
					/>
				</ChapterItem>
			</StepList>

			{tour.step === "done" && tour.invocation ? (
				<Outcome
					elapsedMs={clock.elapsedMs}
					invocation={tour.invocation}
					onReset={() => {
						clock.reset();
						mutations.reset.mutate();
					}}
					resetting={mutations.reset.isPending}
					workspaceId={workspaceId}
				/>
			) : null}
		</article>
	);
}

function ChapterItem({
	chapter,
	number,
	current,
	result,
	last,
	children,
}: {
	chapter: Chapter;
	number: number;
	current: FirstRunStep;
	result: string[];
	last?: boolean;
	children: ReactNode;
}) {
	const { title, line } = CHAPTER[chapter];
	return (
		<StepItem
			last={last}
			line={line}
			number={number}
			result={result}
			state={
				isStepDone(current, chapter)
					? "done"
					: current === chapter
						? "active"
						: "todo"
			}
			title={title}
		>
			{children}
		</StepItem>
	);
}

function VaultPanel({
	host,
	onSeal,
	pending,
	error,
	workspaceId,
}: {
	host: string;
	onSeal: (value: string) => void;
	pending: boolean;
	error: Error | null;
	workspaceId?: string;
}) {
	const { token } = useSandboxToken(workspaceId);
	const [shown, setShown] = useState(false);

	return (
		<Panel
			footer={
				<>
					<Hint>
						Once sealed, nobody can read it back. Not you, not your agent.
					</Hint>
					<Button
						disabled={!token}
						loading={pending || !token}
						onClick={() => token && onSeal(token)}
						size="sm"
					>
						Seal
					</Button>
				</>
			}
			label={`vault / ${DEMO_SECRET}`}
		>
			<Fields>
				<Field name="value">
					<span className="break-all">
						{!token
							? "•".repeat(24)
							: shown
								? token
								: `${token.slice(0, 12)}${"•".repeat(12)}`}
					</span>
					<button
						className="ml-3 font-sans text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onClick={() => setShown(!shown)}
						type="button"
					>
						{shown ? "hide" : "show"}
					</button>
				</Field>
				<Field name="sent to">
					{host}
					<span className="text-muted-foreground">, nowhere else</span>
				</Field>
				<Field name="placement">
					header<span className="text-muted-foreground">, nowhere else</span>
				</Field>
			</Fields>
			<p className="px-4 pb-3 text-[12.5px] text-muted-foreground">
				A single-use value, generated for this run.
			</p>
			<ErrorLine error={error} />
		</Panel>
	);
}

function ActionPanel({
	onDefine,
	pending,
	error,
}: {
	onDefine: () => void;
	pending: boolean;
	error: Error | null;
}) {
	return (
		<Panel
			footer={
				<>
					<Hint>
						<Mark kind="secret">amber</Mark> is filled by Anlyon from the vault,{" "}
						<Mark kind="input">blue</Mark> by your agent.
					</Hint>
					<Button loading={pending} onClick={onDefine} size="sm">
						Define
					</Button>
				</>
			}
			label={`action / ${DEMO_ACTION}`}
		>
			<pre className="whitespace-pre-wrap px-4 py-4 font-mono text-[13px] leading-6 [overflow-wrap:anywhere]">
				<span className="font-medium">POST</span> {sandboxUrl()}
				{"\n"}
				<span className="text-muted-foreground">Authorization:</span> Bearer{" "}
				<Mark kind="secret">{`{{secret:${DEMO_SECRET}}}`}</Mark>
				{"\n\n"}
				{"{ "}
				<span className="text-muted-foreground">&quot;orderId&quot;:</span>{" "}
				<Mark kind="input">{"{{input.orderId}}"}</Mark>
				{", "}
				<span className="text-muted-foreground">&quot;amount&quot;:</span>{" "}
				<Mark kind="input">{"{{input.amount}}"}</Mark>
				{" }"}
				{"\n\n"}
				<span className="text-muted-foreground">approval</span> required for
				every call
			</pre>
			<ErrorLine error={error} />
		</Panel>
	);
}

const LANGUAGES: { key: SnippetLanguage; file: string }[] = [
	{ key: "typescript", file: "agent.ts" },
	{ key: "python", file: "agent.py" },
	{ key: "curl", file: "curl" },
];

function CallPanel({
	lastInvocation,
	onRun,
	pending,
	error,
}: {
	lastInvocation: Invocation | null;
	onRun: () => void;
	pending: boolean;
	error: Error | null;
}) {
	const [language, setLanguage] = useState<SnippetLanguage>("typescript");
	const [copied, setCopied] = useState(false);
	const snippet = agentSnippet(language);
	const previous =
		lastInvocation?.status === "denied"
			? "denied: nothing was sent"
			: lastInvocation?.status === "expired"
				? "expired unanswered"
				: lastInvocation?.status === "failed"
					? `failed: ${lastInvocation.error ?? "unknown error"}`
					: null;

	return (
		<Panel
			footer={
				<>
					<Hint>
						The same call, sent from here on your agent&rsquo;s behalf.
					</Hint>
					<Button loading={pending} onClick={onRun} size="sm">
						Run
					</Button>
				</>
			}
			label={
				<span aria-label="Language" className="flex gap-4" role="tablist">
					{LANGUAGES.map(({ key, file }) => (
						<button
							aria-selected={language === key}
							className={cn(
								"-mb-px border-b py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								language === key
									? "border-foreground text-foreground"
									: "border-transparent hover:text-foreground",
							)}
							key={key}
							onClick={() => setLanguage(key)}
							role="tab"
							type="button"
						>
							{file}
						</button>
					))}
				</span>
			}
			tool={
				<button
					className="text-[12px] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onClick={async () => {
						const result = await copyToClipboard(snippet);
						if (result.success) {
							setCopied(true);
							setTimeout(() => setCopied(false), 1600);
						}
					}}
					type="button"
				>
					{copied ? "copied" : "copy"}
				</button>
			}
		>
			<pre className="overflow-x-auto px-4 py-4 font-mono text-[13px] leading-6 max-sm:whitespace-pre-wrap max-sm:[overflow-wrap:anywhere]">
				<code>{snippet}</code>
			</pre>
			<p className="border-t px-4 py-2.5 text-[12.5px] text-muted-foreground">
				{language === "curl"
					? "No URL, no header, no key for the destination API. The agent key shown here is its Anlyon key."
					: "No URL, no header, no key. Just a name and the blanks."}
				{previous ? (
					<span aria-live="polite" className="block text-foreground/80">
						Last run {previous}. Run it again.
					</span>
				) : null}
			</p>
			<ErrorLine error={error} />
		</Panel>
	);
}

function ApprovalPanel({
	invocation,
	onDecide,
	pending,
	error,
}: {
	invocation: Invocation | null;
	onDecide: (decision: "approve" | "deny") => void;
	pending: boolean;
	error: Error | null;
}) {
	const [choice, setChoice] = useState<"approve" | "deny" | null>(null);
	const disabled = !invocation?.approvalId || pending;

	return (
		<Panel
			footer={
				<>
					<Hint>
						This is what lands in your approvals inbox, and in Slack if you
						connect it.
					</Hint>
					<span className="flex gap-2">
						<Button
							disabled={disabled}
							loading={pending && choice === "deny"}
							onClick={() => {
								setChoice("deny");
								onDecide("deny");
							}}
							size="sm"
							variant="ghost"
						>
							Deny
						</Button>
						<Button
							disabled={disabled}
							loading={pending && choice === "approve"}
							onClick={() => {
								setChoice("approve");
								onDecide("approve");
							}}
							size="sm"
						>
							Approve
						</Button>
					</span>
				</>
			}
			label="approvals / waiting"
			tool={
				<span className="font-mono text-[12px] text-amber-700 dark:text-amber-300">
					held
				</span>
			}
		>
			<div className="px-4 pt-4 pb-3">
				<p className="text-[15px] leading-relaxed">
					Your agent wants to refund{" "}
					<span className="font-medium">{amountLabel}</span> on{" "}
					<span className="font-medium font-mono text-[14px]">
						{DEMO_INPUT.orderId}
					</span>
					.
				</p>
				<p className="mt-1 text-[13px] text-muted-foreground">
					{DEMO_ACTION} requires approval. Nothing has been sent.
				</p>
			</div>
			<Fields>
				<Field name="orderId">{DEMO_INPUT.orderId}</Field>
				<Field name="amount">
					{DEMO_INPUT.amount}
					<span className="text-muted-foreground"> cents</span>
				</Field>
			</Fields>
			<ErrorLine error={error} />
		</Panel>
	);
}

const SENT_COPY = {
	heading: "Sent. Your agent never saw the key.",
	note: null,
	sentLabel: "What the API received",
};

const NEUTRAL_COPY = {
	heading: "Your agent never saw the key.",
	note: "This call did not finish as succeeded. Open the invocation to see what happened.",
	sentLabel: "What Anlyon attaches at dispatch",
};

const OUTCOME_COPY: Partial<
	Record<
		Invocation["status"],
		{ heading: string; note: string | null; sentLabel: string }
	>
> = {
	succeeded: SENT_COPY,
	running: {
		heading: "Approved. Your agent never saw the key.",
		note: "Anlyon is making the call. The reply appears here when it is stored.",
		sentLabel: "What Anlyon attaches at dispatch",
	},
	unknown: {
		heading: "Outcome unknown. Your agent never saw the key.",
		note: "No usable response. Anlyon does not send it again. It stays unknown until a read-back or an operator settles it.",
		sentLabel: "What Anlyon attaches at dispatch",
	},
};

function Outcome({
	invocation,
	elapsedMs,
	onReset,
	resetting,
	workspaceId,
}: {
	invocation: Invocation;
	elapsedMs: number | null;
	onReset: () => void;
	resetting: boolean;
	workspaceId?: string;
}) {
	const [, setHidden] = useFirstRunHidden(workspaceId);
	const [copied, setCopied] = useState(false);
	const receipt = sandboxReceipt(invocation.body);
	const returned = receipt?.authorization ?? null;
	const scrubbed = tokenWasRedacted(receipt);
	const outcome = OUTCOME_COPY[invocation.status] ?? NEUTRAL_COPY;

	return (
		<section
			aria-labelledby="first-run-outcome"
			className="mt-10 motion-safe:fade-in motion-safe:animate-in motion-safe:duration-700"
		>
			<h2
				className="text-balance font-semibold text-[1.625rem] leading-tight tracking-[-0.015em]"
				id="first-run-outcome"
			>
				{outcome.heading}
			</h2>
			{outcome.note ? (
				<p className="mt-3 max-w-[36rem] text-[14px] text-muted-foreground">
					{outcome.note}
				</p>
			) : null}

			<section
				aria-label="What was sent and returned"
				className="mt-6 overflow-hidden rounded-lg border bg-card"
			>
				<dl className="divide-y font-mono text-[13px]">
					<div className="grid gap-1 px-4 py-3 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-4">
						<dt className="font-sans text-muted-foreground">
							{outcome.sentLabel}
						</dt>
						<dd className="break-all">
							Authorization: Bearer demo_sk_
							<span className="text-muted-foreground">••••••••</span>
						</dd>
					</div>
					<div className="grid gap-1 px-4 py-3 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-4">
						<dt className="font-sans text-muted-foreground">
							What your agent got back
						</dt>
						<dd className="break-all">
							{returned ? (
								<>
									Authorization:{" "}
									<span className="rounded-sm bg-emerald-500/10 px-1 text-emerald-800 dark:text-emerald-200">
										{returned}
									</span>
								</>
							) : (
								<span className="font-sans text-muted-foreground">
									The stored reply could not be read.
								</span>
							)}
						</dd>
					</div>
				</dl>
				<p className="border-t bg-muted/30 px-4 py-2.5 text-[12.5px] text-muted-foreground">
					{scrubbed
						? "The sandbox echoed the token back. Anlyon scrubbed it before storing or returning the reply."
						: "Open the invocation to see the reply Anlyon stored."}
				</p>
			</section>

			<p className="mt-3 font-mono text-[12px] text-muted-foreground tabular-nums">
				{invocation.responseStatus ?? "—"}
				{invocation.durationMs !== null ? (
					<>
						<Dot />
						{invocation.durationMs} ms
					</>
				) : null}
				<Dot />
				approved by you
				<Dot />
				{invocation.id}
				{elapsedMs !== null ? (
					<>
						<Dot />
						finished in {formatElapsed(elapsedMs)}
					</>
				) : null}
			</p>

			<h3 className="mt-10 font-medium text-[15px]">Next</h3>
			<ul className="mt-3 divide-y border-y">
				<NextRow
					action={
						<button
							className="whitespace-nowrap text-[13px] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={async () => {
								const result = await copyToClipboard(CODING_AGENT_PROMPT);
								if (result.success) {
									setCopied(true);
									setTimeout(() => setCopied(false), 1600);
								}
							}}
							type="button"
						>
							{copied ? "Copied" : "Copy prompt"}
						</button>
					}
					body="One prompt in Claude Code, Cursor or Codex wires your project up."
					title="Connect your coding agent"
				/>
				<NextRow
					action={
						<a
							className="whitespace-nowrap text-[13px] underline-offset-4 hover:underline"
							href="https://docs.anlyon.com/execution/actions"
							rel="noreferrer"
							target="_blank"
						>
							Read the guide
						</a>
					}
					body="Import an OpenAPI spec or define one call by hand, with your own secret."
					title="Define a real action"
				/>
				<NextRow
					action={
						<Link
							className="whitespace-nowrap text-[13px] underline-offset-4 hover:underline"
							to="/approval-policies"
						>
							Open policies
						</Link>
					}
					body="Choose what runs on its own and what waits for an approver."
					title="Write an approval policy"
				/>
			</ul>

			<p className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-muted-foreground">
				<button
					className="underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
					disabled={resetting}
					onClick={onReset}
					type="button"
				>
					Remove the demo and start over
				</button>
				<button
					className="underline-offset-4 hover:text-foreground hover:underline"
					onClick={() => setHidden(true)}
					type="button"
				>
					Hide Get Started from the sidebar
				</button>
			</p>
		</section>
	);
}

function NextRow({
	title,
	body,
	action,
}: {
	title: string;
	body: string;
	action: ReactNode;
}) {
	return (
		<li className="flex items-baseline justify-between gap-6 py-3.5">
			<div className="min-w-0">
				<p className="text-[14px]">{title}</p>
				<p className="mt-0.5 text-[13px] text-muted-foreground">{body}</p>
			</div>
			{action}
		</li>
	);
}

function Panel({
	label,
	tool,
	footer,
	children,
}: {
	label: ReactNode;
	tool?: ReactNode;
	footer: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="overflow-hidden rounded-lg border bg-card">
			<div className="flex min-h-9 items-center justify-between gap-4 border-b px-4 font-mono text-[12px] text-muted-foreground">
				{label}
				{tool}
			</div>
			{children}
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t bg-muted/30 px-4 py-3">
				{footer}
			</div>
		</div>
	);
}

function Fields({ children }: { children: ReactNode }) {
	return <dl className="py-2 font-mono text-[13px]">{children}</dl>;
}

function Field({ name, children }: { name: string; children: ReactNode }) {
	return (
		<div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3 px-4 py-1.5">
			<dt className="text-muted-foreground">{name}</dt>
			<dd className="min-w-0">{children}</dd>
		</div>
	);
}

function Hint({ children }: { children: ReactNode }) {
	return (
		<p className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
			{children}
		</p>
	);
}

function Mark({
	kind,
	children,
}: {
	kind: "secret" | "input";
	children: ReactNode;
}) {
	return (
		<span
			className={cn(
				"rounded-sm px-1",
				kind === "secret"
					? "bg-amber-500/12 text-amber-800 dark:text-amber-200"
					: "bg-sky-500/12 text-sky-800 dark:text-sky-200",
			)}
		>
			{children}
		</span>
	);
}

function ErrorLine({ error }: { error: Error | null }) {
	if (!error) return null;
	return (
		<p
			aria-live="polite"
			className="border-t px-4 py-2.5 text-[13px] text-destructive"
		>
			{error.message}
		</p>
	);
}

function TourSkeleton() {
	return (
		<div
			aria-busy="true"
			className="mx-auto w-full max-w-[44rem] space-y-4 pt-2"
		>
			<div className="h-3 w-24 rounded bg-muted motion-safe:animate-pulse" />
			<div className="h-9 w-[28rem] max-w-full rounded bg-muted motion-safe:animate-pulse" />
			<div className="h-4 w-80 max-w-full rounded bg-muted motion-safe:animate-pulse" />
		</div>
	);
}
