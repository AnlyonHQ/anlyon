"use client";

import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useConditionAssist } from "@/hooks/api/use-approval-policies";
import type { ConditionAssist } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ConditionDraftPanel } from "./condition-draft-panel";

const CHECK_DELAY_MS = 400;

function useDebounced<T>(value: T, delay: number): T {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return settled;
}

type Field = ConditionAssist["inputFields"][number];

export function conditionTemplates(fields: Field[]) {
	const numeric =
		fields.find((f) => f.type === "double")?.path ?? "input.amount";
	const text = fields.find((f) => f.type === "string")?.path ?? "input.env";
	const guard = (path: string) =>
		fields.find((f) => f.path === path)?.optional !== false
			? `has(${path}) && `
			: "";
	return [
		{ label: "Value at least", source: `${guard(numeric)}${numeric} >= 500` },
		{ label: "One of", source: `${guard(text)}${text} in ["prod", "staging"]` },
		{ label: "Only this agent", source: 'agent.id == "agt_…"' },
		{ label: "Field present", source: `has(${text})` },
	];
}

export function appendClause(current: string, clause: string): string {
	const trimmed = current.trim();
	return trimmed ? `(${trimmed}) && ${clause}` : clause;
}

export function PolicyConditionEditor({
	workspaceId,
	environmentId,
	matchKind,
	matchActionName,
	value,
	onChange,
}: {
	workspaceId?: string;
	environmentId: string;
	matchKind: "any" | "action" | "custom";
	matchActionName: string | null;
	value: string;
	onChange: (next: string) => void;
}) {
	const id = useId();
	const [sampleText, setSampleText] = useState("");
	const [fieldSearch, setFieldSearch] = useState("");
	const editor = useRef<HTMLTextAreaElement>(null);
	const [insertError, setInsertError] = useState<string | null>(null);
	const draft = useDebounced(value, CHECK_DELAY_MS);
	const sample = useDebounced(sampleText, CHECK_DELAY_MS);

	const parsedSample = useMemo(() => {
		if (!sample.trim()) return { value: undefined, problem: null };
		try {
			const parsed: unknown = JSON.parse(sample);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return {
					value: undefined,
					problem: 'Enter a JSON object, for example {"amount": 700}.',
				};
			}
			return { value: parsed as Record<string, unknown>, problem: null };
		} catch {
			return {
				value: undefined,
				problem: "The sample input is not valid JSON.",
			};
		}
	}, [sample]);

	const assist = useConditionAssist(
		workspaceId,
		environmentId
			? {
					environmentId,
					matchKind,
					matchActionName,
					condition: draft.trim() || null,
					...(parsedSample.value ? { sampleInput: parsedSample.value } : {}),
				}
			: null,
	);
	const result = assist.data;
	const settled = draft === value;
	const fields = result?.inputFields ?? [];
	const references = [
		...fields,
		...(result?.facts ?? [])
			.filter((fact) => fact.name !== "input")
			.map((fact) => ({
				path: fact.name,
				type: fact.type,
				optional: false,
				description: fact.description,
			})),
	];
	const visibleFields = references.filter((field) =>
		`${field.path} ${field.description ?? ""}`
			.toLowerCase()
			.includes(fieldSearch.toLowerCase()),
	);
	const sampleSettled = sampleText === sample && settled && !assist.isFetching;
	const changeExpression = (next: string) => {
		if (next.length > 2000) {
			setInsertError("This insertion would exceed the 2,000-character limit.");
			return;
		}
		setInsertError(null);
		onChange(next);
	};

	const insert = (text: string) => {
		const element = editor.current;
		const start = element?.selectionStart ?? value.length;
		const end = element?.selectionEnd ?? value.length;
		changeExpression(value.slice(0, start) + text + value.slice(end));
		requestAnimationFrame(() => {
			element?.focus();
			element?.setSelectionRange(start + text.length, start + text.length);
		});
	};

	return (
		<div className="min-w-0 space-y-3">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<label className="font-medium text-sm" htmlFor={id}>
					Condition (optional)
				</label>
				<a
					className="text-muted-foreground text-xs underline underline-offset-2"
					href="https://docs.anlyon.com/trust-control/policy-as-code#conditions"
					rel="noreferrer"
					target="_blank"
				>
					Condition syntax (CEL)
				</a>
			</div>
			<div
				className={cn(
					"overflow-hidden rounded-lg border bg-muted/20 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
					result?.check?.valid === false &&
						settled &&
						"border-destructive focus-within:border-destructive focus-within:ring-destructive/20",
				)}
			>
				<div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
					<span className="font-mono">WHEN · CEL expression</span>
					<span className="tabular-nums">
						{value.length.toLocaleString()} / 2,000
					</span>
				</div>
				<Textarea
					ref={editor}
					aria-describedby={`${id}-status`}
					aria-invalid={
						result?.check?.valid === false && settled ? true : undefined
					}
					autoComplete="off"
					className="min-h-40 resize-y rounded-none border-0 bg-transparent p-4 font-mono text-base leading-7 shadow-none focus-visible:ring-0 sm:text-sm"
					id={id}
					maxLength={2000}
					name="condition"
					onChange={(event) => changeExpression(event.target.value)}
					placeholder='input.amount >= 500 && input.currency == "USD"'
					spellCheck={false}
					value={value}
				/>
			</div>
			{insertError ? (
				<p role="alert" className="text-sm text-destructive">
					{insertError}
				</p>
			) : null}
			<ConditionStatus
				checking={!settled || assist.isFetching}
				error={assist.error}
				id={`${id}-status`}
				result={result}
				value={value}
			/>

			<details className="border-t pt-3" open>
				<summary className="cursor-pointer text-sm font-medium">
					Fields & context{" "}
					<span className="text-muted-foreground font-normal">
						· Insert at cursor
					</span>
				</summary>
				<div className="mt-3 space-y-2">
					<Input
						aria-label="Search available fields"
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								event.stopPropagation();
							}
						}}
						placeholder="Find a field or context value"
						value={fieldSearch}
						onChange={(event) => setFieldSearch(event.target.value)}
						className="h-9"
					/>
					<div className="grid max-h-44 overflow-y-auto overscroll-contain gap-1 sm:grid-cols-2">
						{visibleFields.map((field) => (
							<button
								key={field.path}
								type="button"
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => insert(field.path)}
								title={field.description ?? undefined}
								className="min-w-0 rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<div className="flex min-w-0 items-baseline justify-between gap-2">
									<span className="truncate font-mono text-xs">
										{field.path}
									</span>
									<span className="shrink-0 text-xs text-muted-foreground">
										{field.type}
										{field.optional ? " · optional" : ""}
									</span>
								</div>
								{field.description ? (
									<p className="truncate text-xs text-muted-foreground">
										{field.description}
									</p>
								) : null}
							</button>
						))}
					</div>
					{visibleFields.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							{fieldSearch
								? "No matching fields."
								: "Select an action to load its input fields."}
						</p>
					) : null}
					<p className="text-xs text-muted-foreground">
						Guard optional fields with <code>has(input.field)</code>. A missing
						value requires approval.
					</p>
				</div>
			</details>

			<div className="flex flex-wrap items-center gap-1.5">
				<span className="text-muted-foreground text-xs">Start from</span>
				{conditionTemplates(fields).map((template) => (
					<Button
						key={template.label}
						onClick={() =>
							changeExpression(appendClause(value, template.source))
						}
						size="xs"
						title={template.source}
						type="button"
						variant="ghost"
					>
						{template.label}
					</Button>
				))}
			</div>

			<details className="border-t pt-3">
				<summary className="cursor-pointer text-sm font-medium">
					Draft from a description
				</summary>
				<div className="mt-3">
					<ConditionDraftPanel
						environmentId={environmentId}
						matchActionName={matchActionName}
						matchKind={matchKind}
						onUse={changeExpression}
						workspaceId={workspaceId}
					/>
				</div>
			</details>
			<details className="border-t pt-3">
				<summary className="cursor-pointer text-sm">
					Try it on a sample input
				</summary>
				<div className="mt-2 space-y-2">
					<Textarea
						aria-describedby={`${id}-sample-result`}
						aria-label="Sample input (JSON)"
						className="font-mono"
						name="sampleInput"
						onChange={(event) => setSampleText(event.target.value)}
						placeholder='{"amount": 700, "currency": "USD"}'
						size="sm"
						spellCheck={false}
						value={sampleText}
					/>
					<p aria-live="polite" className="text-sm" id={`${id}-sample-result`}>
						{!sampleSettled && sampleText.trim()
							? "Checking the current expression and sample…"
							: assist.error
								? "Sample could not be checked. Try again when the connection is restored."
								: describeSample(
										value,
										sampleText,
										parsedSample.problem,
										result,
									)}
					</p>
					<p className="text-muted-foreground text-xs">
						The sample is checked by Anlyon; no action is executed. This checks
						the condition only; the policy's action and other restrictions also
						apply.
					</p>
				</div>
			</details>
		</div>
	);
}

