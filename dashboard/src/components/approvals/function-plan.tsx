"use client";

import { Link } from "@tanstack/react-router";
import { Code2, ListTree } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { functionPlanPayload, RISK_TIER_LABEL } from "@/lib/functions";
import type { Approval } from "@/lib/types";
import { Pill, type Tone } from "./tone";

export interface FunctionPlanDetails {
	functionName: string | null;
	planRunId: string | null;
	planDigest: string | null;
	writes: Array<{ action: string; input: unknown }>;
	summary: string | null;
	riskTier: string | null;
	riskyPatterns: string[];
	computedActionNames: number;
	writesInLoop: number;
	riskyApis: string[];
}

const text = (value: unknown): string | null =>
	typeof value === "string" && value ? value : null;
const count = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? value : 0;
const strings = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];

export function functionPlanDetails(
	approval: Pick<Approval, "kind" | "payload">,
): FunctionPlanDetails | null {
	const plan = functionPlanPayload(approval);
	if (!plan) return null;
	const payload = approval.payload ?? {};
	const review =
		payload.review && typeof payload.review === "object"
			? (payload.review as Record<string, unknown>)
			: {};
	return {
		functionName: text(payload.functionName),
		planRunId: text(payload.planRunId),
		planDigest: text(payload.planDigest),
		writes: plan.writes,
		summary: plan.summary,
		riskTier: text(review.suggestedRiskTier),
		riskyPatterns: strings(review.riskyPatterns),
		computedActionNames: count(review.computedActionNames),
		writesInLoop: count(review.writesInLoop),
		riskyApis: strings(review.riskyApis),
	};
}

const RISK_TONE: Record<string, Tone> = {
	routine: "neutral",
	low: "neutral",
	moderate: "amber",
	high: "rose",
	critical: "rose",
};

function inputPreview(input: unknown): string {
	if (input === null || input === undefined) return "No input";
	if (typeof input !== "object" || Array.isArray(input))
		return JSON.stringify(input);
	return Object.entries(input as Record<string, unknown>)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join(", ");
}

