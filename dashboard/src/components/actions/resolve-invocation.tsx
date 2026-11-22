"use client";

import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useResolveInvocation } from "@/hooks/api/use-actions";

const MIN_EVIDENCE = 10;

export function ResolveInvocation({
	workspaceId,
	invocationId,
}: {
	workspaceId?: string;
	invocationId: string;
}) {
	const id = useId();
	const [outcome, setOutcome] = useState<"" | "succeeded" | "failed">("");
	const [evidence, setEvidence] = useState("");
	const [reference, setReference] = useState("");
	const [error, setError] = useState<string | null>(null);
	const resolve = useResolveInvocation(workspaceId);

	const problem = !outcome
		? "Choose what the destination shows."
		: evidence.trim().length < MIN_EVIDENCE
			? `Describe what you checked (at least ${MIN_EVIDENCE} characters).`
			: null;

	const submit = () => {
		setError(null);
		if (problem || !outcome) {
			setError(problem);
			return;
		}
		resolve.mutate(
			{
				invocationId,
				outcome,
				evidence: evidence.trim(),
				...(reference.trim() ? { externalReference: reference.trim() } : {}),
			},
			{ onError: (e: Error) => setError(e.message) },
		);
	};

	return (
		<section
			aria-labelledby={`${id}-title`}
			className="space-y-3 rounded-lg border border-warning/50 bg-warning/5 p-4"
		>
			<div className="space-y-1">
				<h3 className="font-medium text-sm" id={`${id}-title`}>
					Confirm what happened
				</h3>
				<p className="text-muted-foreground text-sm">
					This call may have reached the destination. Check there first, then
					record what you found. Nothing is sent again. Workspace admins only.
				</p>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor={`${id}-outcome`}>What does the destination show?</Label>
				<NativeSelect
					className="w-full"
					id={`${id}-outcome`}
					onChange={(e) => {
						setOutcome(e.target.value as typeof outcome);
						setError(null);
					}}
					value={outcome}
				>
					<NativeSelectOption value="">Choose…</NativeSelectOption>
					<NativeSelectOption value="failed">
						It did not happen: record as failed and release its usage
					</NativeSelectOption>
					<NativeSelectOption value="succeeded">
						It happened: record as succeeded
					</NativeSelectOption>
				</NativeSelect>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor={`${id}-evidence`}>What you checked</Label>
				<Textarea
					id={`${id}-evidence`}
					maxLength={2000}
					onChange={(e) => {
						setEvidence(e.target.value);
						setError(null);
					}}
					placeholder="For example: Stripe dashboard shows no charge for order 4417."
					value={evidence}
				/>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor={`${id}-reference`}>
					Reference at the destination (optional)
				</Label>
				<Input
					autoComplete="off"
					id={`${id}-reference`}
					maxLength={200}
					onChange={(e) => setReference(e.target.value)}
					placeholder="Charge, ticket or order id"
					value={reference}
				/>
			</div>
			<p className="text-muted-foreground text-xs">
				This cannot be edited or undone, and it shows who confirmed it. To run
				the action again afterwards, invoke it with a new idempotency key and
				retryOf.
			</p>
			{error ? (
				<p className="text-destructive text-sm" role="alert">
					{error}
				</p>
			) : null}
			<Button disabled={resolve.isPending} onClick={submit} size="sm">
				{resolve.isPending ? (
					<Loader2
						aria-hidden="true"
						className="animate-spin motion-reduce:animate-none"
						data-icon="inline-start"
					/>
				) : null}
				Record outcome
			</Button>
		</section>
	);
}