function ConditionStatus({
	id,
	value,
	result,
	checking,
	error,
}: {
	id: string;
	value: string;
	result?: ConditionAssist;
	checking: boolean;
	error: Error | null;
}) {
	let body: React.ReactNode;
	if (!value.trim()) {
		body = (
			<span className="text-muted-foreground">
				No condition: the policy applies to every request it targets.
			</span>
		);
	} else if (checking) {
		body = (
			<span className="inline-flex items-center gap-1.5 text-muted-foreground">
				<Loader2
					aria-hidden="true"
					className="size-3.5 animate-spin motion-reduce:animate-none"
				/>
				Checking…
			</span>
		);
	} else if (error) {
		body = (
			<span className="text-destructive">
				Could not check the condition: {error.message}. Saving will still check
				it.
			</span>
		);
	} else if (result?.check?.valid) {
		body = (
			<span className="inline-flex items-center gap-1.5 text-success-foreground">
				<CheckCircle2 aria-hidden="true" className="size-3.5" />
				Valid condition.
			</span>
		);
	} else if (result?.check && !result.check.valid) {
		body = (
			<span className="flex items-start gap-1.5 text-destructive">
				<CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
				<pre className="overflow-x-auto whitespace-pre font-mono text-xs">
					{result.check.message}
				</pre>
			</span>
		);
	}
	return (
		<div aria-live="polite" className={cn("min-h-5 text-sm")} id={id}>
			{body}
		</div>
	);
}

export function describeSample(
	condition: string,
	sampleText: string,
	sampleProblem: string | null,
	result?: ConditionAssist,
): string {
	if (!condition.trim()) return "Write a condition to try it.";
	if (!sampleText.trim())
		return "Paste an input to see whether the condition holds.";
	if (sampleProblem) return sampleProblem;
	if (result?.check && !result.check.valid) return "Fix the condition first.";
	if (!result?.sample) return "Checking…";
	if ("error" in result.sample) {
		return `Would require approval: the condition could not be evaluated (${result.sample.error}).`;
	}
	return result.sample.result
		? "The condition holds: this policy would apply."
		: "The condition does not hold: this policy would not apply.";
}