export function FunctionPlan({ approval }: { approval: Approval }) {
	const [raw, setRaw] = useState(false);
	const [open, setOpen] = useState<Set<number>>(() => new Set([0]));
	const plan = functionPlanDetails(approval);
	if (!plan) return null;

	const findings: string[] = [];
	if (plan.computedActionNames > 0)
		findings.push(
			`Computes the name of an action it calls in ${plan.computedActionNames} ${plan.computedActionNames === 1 ? "place" : "places"}.`,
		);
	if (plan.writesInLoop > 0)
		findings.push(
			`Writes inside a loop in ${plan.writesInLoop} ${plan.writesInLoop === 1 ? "place" : "places"}. Each write is listed below.`,
		);
	for (const api of plan.riskyApis) findings.push(`Uses ${api}.`);
	const reviewed =
		plan.summary !== null ||
		plan.riskTier !== null ||
		plan.riskyPatterns.length > 0 ||
		findings.length > 0;

	const toggle = (index: number) =>
		setOpen((current) => {
			const next = new Set(current);
			if (next.has(index)) next.delete(index);
			else next.add(index);
			return next;
		});

	return (
		<section aria-label="Plan" className="space-y-4">
			<div className="flex items-center justify-between gap-3">
				<h3 className="font-medium text-sm">
					Plan
					<span className="ml-2 font-normal text-muted-foreground tabular-nums">
						{plan.writes.length} {plan.writes.length === 1 ? "write" : "writes"}
					</span>
				</h3>
				<Button
					aria-pressed={raw}
					onClick={() => setRaw((v) => !v)}
					size="xs"
					variant="ghost"
				>
					{raw ? (
						<ListTree className="size-3.5" />
					) : (
						<Code2 className="size-3.5" />
					)}
					{raw ? "Fields" : "Raw JSON"}
				</Button>
			</div>

			{raw ? (
				<pre className="max-h-96 overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-relaxed">
					{JSON.stringify(approval.payload, null, 2)}
				</pre>
			) : (
				<>
					{reviewed ? (
						<div className="space-y-2">
							<div className="flex flex-wrap items-center gap-2">
								<p className="text-muted-foreground text-xs">
									Review of this version
								</p>
								{plan.riskTier ? (
									<Pill tone={RISK_TONE[plan.riskTier] ?? "neutral"}>
										{RISK_TIER_LABEL[plan.riskTier] ?? plan.riskTier} risk
									</Pill>
								) : null}
							</div>
							{plan.summary ? (
								<p className="text-pretty text-sm leading-relaxed">
									{plan.summary}
								</p>
							) : null}
							{plan.riskyPatterns.length > 0 || findings.length > 0 ? (
								<ul className="list-disc space-y-1 ps-5 text-muted-foreground text-sm marker:text-muted-foreground/60">
									{plan.riskyPatterns.map((pattern) => (
										<li key={`pattern-${pattern}`}>{pattern}</li>
									))}
									{findings.map((finding) => (
										<li key={`finding-${finding}`}>{finding}</li>
									))}
								</ul>
							) : null}
						</div>
					) : null}

					<ol
						aria-label="Writes, in this order"
						className="divide-y overflow-hidden rounded-lg border"
					>
						{plan.writes.map((write, index) => {
							const expanded = open.has(index);
							const panelId = `${approval.id}-write-${index}`;
							return (
								<li
									// biome-ignore lint/suspicious/noArrayIndexKey: writes have no id of their own
									key={index}
								>
									<button
										aria-controls={panelId}
										aria-expanded={expanded}
										className="flex w-full min-w-0 items-baseline gap-3 px-4 py-2.5 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
										onClick={() => toggle(index)}
										type="button"
									>
										<span className="w-5 shrink-0 text-muted-foreground text-xs tabular-nums">
											{index + 1}.
										</span>
										<span
											className="shrink-0 font-medium font-mono text-[13px]"
											translate="no"
										>
											{write.action}
										</span>
										<span className="min-w-0 truncate font-mono text-muted-foreground text-xs">
											{inputPreview(write.input)}
										</span>
									</button>
									{expanded ? (
										<pre
											className="max-h-48 overflow-auto whitespace-pre-wrap break-all border-t bg-muted/30 px-4 py-3 ps-12 font-mono text-muted-foreground text-xs leading-relaxed"
											id={panelId}
										>
											{JSON.stringify(write.input, null, 2)}
										</pre>
									) : null}
								</li>
							);
						})}
					</ol>

					<dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
						{plan.functionName ? (
							<div className="min-w-0">
								<dt className="text-muted-foreground text-xs">Function</dt>
								<dd className="truncate font-mono text-[13px]">
									<Link
										className="underline-offset-2 hover:underline"
										params={{ name: plan.functionName }}
										search={{}}
										to="/functions/$name"
										translate="no"
									>
										{plan.functionName}
									</Link>
								</dd>
							</div>
						) : null}
						{plan.planRunId ? (
							<div className="min-w-0">
								<dt className="text-muted-foreground text-xs">Plan run</dt>
								<dd className="truncate font-mono text-[13px]">
									<Link
										className="underline-offset-2 hover:underline"
										params={{ runId: plan.planRunId }}
										search={{}}
										to="/functions/runs/$runId"
										translate="no"
									>
										{plan.planRunId}
									</Link>
								</dd>
							</div>
						) : null}
						{plan.planDigest ? (
							<div className="min-w-0 sm:col-span-2">
								<dt className="text-muted-foreground text-xs">
									Plan digest, what the approval binds to
								</dt>
								<dd
									className="break-all font-mono text-[12px] text-muted-foreground"
									translate="no"
								>
									{plan.planDigest}
								</dd>
							</div>
						) : null}
					</dl>
				</>
			)}
		</section>
	);
}
