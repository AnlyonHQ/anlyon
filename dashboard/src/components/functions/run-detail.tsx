import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { DetailCode, StatusDot } from "@/components/actions/detail-sheet";
import {
	PageCard,
	PageCardBody,
	PageCardHeader,
} from "@/components/actions/page-card";
import { ActingFor } from "@/components/shared/acting-for";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import {
	applyState,
	BUDGET_LABEL,
	CALL_STATE_LABEL,
	RUN_MODE_LABEL,
	RUN_STATUS_DOT,
	RUN_STATUS_LABEL,
	runStatusNote,
} from "@/lib/functions";
import type { FunctionRun, FunctionRunCall } from "@/lib/types";

const APPROVAL_STATUS_LABEL = {
	pending: "Pending",
	approved: "Approved",
	denied: "Denied",
	expired: "Expired",
} as const;

const DECIDER_LABEL = {
	team: "Your team",
	end_user: "The end user",
} as const;

const json = (value: unknown) => JSON.stringify(value ?? null, null, 2);

export function RunStatus({ status }: { status: FunctionRun["status"] }) {
	return (
		<span className="inline-flex items-center gap-2">
			<StatusDot className={RUN_STATUS_DOT[status]} />
			{RUN_STATUS_LABEL[status]}
		</span>
	);
}

export function FunctionRunDetail({
	run,
	canInvoke,
	onApply,
	applying = false,
}: {
	run: FunctionRun;
	canInvoke: boolean;
	onApply?: () => void;
	applying?: boolean;
}) {
	const apply = applyState(run);
	const bad =
		run.status === "failed" ||
		run.status === "budget_exceeded" ||
		run.status === "diverged";

	return (
		<div className="space-y-6">
			<PageCard>
				<PageCardHeader
					titleAs="h3"
					description={runStatusNote(run)}
					title={
						<span className="inline-flex flex-wrap items-center gap-3">
							<RunStatus status={run.status} />
							<Badge variant="outline">{RUN_MODE_LABEL[run.mode]}</Badge>
						</span>
					}
				/>
				<PageCardBody>
					<dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
						<Field label="Function">
							<Link
								className="font-mono text-[13px] underline-offset-4 hover:underline"
								params={{ name: run.functionName }}
								to="/functions/$name"
							>
								{run.functionName}
							</Link>
						</Field>
						<Field label="Started">
							<RelativeTime value={run.createdAt} />
						</Field>
						<Field label="Action calls">
							<span className="tabular-nums">{run.actionCalls}</span>
						</Field>
						<Field label="Duration">
							{run.durationMs !== null ? (
								<span className="tabular-nums">{run.durationMs} ms</span>
							) : (
								"—"
							)}
						</Field>
						<Field label="For">
							<ActingFor className="text-[13px]" endUserId={run.endUserId} />
						</Field>
						{run.planRunId ? (
							<Field label="Plan run">
								<Link
									className="font-mono text-[13px] underline-offset-4 hover:underline"
									params={{ runId: run.planRunId }}
									to="/functions/runs/$runId"
								>
									{run.planRunId}
								</Link>
							</Field>
						) : null}
					</dl>
					{bad ? (
						<Alert className="mt-4" variant="error">
							<AlertTitle>{RUN_STATUS_LABEL[run.status]}</AlertTitle>
							<AlertDescription>
								{run.status === "diverged"
									? "No write after the one that did not match was sent. Look at the calls below for the one refused with RUN_DIVERGED."
									: run.status === "budget_exceeded" && run.budget
										? `${BUDGET_LABEL[run.budget]} ran out.`
										: run.error
											? `${run.error.code}: ${run.error.message}`
											: "The run did not finish."}
							</AlertDescription>
						</Alert>
					) : null}
				</PageCardBody>
			</PageCard>

			{run.plan ? (
				<PageCard>
					<PageCardHeader
						titleAs="h3"
						actions={
							canInvoke && apply.canApply && onApply ? (
								<Button loading={applying} onClick={onApply} size="sm">
									Apply plan
								</Button>
							) : undefined
						}
						description="The writes this run recorded, in the order an apply run must make them. Approving lets one run of this version, with this input, make exactly these writes."
						title="Plan"
					/>
					<PageCardBody className="space-y-4">
						{run.plan.writes.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								No writes. There is nothing to approve or apply.
							</p>
						) : (
							<ol aria-label="Planned writes" className="space-y-3">
								{run.plan.writes.map((write, index) => (
									<li className="space-y-1.5" key={write.sequence}>
										<div className="flex items-center gap-2 text-sm">
											<span className="text-muted-foreground tabular-nums">
												{index + 1}.
											</span>
											<span className="font-medium font-mono text-[13px]">
												{write.action}
											</span>
											<span className="text-muted-foreground text-xs tabular-nums">
												call {write.sequence}
											</span>
										</div>
										<DetailCode>{json(write.input)}</DetailCode>
									</li>
								))}
							</ol>
						)}
						{run.plan.approval ? (
							<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4 text-sm">
								<span>
									Approval:{" "}
									<span className="font-medium">
										{APPROVAL_STATUS_LABEL[run.plan.approval.status]}
									</span>
								</span>
								<span className="text-muted-foreground">
									Decided by {DECIDER_LABEL[run.plan.approval.decider]}
								</span>
								<Link
									className="font-mono text-[13px] underline-offset-4 hover:underline"
									search={{ id: run.plan.approval.id }}
									to="/approvals"
								>
									Open the approval
								</Link>
							</div>
						) : null}
						{run.plan.appliedByRunId ? (
							<p className="text-sm">
								Applied by{" "}
								<Link
									className="font-mono text-[13px] underline-offset-4 hover:underline"
									params={{ runId: run.plan.appliedByRunId }}
									to="/functions/runs/$runId"
								>
									{run.plan.appliedByRunId}
								</Link>
								.
							</p>
						) : !apply.canApply && apply.reason ? (
							<p className="text-muted-foreground text-sm">{apply.reason}</p>
						) : apply.canApply && !canInvoke ? (
							<p className="text-muted-foreground text-sm">
								The plan is approved. Applying it needs permission to invoke
								actions.
							</p>
						) : null}
						<p className="truncate font-mono text-muted-foreground text-xs">
							Plan digest {run.plan.digest}
						</p>
					</PageCardBody>
				</PageCard>
			) : null}

			<PageCard>
				<PageCardHeader
					titleAs="h3"
					description="Every call the run made through the anlyon binding, in order. A dispatched call is an invocation with its own receipt."
					title="Calls"
				/>
				{run.calls.length === 0 ? (
					<PageCardBody>
						<p className="text-muted-foreground text-sm">
							The run made no action calls.
						</p>
					</PageCardBody>
				) : (
					<PageCardBody flush>
						<CallsTable calls={run.calls} />
					</PageCardBody>
				)}
			</PageCard>

			{run.output !== null && run.output !== undefined ? (
				<PageCard>
					<PageCardHeader
						titleAs="h3"
						description="What the function returned."
						title="Output"
					/>
					<PageCardBody>
						<DetailCode>{json(run.output)}</DetailCode>
					</PageCardBody>
				</PageCard>
			) : null}

			{run.logs.length > 0 ? (
				<PageCard>
					<PageCardHeader
						titleAs="h3"
						description="Lines the function wrote with anlyon.log."
						title="Logs"
					/>
					<PageCardBody>
						<DetailCode>{run.logs.join("\n")}</DetailCode>
					</PageCardBody>
				</PageCard>
			) : null}

			<PageCard>
				<PageCardHeader
					titleAs="h3"
					description="The record of this run: the version and input it ran with, the plan and approval it was bound to, its calls and how it ended."
					title="Receipt"
				/>
				<PageCardBody>
					{run.receipt ? (
						<div className="space-y-4">
							<dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
								<Field label="Outcome">
									<RunStatus status={run.receipt.outcome} />
								</Field>
								<Field label="Finished">
									<RelativeTime value={run.receipt.finishedAt} />
								</Field>
								<Field label="Version">
									<span className="font-mono text-[13px]">
										{run.receipt.functionVersionId}
									</span>
								</Field>
								<Field label="Source digest">
									<span className="block truncate font-mono text-[13px]">
										{run.receipt.digest}
									</span>
								</Field>
								{run.receipt.approvalId ? (
									<Field label="Approval">
										<Link
											className="font-mono text-[13px] underline-offset-4 hover:underline"
											search={{ id: run.receipt.approvalId }}
											to="/approvals"
										>
											{run.receipt.approvalId}
										</Link>
									</Field>
								) : null}
								{run.receipt.budget ? (
									<Field label="Budget that ended it">
										{BUDGET_LABEL[run.receipt.budget]}
									</Field>
								) : null}
							</dl>
							<details>
								<summary className="cursor-pointer text-muted-foreground text-xs">
									Raw receipt
								</summary>
								<div className="mt-2">
									<DetailCode>{json(run.receipt)}</DetailCode>
								</div>
							</details>
						</div>
					) : (
						<p className="text-muted-foreground text-sm">
							The receipt is written when the run ends.
						</p>
					)}
				</PageCardBody>
			</PageCard>
		</div>
	);
}

