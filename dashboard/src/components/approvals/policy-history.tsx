"use client";

import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useActorNames } from "@/hooks/api/use-actor-names";
import {
	useApprovalPolicyVersion,
	useApprovalPolicyVersions,
} from "@/hooks/api/use-approval-policies";
import type { ActorLabel, ActorRef } from "@/lib/actor-label";
import { ApiError } from "@/lib/api-client";
import {
	locateVersion,
	OPERATION_LABEL,
	summarizeSnapshot,
} from "@/lib/policy-history";
import type { ApprovalPolicyEffect, ApprovalPolicyVersion } from "@/lib/types";
import { cn } from "@/lib/utils";

const EFFECT_LABEL: Record<ApprovalPolicyEffect, string> = {
	require_approval: "Require approval",
	auto_approve: "Auto-approve",
	auto_deny: "Auto-deny",
};

const OPERATION_VARIANT = {
	created: "success",
	updated: "info",
	deleted: "error",
	baseline: "secondary",
} as const;

export function PolicyHistory({
	workspaceId,
	policyId,
	highlightVersion,
}: {
	workspaceId?: string;
	policyId: string;
	highlightVersion?: number;
}) {
	const query = useApprovalPolicyVersions(workspaceId, policyId);
	const nameOf = useActorNames(workspaceId);
	const highlighted = useRef<HTMLLIElement>(null);
	const pages = query.data?.pages ?? [];
	const versions = pages.flatMap((page) => page.data);
	const earliestVersion = pages[0]?.pagination.earliestVersion;
	const location =
		highlightVersion === undefined || !pages.length
			? null
			: locateVersion(versions, earliestVersion, highlightVersion);
	const pinned = useApprovalPolicyVersion(
		workspaceId,
		policyId,
		location === "elsewhere" ? highlightVersion : undefined,
	);

	useEffect(() => {
		if (versions.length || pinned.data)
			highlighted.current?.scrollIntoView({ block: "nearest" });
	}, [versions.length, pinned.data]);

	if (query.isLoading) {
		return (
			<div className="space-y-2">
				<Skeleton className="h-16 w-full rounded-lg" />
				<Skeleton className="h-16 w-full rounded-lg" />
			</div>
		);
	}
	if (query.error) {
		const notFound =
			query.error instanceof ApiError && query.error.status === 404;
		return (
			<p
				className="text-muted-foreground text-sm"
				role={notFound ? undefined : "alert"}
			>
				{notFound
					? "No history is retained for this policy."
					: `History could not be loaded: ${query.error.message}`}
			</p>
		);
	}

	const pinnedMissing =
		location === "elsewhere" &&
		pinned.error instanceof ApiError &&
		pinned.error.status === 404;

	return (
		<div className="space-y-3">
			{location === "before_history" ? (
				<p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
					The decision used v{highlightVersion}, which predates retained
					history. Its exact rules were not recorded.
				</p>
			) : pinnedMissing ? (
				<p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
					v{highlightVersion} is not in this policy's retained history.
				</p>
			) : null}
			{location === "elsewhere" && pinned.data ? (
				<ol
					aria-label="Version used by the decision"
					className="overflow-hidden rounded-lg border"
				>
					<VersionEntry
						entry={pinned.data}
						highlighted
						nameOf={nameOf}
						ref={highlighted}
					/>
				</ol>
			) : null}
			<ol
				aria-label="Policy versions"
				className="divide-y overflow-hidden rounded-lg border"
			>
				{versions.map((entry) => (
					<VersionEntry
						entry={entry}
						nameOf={nameOf}
						highlighted={entry.version === highlightVersion}
						key={entry.version}
						ref={entry.version === highlightVersion ? highlighted : undefined}
					/>
				))}
			</ol>
			{query.hasNextPage ? (
				<Button
					disabled={query.isFetchingNextPage}
					onClick={() => query.fetchNextPage()}
					size="sm"
					type="button"
					variant="outline"
				>
					{query.isFetchingNextPage ? "Loading…" : "Show older versions"}
				</Button>
			) : null}
			<p className="text-muted-foreground text-xs">
				History starts when version tracking was enabled. Deleting a policy
				keeps its history, ending in a deletion record. Deleting the environment
				or the workspace removes it.
			</p>
		</div>
	);
}

function VersionEntry({
	entry,
	highlighted,
	nameOf,
	ref,
}: {
	entry: ApprovalPolicyVersion;
	highlighted: boolean;
	nameOf: (actor: ActorRef) => ActorLabel;
	ref?: React.Ref<HTMLLIElement>;
}) {
	const summary = summarizeSnapshot(entry.snapshot);
	return (
		<li
			aria-current={highlighted ? "true" : undefined}
			className={cn(
				"relative scroll-mt-4 p-3 text-sm",
				highlighted &&
					"bg-primary/[0.04] before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
			)}
			ref={ref}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium tabular-nums">v{entry.version}</span>
				<Badge variant={OPERATION_VARIANT[entry.operation]}>
					{OPERATION_LABEL[entry.operation]}
				</Badge>
				{highlighted ? (
					<Badge variant="outline">Used by this decision</Badge>
				) : null}
				<time
					className="ml-auto text-muted-foreground text-xs"
					dateTime={entry.createdAt}
				>
					{new Date(entry.createdAt).toLocaleString()}
				</time>
			</div>
			<p className="mt-1 text-muted-foreground text-xs">
				By{" "}
				<span title={nameOf(entry.actor).title}>
					{nameOf(entry.actor).text}
				</span>
			</p>
			{entry.changeNote ? (
				<p className="mt-1 italic">“{entry.changeNote}”</p>
			) : null}
			{entry.operation === "baseline" ? (
				<p className="mt-1 text-muted-foreground text-xs">
					Captured when history was enabled. Earlier versions were not recorded.
				</p>
			) : null}
			<p className="mt-2 break-words">
				{summary.effect ? EFFECT_LABEL[summary.effect] : "Unknown effect"} ·{" "}
				{summary.appliesTo}
				{summary.requiredApprovals !== null
					? ` · ${summary.requiredApprovals} approval${summary.requiredApprovals === 1 ? "" : "s"}`
					: ""}
				{summary.priority !== null ? ` · priority ${summary.priority}` : ""}
				{summary.enabled === false ? " · disabled" : ""}
			</p>
			<details className="mt-2">
				<summary className="cursor-pointer text-muted-foreground text-xs">
					Stored snapshot
				</summary>
				<div className="mt-2 space-y-2">
					<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-3 font-mono text-xs">
						{JSON.stringify(entry.snapshot, null, 2)}
					</pre>
					<p className="break-all font-mono text-[11px] text-muted-foreground">
						SHA-256 {entry.contentHash}
					</p>
				</div>
			</details>
		</li>
	);
}
