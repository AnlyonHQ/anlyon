import { Link } from "@tanstack/react-router";
import { ArrowRight, ArrowUpRight, Check, Copy, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { useStartHere } from "@/hooks/api/use-start-here";
import {
	callNeeds,
	connectNeeds,
	readStartHereHidden,
	START_SNIPPETS,
	type StartHereInput,
	type StartStepId,
	startProgress,
	startSteps,
	writeStartHereHidden,
} from "@/lib/start-here";
import { cn, copyToClipboard } from "@/lib/utils";
import { StepProgress } from "./steps";

const GUIDE_URL = "https://docs.anlyon.com/guides/act-for-your-users";

const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

interface StepCopy {
	title: string;
	body: string;
	doneLine: (input: StartHereInput) => string;
}

const STEPS: Record<StartStepId, StepCopy> = {
	key: {
		title: "Create an API key",
		body: "Your server calls Anlyon with it. It stays on your server, never in the browser or the model.",
		doneLine: (input) =>
			plural(input.apiKeys ?? 0, "active key", "active keys"),
	},
	connect: {
		title: "Connect a user",
		body: "Your app sends one of your users to a connect link, and they sign in to their own account, such as Gmail.",
		doneLine: (input) =>
			plural(input.connectedUsers ?? 0, "user connected", "users connected"),
	},
	call: {
		title: "Make a governed call for that user",
		body: "Your agent calls an action as that user. Their limits and approvals apply, and the call gets a receipt.",
		doneLine: (input) =>
			`Calls made for ${plural(input.usersWithCalls ?? 0, "user", "users")}`,
	},
};

export function StartHere({ workspaceId }: { workspaceId?: string }) {
	const [hidden, setHidden] = useState(() => readStartHereHidden(workspaceId));
	if (!workspaceId || hidden) return null;
	const hide = () => {
		writeStartHereHidden(workspaceId, true);
		setHidden(true);
	};
	return <StartHereCard onHide={hide} workspaceId={workspaceId} />;
}

function StartHereCard({
	workspaceId,
	onHide,
}: {
	workspaceId: string;
	onHide: () => void;
}) {
	const titleId = useId();
	const facts = useStartHere(workspaceId);
	const steps = startSteps(facts);
	const { done, total, complete, next } = startProgress(steps);

	if (!facts.available) return null;

	if (complete) {
		return (
			<section
				aria-labelledby={titleId}
				className="onboarding-enter flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card px-4 py-3 sm:px-5"
				data-slot="start-here"
				data-state="complete"
			>
				<span
					aria-hidden="true"
					className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background"
				>
					<Check className="size-3.5" strokeWidth={3} />
				</span>
				<div className="min-w-0 flex-1">
					<h2 className="font-medium text-[14px]" id={titleId}>
						You are set up
					</h2>
					<p className="text-[12.5px] text-muted-foreground">
						Your agent acts for your users, under their limits and approvals.
						Next, add a <InlineLink to="/approval-policies">policy</InlineLink>{" "}
						or <InlineLink to="/settings/team">invite a teammate</InlineLink>.
					</p>
				</div>
				<Button onClick={onHide} size="xs" variant="ghost">
					Hide
				</Button>
			</section>
		);
	}

	return (
		<section
			aria-labelledby={titleId}
			className="onboarding-enter overflow-hidden rounded-lg border bg-card"
			data-slot="start-here"
			data-state="open"
		>
			<header className="px-4 pt-4 pb-4 sm:px-5 sm:pt-5">
				<div className="flex items-center justify-between gap-4">
					<h2
						className="font-semibold text-[12px] text-muted-foreground uppercase tracking-wide"
						id={titleId}
					>
						Start here
					</h2>
					<div className="-my-1 flex shrink-0 items-center gap-2">
						<span
							className="text-[12.5px] text-muted-foreground tabular-nums"
							data-slot="start-here-progress"
						>
							{done} of {total}
						</span>
						<Button
							aria-label="Hide Start here"
							className="rounded-full text-muted-foreground hover:text-foreground"
							onClick={onHide}
							size="icon-xs"
							title="Hide"
							variant="ghost"
						>
							<X />
						</Button>
					</div>
				</div>
				<StepProgress done={done} total={total} />
				<p className="mt-4 text-balance font-heading text-[19px] leading-snug tracking-tight">
					Let your AI agent act in your users&apos; own accounts, safely.
				</p>
				<p className="mt-1.5 max-w-2xl text-pretty text-[13.5px] text-muted-foreground">
					Each user connects their own Gmail, HubSpot or Slack. Every call your
					agent makes there is capped, approved when you choose, and recorded
					with a receipt, per user.
				</p>
			</header>
			<ol className="divide-y border-t">
				{steps.map((step, index) => (
					<StepRow
						facts={facts}
						id={step.id}
						index={index + 1}
						isNext={step.id === next}
						key={step.id}
						state={step.done}
					/>
				))}
			</ol>
			<footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t bg-muted/30 px-4 py-2.5 text-[12.5px] text-muted-foreground sm:px-5">
				<span>
					Rather see it work on your own account?{" "}
					<InlineLink to="/get-started">Try the guided start</InlineLink>
				</span>
				<a
					className="inline-flex items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					href={GUIDE_URL}
					rel="noreferrer"
					target="_blank"
				>
					The full guide
					<ArrowUpRight aria-hidden="true" className="size-3" />
				</a>
			</footer>
		</section>
	);
}

function StepRow({
	id,
	index,
	state,
	isNext,
	facts,
}: {
	id: StartStepId;
	index: number;
	state: boolean | undefined;
	isNext: boolean;
	facts: StartHereInput;
}) {
	const copy = STEPS[id];
	const done = state === true;
	return (
		<li
			className={cn(
				"grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 px-4 py-4 sm:gap-x-3.5 transition-colors duration-300 ease-out sm:px-5",
				isNext && "bg-muted/30",
			)}
			data-state={done ? "done" : isNext ? "next" : "todo"}
			data-step={id}
		>
			<StepMark done={done} index={index} known={state !== undefined} />
			<div className="min-w-0">
				<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
					<h3
						className={cn(
							"font-medium text-[14px]",
							done && "text-muted-foreground",
						)}
					>
						{copy.title}
						<span className="sr-only">
							{done ? ", done" : state === false ? ", not done yet" : ""}
						</span>
					</h3>
					{done ? (
						<span className="text-[12.5px] text-muted-foreground tabular-nums">
							{copy.doneLine(facts)}
						</span>
					) : null}
				</div>
				{done ? null : (
					<p className="mt-0.5 max-w-2xl text-pretty text-[13px] text-muted-foreground">
						{copy.body}
					</p>
				)}
				{isNext ? <NextStep facts={facts} id={id} /> : null}
			</div>
		</li>
	);
}

function NextStep({ id, facts }: { id: StartStepId; facts: StartHereInput }) {
	if (id === "key") {
		return (
			<StepBody
				action={
					<PrimaryLink to="/settings/api-keys">Create an API key</PrimaryLink>
				}
				code={START_SNIPPETS.key}
				status={<Live>No API key yet</Live>}
			/>
		);
	}
	if (id === "connect") {
		const needs = connectNeeds(facts);
		return (
			<StepBody
				action={
					needs === "redirect" ? (
						<PrimaryLink to="/integrations/settings">
							Set a redirect URL
						</PrimaryLink>
					) : (
						<PrimaryLink to="/users">Open Users</PrimaryLink>
					)
				}
				code={START_SNIPPETS.connect}
				status={
					<>
						{needs === "redirect" ? (
							<Fact ok={false}>
								No default redirect URL yet. A connect link needs one to send
								your user back.
							</Fact>
						) : (
							<Fact ok>Default redirect URL set</Fact>
						)}
						<Live>Waiting for a user to connect</Live>
					</>
				}
			/>
		);
	}
	const needs = callNeeds(facts);
	return (
		<StepBody
			action={
				needs === "action" ? (
					<PrimaryLink to="/integrations">Add an integration</PrimaryLink>
				) : (
					<PrimaryLink to="/actions/invocations">Open Invocations</PrimaryLink>
				)
			}
			code={START_SNIPPETS.call(facts.exampleAction ?? "gmail-send")}
			status={
				<>
					{needs === "action" ? (
						<Fact ok={false}>
							No actions yet. Add an integration to give your agent some.
						</Fact>
					) : (
						<Fact ok>
							{plural(facts.actions ?? 0, "action", "actions")} ready
						</Fact>
					)}
					<Live>Waiting for a call made for a user</Live>
				</>
			}
		/>
	);
}

function StepBody({
	status,
	code,
	action,
}: {
	status: ReactNode;
	code: string;
	action: ReactNode;
}) {
	return (
		<div className="mt-3 flex flex-col gap-3">
			<ul className="flex flex-col gap-1 text-[12.5px]">{status}</ul>
			<CodeSnippet code={code} />
			<div className="flex flex-wrap items-center gap-2">{action}</div>
		</div>
	);
}

function Fact({ ok, children }: { ok: boolean; children: ReactNode }) {
	return (
		<li className="flex items-start gap-2">
			<span
				aria-hidden="true"
				className={cn(
					"mt-[5px] size-1.5 shrink-0 rounded-full",
					ok ? "bg-success" : "bg-warning",
				)}
			/>
			<span className={ok ? "text-foreground/80" : "text-foreground"}>
				{children}
			</span>
		</li>
	);
}

function Live({ children }: { children: ReactNode }) {
	return (
		<li className="flex items-center gap-2 text-muted-foreground">
			<span aria-hidden="true" className="relative flex size-1.5 shrink-0">
				<span className="absolute inline-flex size-full rounded-full bg-muted-foreground/40 motion-safe:animate-ping" />
				<span className="relative inline-flex size-1.5 rounded-full bg-muted-foreground/60" />
			</span>
			<span>{children}</span>
		</li>
	);
}

function CodeSnippet({ code }: { code: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="overflow-hidden rounded-lg bg-muted/60">
			<div className="flex items-center justify-between gap-2 py-1 pr-1 pl-3">
				<span className="font-mono text-[11px] text-muted-foreground">
					TypeScript · @anlyonhq/sdk
				</span>
				<Button
					aria-label="Copy the code"
					onClick={async () => {
						const result = await copyToClipboard(code);
						if (result.success) {
							setCopied(true);
							window.setTimeout(() => setCopied(false), 1500);
						}
					}}
					size="xs"
					variant="ghost"
				>
					{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
			<pre className="overflow-x-auto px-3 pt-1 pb-3 font-mono text-[12px] leading-relaxed">
				<code>{code}</code>
			</pre>
		</div>
	);
}

function StepMark({
	done,
	known,
	index,
}: {
	done: boolean;
	known: boolean;
	index: number;
}) {
	if (done) {
		return (
			<span
				aria-hidden="true"
				className="onboarding-enter mt-px flex size-6 items-center justify-center rounded-full bg-foreground text-background"
			>
				<Check className="size-3.5" strokeWidth={3} />
			</span>
		);
	}
	return (
		<span
			aria-hidden="true"
			className={cn(
				"mt-px flex size-6 items-center justify-center rounded-full border-[1.5px] border-foreground/20 font-medium text-[11.5px] text-muted-foreground tabular-nums",
				!known && "border-dashed",
			)}
		>
			{index}
		</span>
	);
}

function PrimaryLink({ to, children }: { to: string; children: ReactNode }) {
	return (
		<Button render={<Link to={to} />} size="sm">
			{children}
			<ArrowRight data-icon="inline-end" />
		</Button>
	);
}

function InlineLink({ to, children }: { to: string; children: ReactNode }) {
	return (
		<Link
			className="rounded-sm font-medium text-foreground underline decoration-foreground/20 underline-offset-2 outline-none transition-colors hover:decoration-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
			to={to}
		>
			{children}
		</Link>
	);
}
