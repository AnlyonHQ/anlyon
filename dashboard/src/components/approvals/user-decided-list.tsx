"use client";

import { useEffect, useRef, useState } from "react";
import { ListMessage, ListSkeleton } from "@/components/activity/list-parts";
import { ListFrame } from "@/components/layout/page";
import { ActingFor } from "@/components/shared/acting-for";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useApprovals } from "@/hooks/api/use-approvals";
import { formatTimeLeft, msLeft, summarizePayload } from "@/lib/approvals";
import { functionPlanPayload } from "@/lib/functions";

const PAGE_SIZE = 50;

export function UserDecidedApprovals({
	workspaceId,
	endUserId,
	highlightId,
}: {
	workspaceId?: string;
	endUserId?: string;
	highlightId?: string;
}) {
	const [limit, setLimit] = useState(PAGE_SIZE);
	const query = useApprovals(workspaceId, {
		status: "pending",
		decider: "end_user",
		endUserId,
		limit,
	});
	const rows = query.data?.data ?? [];
	const pagination = query.data?.pagination;
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!highlightId || !rows.some((row) => row.id === highlightId)) return;
		listRef.current
			?.querySelector<HTMLElement>(`[data-approval-id="${highlightId}"]`)
			?.scrollIntoView({ block: "center" });
	}, [highlightId, rows]);

	return (
		<div ref={listRef}>
			<ListFrame
				footer={
					rows.length > 0 ? (
						<>
							<span className="tabular-nums">
								{pagination
									? `${rows.length} of ${pagination.total}`
									: rows.length}{" "}
								waiting
							</span>
							{pagination?.hasMore ? (
								<Button
									disabled={query.isFetching}
									onClick={() => setLimit((current) => current + PAGE_SIZE)}
									size="xs"
									variant="outline"
								>
									Load more
								</Button>
							) : null}
						</>
					) : null
				}
			>
				{query.isLoading ? (
					<ListSkeleton rows={3} />
				) : query.isError ? (
					<ListMessage
						title="These approvals could not be loaded."
						tone="error"
					>
						{(query.error as Error | null)?.message}
					</ListMessage>
				) : rows.length === 0 ? (
					<ListMessage
						title={
							endUserId
								? "Nothing is waiting on this user."
								: "Nothing is waiting on your users."
						}
					>
						A policy decided by the user holds a call here until they answer in
						your app.
					</ListMessage>
				) : (
					<Table
						aria-busy={query.isFetching || undefined}
						className="text-[13px]"
					>
						<TableHeader>
							<TableRow>
								<TableHead>Request</TableHead>
								<TableHead className="w-40">For</TableHead>
								<TableHead className="hidden w-32 sm:table-cell">
									Requested
								</TableHead>
								<TableHead className="w-28 text-right">Time left</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((approval) => {
								const plan = functionPlanPayload(approval);
								const { target, method } = summarizePayload(approval);
								const subtitle = plan
									? `Function plan · ${plan.writes.length} ${plan.writes.length === 1 ? "write" : "writes"}`
									: [target, method].filter(Boolean).join(" · ");
								return (
									<TableRow
										data-approval-id={approval.id}
										data-state={
											approval.id === highlightId ? "selected" : undefined
										}
										key={approval.id}
									>
										<TableCell className="max-w-0 py-2">
											<p className="truncate font-medium">{approval.title}</p>
											{subtitle ? (
												<p
													className="truncate font-mono text-muted-foreground text-xs"
													translate="no"
												>
													{subtitle}
												</p>
											) : null}
										</TableCell>
										<TableCell className="max-w-0 py-2">
											<ActingFor endUserId={approval.endUserId} />
										</TableCell>
										<TableCell className="hidden py-2 text-muted-foreground sm:table-cell">
											<RelativeTime value={approval.createdAt} />
										</TableCell>
										<TableCell className="py-2 text-right text-muted-foreground tabular-nums">
											{formatTimeLeft(msLeft(approval))}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				)}
			</ListFrame>
		</div>
	);
}
