"use client";

import { Loader2, TextCursorInput } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	type ConditionDraft,
	useDraftCondition,
} from "@/hooks/api/use-approval-policies";

export function ConditionDraftPanel({
	workspaceId,
	environmentId,
	matchKind,
	matchActionName,
	onUse,
}: {
	workspaceId?: string;
	environmentId: string;
	matchKind: "any" | "action" | "custom";
	matchActionName: string | null;
	onUse: (condition: string) => void;
}) {
	const id = useId();
	const [request, setRequest] = useState("");
	const [draft, setDraft] = useState<ConditionDraft | null>(null);
	const [error, setError] = useState<string | null>(null);
	const drafting = useDraftCondition(workspaceId);
	const revision = useRef(0);

	const run = () => {
		if (drafting.isPending) return;
		const submittedRevision = ++revision.current;
		setDraft(null);
		setError(null);
		if (request.trim().length < 5) {
			setError("Describe the rule in a few words.");
			return;
		}
		drafting.mutate(
			{ environmentId, matchKind, matchActionName, request: request.trim() },
			{
				onSuccess: (result) => {
					if (revision.current === submittedRevision) setDraft(result);
				},
				onError: (e: Error) => {
					if (revision.current !== submittedRevision) return;
					setDraft(null);
					setError(e.message);
				},
			},
		);
	};

	return (
		<div className="space-y-2">
			<label className="font-medium text-sm" htmlFor={`${id}-request`}>
				Describe it
			</label>
			<div className="flex flex-wrap gap-2">
				<Input
					autoComplete="off"
					className="min-w-0 flex-1 basis-56"
					id={`${id}-request`}
					maxLength={500}
					name="conditionRequest"
					onChange={(e) => {
						revision.current++;
						setRequest(e.target.value);
						setDraft(null);
						setError(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							e.stopPropagation();
							run();
						}
					}}
					placeholder="For example: refunds over 500 dollars in USD"
					value={request}
				/>
				<Button
					disabled={drafting.isPending}
					onClick={run}
					size="sm"
					type="button"
					variant="outline"
				>
					{drafting.isPending ? (
						<Loader2
							aria-hidden="true"
							className="animate-spin motion-reduce:animate-none"
							data-icon="inline-start"
						/>
					) : (
						<TextCursorInput aria-hidden="true" data-icon="inline-start" />
					)}
					Draft condition
				</Button>
			</div>
			<p className="text-muted-foreground text-xs">
				Sends your sentence and this action's field names to an upstream AI
				provider. No call data is sent. Review the result before using it.
			</p>

			<div aria-live="polite" className="space-y-2">
				{error ? (
					<p className="text-destructive text-sm" role="alert">
						{error}
					</p>
				) : null}
				{draft ? <DraftResult draft={draft} onUse={onUse} /> : null}
			</div>
		</div>
	);
}

function DraftResult({
	draft,
	onUse,
}: {
	draft: ConditionDraft;
	onUse: (condition: string) => void;
}) {
	const usage = `${draft.usage.used} of ${draft.usage.limit} drafts used this month.`;
	if (!draft.condition) {
		return (
			<p className="text-sm">
				That can't be written as a condition on this call. Try naming the field
				and the value, for example "amount at least 500".{" "}
				<span className="text-muted-foreground text-xs">{usage}</span>
			</p>
		);
	}
	const invalid =
		draft.check && !draft.check.valid ? draft.check.message : null;
	return (
		<div className="space-y-2" data-testid="condition-draft">
			<pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-xs">
				{draft.condition}
			</pre>
			{invalid ? (
				<p className="text-destructive text-xs">
					This draft does not pass the check: {invalid}
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					onClick={() => onUse(draft.condition as string)}
					size="xs"
					type="button"
				>
					Use this condition
				</Button>
				<span className="text-muted-foreground text-xs">{usage}</span>
			</div>
		</div>
	);
}