function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="min-w-0 space-y-1">
			<dt className="font-medium text-muted-foreground text-xs">{label}</dt>
			<dd className="min-w-0">{children}</dd>
		</div>
	);
}

export function CallsTable({ calls }: { calls: FunctionRunCall[] }) {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead className="w-12">#</TableHead>
					<TableHead>Action</TableHead>
					<TableHead className="w-20">Kind</TableHead>
					<TableHead className="w-28">State</TableHead>
					<TableHead className="hidden md:table-cell">Refusal</TableHead>
					<TableHead className="hidden lg:table-cell">Invocation</TableHead>
					<TableHead className="hidden w-24 sm:table-cell">
						Planned as
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{calls.map((call) => (
					<TableRow key={call.sequence}>
						<TableCell className="py-3 tabular-nums">{call.sequence}</TableCell>
						<TableCell className="max-w-0 py-3">
							<span className="block truncate font-mono text-[13px]">
								{call.action}
							</span>
						</TableCell>
						<TableCell className="py-3">
							{call.kind === "write" ? "Write" : "Read"}
						</TableCell>
						<TableCell className="py-3">
							<Badge
								variant={
									call.state === "refused" || call.state === "failed"
										? "error"
										: call.state === "intent"
											? "outline"
											: "success"
								}
							>
								{CALL_STATE_LABEL[call.state]}
							</Badge>
						</TableCell>
						<TableCell className="hidden py-3 font-mono text-xs md:table-cell">
							{call.refusal ?? "—"}
						</TableCell>
						<TableCell className="hidden max-w-0 py-3 lg:table-cell">
							{call.invocationId ? (
								<Link
									className="block truncate font-mono text-xs underline-offset-4 hover:underline"
									search={{
										invocation: call.invocationId,
										status: undefined,
									}}
									to="/actions/invocations"
								>
									{call.invocationId}
								</Link>
							) : (
								"—"
							)}
						</TableCell>
						<TableCell className="hidden py-3 tabular-nums sm:table-cell">
							{call.plannedSequence ?? "—"}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
