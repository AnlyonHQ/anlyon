"use client";

import { Lightbulb } from "lucide-react";
import { useId, useState } from "react";
import { FeatureStageBadge } from "@/components/feature-stage-badge";
import { ListFrame } from "@/components/layout/page";
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
import {
	useAcceptPolicySuggestion,
	usePolicySuggestions,
} from "@/hooks/api/use-assistant";
import type { PolicySuggestion } from "@/lib/types";

export function PolicySuggestions({ workspaceId }: { workspaceId?: string }) {
	const query = usePolicySuggestions(workspaceId);
	const accept = useAcceptPolicySuggestion(workspaceId);
	const [reviewing, setReviewing] = useState<PolicySuggestion | null>(null);
	const titleId = useId();
	const suggestions = query.data ?? [];
	if (suggestions.length === 0) return null;

	return (
		<section aria-labelledby={titleId} className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<Lightbulb
					aria-hidden="true"
					className="size-4 text-muted-foreground"
				/>
				<h3 className="font-semibold text-[15px] tracking-tight" id={titleId}>
					Suggested policies
				</h3>
				<FeatureStageBadge feature="ai-assistant" />
			</div>
			<ListFrame>
				<ul className="divide-y">
					{suggestions.map((s) => (
						<li
							className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3"
							key={s.key}
						>
							<div className="min-w-0 flex-1 basis-72">
								<p className="font-medium text-sm">
									Auto-approve{" "}
									<span className="font-mono" translate="no">
										{s.actionName}
									</span>
									{s.agentId ? (
										<>
											{" "}
											by{" "}
											<span className="font-mono" translate="no">
												{s.agentId}
											</span>
										</>
									) : null}
									{s.maxAmount !== null
										? ` up to ${s.maxAmount.toLocaleString()}`
										: ""}
								</p>
								<p className="mt-0.5 text-muted-foreground text-xs tabular-nums">
									{s.approved} approved by approvers, none denied, in 30 days.
									Would have auto-approved {s.preview.wouldAutoApprove} of them;{" "}
									{s.preview.wouldStillReview} would still wait for an approver.
								</p>
							</div>
							<Button
								onClick={() => setReviewing(s)}
								size="sm"
								variant="outline"
							>
								Review & create…
							</Button>
						</li>
					))}
				</ul>
			</ListFrame>

			<AlertDialog
				onOpenChange={(open) => !open && setReviewing(null)}
				open={reviewing !== null}
			>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>Create these policies?</AlertDialogTitle>
						<AlertDialogDescription render={<div />}>
							<ul className="list-disc space-y-1 pl-5">
								{reviewing?.policies.map((p) => (
									<li key={p.name}>
										<span className="font-medium">{p.name}</span> (priority{" "}
										{p.priority},{" "}
										{p.effect === "auto_approve"
											? "auto-approve"
											: "require approval"}
										)
									</li>
								))}
							</ul>
							<p className="mt-2">
								They are ordinary policies: you can edit or delete them like any
								other.
							</p>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<AlertDialogClose
							onClick={() => {
								if (reviewing) accept.mutate(reviewing.key);
								setReviewing(null);
							}}
							render={<Button loading={accept.isPending} />}
						>
							Create policies
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</section>
	);
}
