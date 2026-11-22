"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, RotateCw, Search } from "lucide-react";
import { useCallback } from "react";
import {
	DetailCode,
	DetailField,
	DetailSheet,
	StatusDot,
} from "@/components/actions/detail-sheet";
import { ResolveInvocation } from "@/components/actions/resolve-invocation";
import {
	ListMessage,
	ListSkeleton,
	Pager,
	RowStepper,
	useRowKeys,
} from "@/components/activity/list-parts";
import { EnvironmentSelect } from "@/components/effects/environment-select";
import { EndUserFilter } from "@/components/end-users/end-user-filter";
import {
	ListFrame,
	Page,
	PageHeader,
	PageToolbar,
} from "@/components/layout/page";
import {
	ActingFor,
	type ActingForFilter,
	ActingForSwitch,
	parseActingFor,
} from "@/components/shared/acting-for";
import { Button } from "@/components/ui/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { RelativeTime } from "@/components/ui/relative-time";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useWorkspace } from "@/contexts/workspace-context";
import { useInvocation, useInvocations } from "@/hooks/api/use-actions";
import { useCan } from "@/hooks/api/use-permissions";
import type { Invocation, InvocationStatus } from "@/lib/types";

const STATUSES: InvocationStatus[] = [
	"succeeded",
	"failed",
	"denied",
	"pending_approval",
	"running",
	"expired",
	"unknown",
];

type InvocationsSearch = {
	invocation: string | undefined;
	status: InvocationStatus | undefined;
	endUser?: string;
	actingFor?: ActingForFilter;
	action?: string;
	environmentId?: string;
	offset?: number;
};

export const Route = createFileRoute("/_protected/actions/invocations")({
	validateSearch: (search: Record<string, unknown>): InvocationsSearch => ({
		invocation:
			typeof search.invocation === "string" ? search.invocation : undefined,
		status: STATUSES.includes(search.status as InvocationStatus)
			? (search.status as InvocationStatus)
			: undefined,
		endUser:
			typeof search.endUser === "string" && search.endUser
				? search.endUser
				: undefined,
		actingFor: parseActingFor(search.actingFor),
		action:
			typeof search.action === "string" && search.action
				? search.action
				: undefined,
		environmentId:
			typeof search.environmentId === "string" && search.environmentId
				? search.environmentId
				: undefined,
		offset:
			typeof search.offset === "number" && search.offset > 0
				? Math.floor(search.offset)
				: undefined,
	}),
	component: InvocationsPage,
});

const PAGE_SIZE = 50;

const STATUS_DOT: Record<InvocationStatus, string> = {
	succeeded: "bg-success",
	failed: "bg-destructive",
	denied: "bg-destructive",
	unknown: "bg-warning",
	pending_approval: "bg-warning",
	running: "bg-info",
	expired: "bg-muted-foreground/60",
};

const STATUS_LABEL: Record<InvocationStatus, string> = {
	succeeded: "Succeeded",
	failed: "Failed",
	denied: "Denied",
	unknown: "Unknown",
	pending_approval: "Pending approval",
	running: "Running",
	expired: "Expired",
};

const ANY_STATUS = "any";
const STATUS_ITEMS = [
	{ value: ANY_STATUS, label: "Any status" },
	...STATUSES.map((status) => ({
		value: status,
		label: status === "unknown" ? "Needs confirmation" : STATUS_LABEL[status],
	})),
];

