"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import {
	FunctionRunDetail,
	RunStatus,
} from "@/components/functions/run-detail";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/ui/empty";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/contexts/workspace-context";
import { useFunctionRun, useStartFunctionRun } from "@/hooks/api/use-functions";
import { useCan } from "@/hooks/api/use-permissions";
import { RUN_MODE_LABEL } from "@/lib/functions";

export const Route = createFileRoute("/_protected/functions/runs/$runId")({
	component: RunRoute,
});

function RunRoute() {
	const { runId } = Route.useParams();
	const navigate = Route.useNavigate();
	return (
		<FunctionRunPage
			onApplied={(applyRunId) =>
				navigate({
					to: "/functions/runs/$runId",
					params: { runId: applyRunId },
				})
			}
			runId={runId}
		/>
	);
}

export function FunctionRunPage({
	runId,
	onApplied,
}: {
	runId: string;
	onApplied: (applyRunId: string) => void;
}) {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const query = useFunctionRun(workspaceId, runId);
	const canInvoke = useCan(workspaceId)("actions.invoke");
	const start = useStartFunctionRun(workspaceId);
	const run = query.data;

	if (query.isLoading) {
		return (
			<div className="space-y-3" aria-busy="true">
				<Skeleton className="h-8 w-72" />
				<Skeleton className="h-40 w-full rounded-lg" />
			</div>
		);
	}
	if (!run) {
		return (
			<Empty className="py-16">
				<EmptyHeader>
					<EmptyTitle>No run with this id</EmptyTitle>
					<EmptyDescription>
						{query.error
							? (query.error as Error).message
							: "Check the id, then open it again from Functions."}
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button render={<Link to="/functions" />} size="sm" variant="outline">
						View functions
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<Page>
			<PageHeader
				description={
					<>
						{RUN_MODE_LABEL[run.mode]} run of{" "}
						<Link
							className="font-mono text-foreground underline-offset-4 hover:underline"
							params={{ name: run.functionName }}
							search={{ tab: "runs" }}
							to="/functions/$name"
						>
							{run.functionName}
						</Link>
						, started <RelativeTime value={run.createdAt} />
						{run.endUserId ? ` for ${run.endUserId}` : ""}.
					</>
				}
				eyebrow="Function run"
				meta={<RunStatus status={run.status} />}
				mono
				title={<span translate="no">{run.id}</span>}
			/>
			<FunctionRunDetail
				applying={start.isPending}
				canInvoke={canInvoke}
				onApply={() =>
					start.mutate(
						{ name: run.functionName, mode: "apply", planRunId: run.id },
						{ onSuccess: (applied) => onApplied(applied.id) },
					)
				}
				run={run}
			/>
		</Page>
	);
}