function duration(ms: number | null | undefined): string {
	if (ms == null) return "—";
	return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function InvocationsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const canResolve = useCan(workspaceId)("actions.resolve");
	const navigate = Route.useNavigate();
	const {
		invocation: selectedId,
		status,
		endUser,
		actingFor,
		action,
		environmentId,
		offset = 0,
	} = Route.useSearch();

	const invocationsQuery = useInvocations(workspaceId, {
		limit: PAGE_SIZE,
		status,
		endUserId: endUser,
		actingFor,
		action,
		environmentId,
		offset: offset || undefined,
	});
	const invocations = invocationsQuery.data?.data ?? [];
	const pagination = invocationsQuery.data?.pagination;
	const detail = useInvocation(workspaceId, selectedId);
	const selected =
		detail.data ??
		invocations.find((invocation) => invocation.id === selectedId);
	const filtered = Boolean(status || action || endUser || actingFor);

	const filter = (patch: Partial<InvocationsSearch>) =>
		navigate({
			to: "/actions/invocations",
			search: (previous) => ({
				...previous,
				invocation: undefined,
				offset: undefined,
				...patch,
			}),
		});
	const showQueue = (queue: boolean) =>
		filter({ status: queue ? "unknown" : undefined });
	const filterEndUser = (endUserId: string | undefined) =>
		filter({ endUser: endUserId });

	const select = useCallback(
		(id: string | undefined) =>
			navigate({
				to: "/actions/invocations",
				search: (previous) => ({ ...previous, invocation: id }),
			}),
		[navigate],
	);
	const stepper = useRowKeys({
		rows: invocations,
		selectedId,
		onSelect: select,
	});

	return (
		<Page>
			<PageHeader
				actions={
					<>
						<EnvironmentSelect
							onChange={(next) => filter({ environmentId: next })}
							value={environmentId}
							workspaceId={workspaceId}
						/>
						<Button
							aria-label="Refresh invocations"
							loading={invocationsQuery.isFetching}
							onClick={() => invocationsQuery.refetch?.()}
							size="icon-sm"
							variant="outline"
						>
							<RotateCw />
						</Button>
					</>
				}
				description="Calls your agents made through actions, newest at the top, with what each app replied. Secret values are redacted."
				title="Invocations"
			/>

			<div className="flex flex-col gap-3">
				<PageToolbar>
					<ActingForSwitch
						onChange={(next) => filter({ actingFor: next })}
						value={actingFor}
					/>
					<InputGroup className="w-full sm:w-60">
						<InputGroupAddon>
							<Search aria-hidden="true" />
						</InputGroupAddon>
						<InputGroupInput
							aria-label="Action"
							className="font-mono"
							defaultValue={action ?? ""}
							key={action ?? ""}
							onBlur={(e) => {
								const value = e.currentTarget.value.trim() || undefined;
								if (value !== action) filter({ action: value });
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter")
									filter({ action: e.currentTarget.value.trim() || undefined });
							}}
							placeholder="Action name"
							spellCheck={false}
							type="search"
						/>
					</InputGroup>
					<Select
						items={STATUS_ITEMS}
						onValueChange={(value) =>
							filter({
								status: STATUSES.includes(value as InvocationStatus)
									? (value as InvocationStatus)
									: undefined,
							})
						}
						value={status ?? ANY_STATUS}
					>
						<SelectTrigger aria-label="Status" className="w-48">
							<SelectValue />
						</SelectTrigger>
						<SelectPopup>
							{STATUS_ITEMS.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectPopup>
					</Select>
					<EndUserFilter onChange={filterEndUser} value={endUser} />
				</PageToolbar>
				{status === "unknown" ? (
					<p className="text-muted-foreground text-sm">
						<span className="font-medium text-foreground">
							Needs confirmation.
						</span>{" "}
						Calls that might have reached their destination, where Anlyon could
						not confirm the result. Each stays unknown until a read-back or an
						operator settles it.
					</p>
				) : null}
			</div>

			<ListFrame
				footer={
					invocations.length > 0 ? (
						<>
							<Pager
								hasMore={pagination?.hasMore ?? false}
								noun={["invocation", "invocations"]}
								offset={offset}
								onPage={(next) =>
									navigate({
										to: "/actions/invocations",
										search: (previous) => ({
											...previous,
											invocation: undefined,
											offset: next,
										}),
									})
								}
								pageSize={PAGE_SIZE}
								shown={invocations.length}
								total={pagination?.total}
							/>
							<Link
								className="inline-flex items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								search={{
									effect: undefined,
									environmentId,
									action: undefined,
									outcome: undefined,
									grade: undefined,
									unresolved: undefined,
									offset: undefined,
									endUser,
									actingFor,
								}}
								to="/actions/effects"
							>
								View receipts
								<ArrowUpRight aria-hidden="true" className="size-3" />
							</Link>
						</>
					) : null
				}
			>
				{invocationsQuery.isLoading ? (
					<ListSkeleton />
				) : invocationsQuery.isError ? (
					<ListMessage
						action={
							filtered ? (
								<Button
									onClick={() =>
										filter({
											status: undefined,
											action: undefined,
											endUser: undefined,
											actingFor: undefined,
										})
									}
									size="sm"
									variant="outline"
								>
									Clear filters
								</Button>
							) : null
						}
						title="Invocations could not be loaded."
						tone="error"
					>
						{(invocationsQuery.error as Error | null)?.message}
					</ListMessage>
				) : invocations.length === 0 && status === "unknown" ? (
					<ListMessage
						action={
							<Button
								onClick={() => showQueue(false)}
								size="sm"
								variant="outline"
							>
								Show all invocations
							</Button>
						}
						title="Nothing needs confirmation"
					/>
				) : invocations.length === 0 && endUser ? (
					<ListMessage
						action={
							<Button
								onClick={() => filterEndUser(undefined)}
								size="sm"
								variant="outline"
							>
								Show every user
							</Button>
						}
						title="No invocations for this user"
					>
						Anlyon has no calls made for{" "}
						<span className="font-mono" translate="no">
							{endUser}
						</span>{" "}
						in this environment.
					</ListMessage>
				) : invocations.length === 0 && filtered ? (
					<ListMessage
						action={
							<Button
								onClick={() =>
									filter({
										status: undefined,
										action: undefined,
										actingFor: undefined,
									})
								}
								size="sm"
								variant="outline"
							>
								Clear filters
							</Button>
						}
						title="No invocations match these filters."
					/>
				) : invocations.length === 0 ? (
					<ListMessage
						action={
							<Button
								render={<Link search={{ action: undefined }} to="/actions" />}
								size="sm"
							>
								Go to Actions
							</Button>
						}
						title="No invocations yet."
					>
						Your agent's calls appear here once it calls an action with an API
						key.
					</ListMessage>
				) : (
					<Table
						aria-busy={invocationsQuery.isFetching || undefined}
						className="text-[13px]"
					>
						<TableHeader>
							<TableRow>
								<TableHead className="w-40">Status</TableHead>
								<TableHead>Action</TableHead>
								<TableHead className="w-36">For</TableHead>
								<TableHead className="hidden w-20 text-right sm:table-cell">
									HTTP
								</TableHead>
								<TableHead className="hidden w-24 text-right sm:table-cell">
									Duration
								</TableHead>
								<TableHead className="hidden w-36 text-right md:table-cell">
									When
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{invocations.map((invocation: Invocation) => (
								<TableRow
									className="cursor-pointer"
									data-state={
										selectedId === invocation.id ? "selected" : undefined
									}
									key={invocation.id}
									onClick={() => select(invocation.id)}
								>
									<TableCell className="py-2">
										<span className="inline-flex items-center gap-2">
											<StatusDot className={STATUS_DOT[invocation.status]} />
											{STATUS_LABEL[invocation.status] ?? invocation.status}
										</span>
									</TableCell>
									<TableCell className="max-w-0 py-2">
										<button
											aria-label={`View invocation of ${invocation.actionName}`}
											className="block max-w-full truncate rounded-sm text-left font-medium font-mono text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
											onClick={(event) => {
												event.stopPropagation();
												select(invocation.id);
											}}
											translate="no"
											type="button"
										>
											{invocation.actionName}
										</button>
									</TableCell>
									<TableCell className="max-w-0 py-2">
										<ActingFor
											endUserId={invocation.endUserId}
											environmentId={environmentId}
										/>
									</TableCell>
									<TableCell className="hidden py-2 text-right font-mono text-[12.5px] text-muted-foreground tabular-nums sm:table-cell">
										{invocation.responseStatus ?? "—"}
									</TableCell>
									<TableCell className="hidden py-2 text-right text-muted-foreground tabular-nums sm:table-cell">
										{duration(invocation.durationMs)}
									</TableCell>
									<TableCell className="hidden py-2 text-right text-muted-foreground tabular-nums md:table-cell">
										<RelativeTime value={invocation.createdAt} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</ListFrame>

			<DetailSheet
				description={selectedId}
				onClose={() => select(undefined)}
				open={selectedId !== undefined}
				title={selected?.actionName ?? "Invocation"}
			>
				<RowStepper
					onNewer={
						stepper.newer
							? () => select(stepper.newer?.id as string)
							: undefined
					}
					onOlder={
						stepper.older
							? () => select(stepper.older?.id as string)
							: undefined
					}
					position={stepper.position}
				/>
				{selected ? (
					<>
						<div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b pb-5 sm:grid-cols-3">
							<DetailField label="Status">
								<span className="inline-flex items-center gap-2">
									<StatusDot className={STATUS_DOT[selected.status]} />
									{STATUS_LABEL[selected.status] ?? selected.status}
								</span>
							</DetailField>
							<DetailField label="HTTP status">
								<span className="font-mono tabular-nums">
									{selected.responseStatus ?? "—"}
								</span>
							</DetailField>
							<DetailField label="Duration">
								<span className="tabular-nums">
									{duration(selected.durationMs)}
								</span>
							</DetailField>
							<DetailField label="Started">
								<RelativeTime value={selected.createdAt} />
							</DetailField>
							<DetailField label="Completed">
								{selected.completedAt ? (
									<RelativeTime value={selected.completedAt} />
								) : (
									"Not yet"
								)}
							</DetailField>
							<DetailField label="Approval">
								<span className="break-all font-mono text-xs">
									{selected.approvalId ?? "—"}
								</span>
							</DetailField>
							<DetailField label="For">
								<ActingFor
									className="text-sm"
									endUserId={selected.endUserId}
									environmentId={environmentId}
								/>
							</DetailField>
						</div>
						{selected.decision ? (
							<DetailField label="Decision">
								<div
									className="space-y-1 text-sm"
									data-testid="invocation-decision"
								>
									<p>{selected.decision.explanation}</p>
									<p className="text-muted-foreground text-xs">
										{selected.decision.code}
										{selected.decision.policy
											? ` · ${selected.decision.policy.id} v${selected.decision.policy.version}`
											: ""}
										{" · "}
										<RelativeTime value={selected.decision.decidedAt} />
									</p>
								</div>
							</DetailField>
						) : null}
						{!selected.decision &&
						(selected.status === "denied" || selected.status === "expired") ? (
							<DetailField label="Decision">
								<p
									className="text-muted-foreground text-sm"
									data-testid="decision-unavailable"
								>
									Reason unavailable for this historical invocation
								</p>
							</DetailField>
						) : null}
						{selected.status === "unknown" && selected.effectId ? (
							<p className="text-muted-foreground text-sm">
								This call is governed. Its outcome is settled on its receipt.{" "}
								<a
									className="underline underline-offset-2"
									href={`/actions/effects?effect=${encodeURIComponent(selected.effectId)}`}
								>
									Open the receipt
								</a>
							</p>
						) : selected.status === "unknown" && canResolve ? (
							<ResolveInvocation
								invocationId={selected.id}
								workspaceId={workspaceId}
							/>
						) : selected.status === "unknown" ? (
							<p className="text-muted-foreground text-sm">
								A workspace admin settles this outcome.
							</p>
						) : null}
						{selected.resolution ? (
							<DetailField label="Confirmed outcome">
								<div
									className="space-y-1 text-sm"
									data-testid="invocation-resolution"
								>
									<p>
										{selected.resolution.outcome === "failed"
											? "Did not happen at the destination."
											: "Happened at the destination."}{" "}
										{selected.resolution.evidence}
									</p>
									<p className="text-muted-foreground text-xs">
										{selected.resolution.resolvedBy.type === "api_key"
											? "API key"
											: "User"}{" "}
										{selected.resolution.resolvedBy.id}
										{selected.resolution.externalReference
											? ` · ref ${selected.resolution.externalReference}`
											: ""}
										{" · "}
										<RelativeTime value={selected.resolution.resolvedAt} />
									</p>
								</div>
							</DetailField>
						) : null}
						{selected.retryOf || selected.retriedBy ? (
							<DetailField label="Retries">
								<div className="flex flex-wrap gap-2 text-sm">
									{selected.retryOf ? (
										<Button
											onClick={() => select(selected.retryOf ?? undefined)}
											size="xs"
											variant="outline"
										>
											Retry of {selected.retryOf}
										</Button>
									) : null}
									{selected.retriedBy ? (
										<Button
											onClick={() => select(selected.retriedBy ?? undefined)}
											size="xs"
											variant="outline"
										>
											Retried by {selected.retriedBy}
										</Button>
									) : null}
								</div>
							</DetailField>
						) : null}
						{selected.error ? (
							<DetailField label="Error">
								<DetailCode>{selected.error}</DetailCode>
							</DetailField>
						) : null}
						<DetailField label="Response body (secrets redacted)">
							{selected.body ? (
								<DetailCode>{selected.body}</DetailCode>
							) : (
								<span className="text-muted-foreground">No body stored.</span>
							)}
						</DetailField>
					</>
				) : (
					<Skeleton className="h-24 w-full" />
				)}
			</DetailSheet>
		</Page>
	);
}
