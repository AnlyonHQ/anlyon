"use client";

import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRight, ChevronRight, Search } from "lucide-react";
import { useCallback, useId } from "react";
import {
	ListMessage,
	ListSkeleton,
	Pager,
	RowStepper,
	useRowKeys,
} from "@/components/activity/list-parts";
import {
	ListFrame,
	Page,
	PageHeader,
	PageToolbar,
} from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { RelativeTime } from "@/components/ui/relative-time";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Sheet,
	SheetDescription,
	SheetHeader,
	SheetPopup,
	SheetTitle,
} from "@/components/ui/sheet";
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
import { useRun, useRuns } from "@/hooks/api/use-runs";
import { requireFeature } from "@/lib/feature-flags";
import type { RunStatus, SpanNode } from "@/lib/types";
import { cn } from "@/lib/utils";

type TraceView = "tree" | "waterfall";

const STATUSES: RunStatus[] = ["running", "succeeded", "failed", "cancelled"];

type RecentRunsSearch = {
	run: string | undefined;
	search: string | undefined;
	view: TraceView;
	status?: RunStatus;
	offset?: number;
};

export const Route = createFileRoute("/_protected/recent-runs")({
	beforeLoad: () => requireFeature("runs"),
	validateSearch: (search: Record<string, unknown>): RecentRunsSearch => ({
		run: typeof search.run === "string" ? search.run : undefined,
		search: typeof search.search === "string" ? search.search : undefined,
		view: search.view === "waterfall" ? "waterfall" : "tree",
		status: STATUSES.includes(search.status as RunStatus)
			? (search.status as RunStatus)
			: undefined,
		offset:
			typeof search.offset === "number" && search.offset > 0
				? Math.floor(search.offset)
				: undefined,
	}),
	component: RecentRunsPage,
});

const PAGE_SIZE = 50;

const STATUS_DOT: Record<RunStatus, string> = {
	running: "bg-warning",
	succeeded: "bg-success",
	failed: "bg-destructive",
	cancelled: "bg-muted-foreground/60",
};

const STATUS_LABEL: Record<RunStatus, string> = {
	running: "Running",
	succeeded: "Succeeded",
	failed: "Error",
	cancelled: "Cancelled",
};

const ANY_STATUS = "any";
const STATUS_ITEMS = [
	{ value: ANY_STATUS, label: "Any status" },
	...STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] })),
];

function formatDuration(ms: number | null): string {
	if (ms === null) return "";
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function formatCost(cost: number | null): string | null {
	if (cost === null) return null;
	return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

function RunStatusLabel({ status }: { status: RunStatus }) {
	return (
		<span className="inline-flex items-center gap-2">
			<span
				aria-hidden="true"
				className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status])}
			/>
			{STATUS_LABEL[status] ?? status}
		</span>
	);
}

function SpanRow({ span, depth }: { span: SpanNode; depth: number }) {
	return (
		<div>
			<div
				className="flex items-center gap-2 border-border/60 border-b py-1.5 pe-3 text-[13px] hover:bg-muted/40"
				style={{ paddingLeft: `${depth * 16 + 8}px` }}
			>
				{span.children.length > 0 ? (
					<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
				) : (
					<span className="size-3.5 shrink-0" />
				)}
				<span
					aria-hidden="true"
					className={cn(
						"size-1.5 shrink-0 rounded-full",
						STATUS_DOT[span.status] ?? "bg-muted-foreground/60",
					)}
				/>
				<span className="sr-only">{span.status}</span>
				<span className="w-16 shrink-0 truncate font-mono text-[11.5px] text-muted-foreground">
					{span.type}
				</span>
				<span className="min-w-0 truncate">{span.name}</span>
				{span.model && (
					<span className="ml-auto shrink-0 font-mono text-[11.5px] text-muted-foreground">
						{span.model}
					</span>
				)}
				<span
					className={cn(
						"w-16 shrink-0 text-right text-muted-foreground text-xs tabular-nums",
						!span.model && "ml-auto",
					)}
				>
					{formatDuration(span.durationMs)}
				</span>
			</div>
			{span.children.map((child) => (
				<SpanRow key={child.id} span={child} depth={depth + 1} />
			))}
		</div>
	);
}

function flattenSpans(spans: SpanNode[]): SpanNode[] {
	return spans.flatMap((span) => [span, ...flattenSpans(span.children)]);
}

function TraceWaterfall({
	run,
}: {
	run: { startedAt: string; durationMs: number | null; spans: SpanNode[] };
}) {
	const spans = flattenSpans(run.spans);
	const runStartedAt = new Date(run.startedAt).getTime();
	const totalDuration = Math.max(
		run.durationMs ?? 0,
		...spans.map((span) => {
			const offset = Math.max(
				0,
				new Date(span.startedAt).getTime() - runStartedAt,
			);
			return offset + (span.durationMs ?? 0);
		}),
		1,
	);

	return (
		<ScrollArea className="flex-1">
			<ul aria-label="Trace waterfall" className="min-w-[620px] list-none p-4">
				{spans.map((span) => {
					const offset = Math.max(
						0,
						new Date(span.startedAt).getTime() - runStartedAt,
					);
					const duration = span.durationMs ?? 0;
					const offsetPercent = Math.min(100, (offset / totalDuration) * 100);
					const widthPercent = Math.max(
						1,
						Math.min(100 - offsetPercent, (duration / totalDuration) * 100),
					);
					return (
						<li
							className="grid grid-cols-[minmax(10rem,14rem)_1fr] items-center gap-3 py-1.5"
							key={span.id}
						>
							<div className="min-w-0">
								<div className="truncate font-medium text-[13px]">
									{span.name}
								</div>
								<div className="font-mono text-[11.5px] text-muted-foreground">
									{span.type} · {formatDuration(span.durationMs)}
								</div>
							</div>
							<div aria-hidden="true" className="h-4 rounded-sm bg-muted">
								<div
									className={`h-full rounded-sm ${
										span.status === "failed" ? "bg-destructive" : "bg-primary"
									}`}
									style={{
										marginLeft: `${offsetPercent}%`,
										width: `${widthPercent}%`,
									}}
								/>
							</div>
							<span className="sr-only">
								Starts {formatDuration(offset)} into the run and lasts{" "}
								{formatDuration(span.durationMs)}.
							</span>
						</li>
					);
				})}
			</ul>
		</ScrollArea>
	);
}

export function TraceTree({
	workspaceId,
	runId,
	view,
	onViewChange,
}: {
	workspaceId?: string;
	runId: string;
	view: TraceView;
	onViewChange: (view: TraceView) => void;
}) {
	const runQuery = useRun(workspaceId, runId);
	const run = runQuery.data;

	if (runQuery.isLoading) {
		return (
			<div className="space-y-2 p-4">
				{[0, 1, 2, 3].map((i) => (
					<Skeleton className="h-6 w-full" key={i} />
				))}
			</div>
		);
	}
	if (!run) {
		return runQuery.isError ? (
			<ListMessage title="This run could not be loaded." tone="error">
				{(runQuery.error as Error | null)?.message}
			</ListMessage>
		) : null;
	}
	const cost = formatCost(run.cost);

	return (
		<div className="flex h-full flex-col">
			<dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-b px-4 py-3.5 text-sm sm:grid-cols-4">
				<div className="flex min-w-0 flex-col gap-0.5">
					<dt className="text-muted-foreground text-xs">Status</dt>
					<dd>
						<RunStatusLabel status={run.status} />
					</dd>
				</div>
				<div className="flex min-w-0 flex-col gap-0.5">
					<dt className="text-muted-foreground text-xs">Duration</dt>
					<dd className="tabular-nums">
						{formatDuration(run.durationMs) || "—"}
					</dd>
				</div>
				<div className="flex min-w-0 flex-col gap-0.5">
					<dt className="text-muted-foreground text-xs">Tokens</dt>
					<dd className="tabular-nums">
						{run.tokens !== null ? run.tokens.toLocaleString() : "—"}
					</dd>
				</div>
				<div className="flex min-w-0 flex-col gap-0.5">
					<dt className="text-muted-foreground text-xs">Cost</dt>
					<dd className="tabular-nums">{cost ?? "—"}</dd>
				</div>
			</dl>
			{run.spans.length === 0 ? (
				<p className="p-4 text-muted-foreground text-sm">
					No spans recorded for this run yet.
				</p>
			) : (
				<>
					<fieldset className="flex items-center justify-between gap-3 border-b px-4 py-2">
						<legend className="sr-only">Trace view</legend>
						<span className="font-medium text-[13px]">
							{run.name ?? run.id}
						</span>
						<div className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
							<button
								aria-pressed={view === "tree"}
								className={`rounded-md px-2.5 py-1 text-xs outline-none transition-[background-color,color,box-shadow] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring ${view === "tree" ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
								onClick={() => onViewChange("tree")}
								type="button"
							>
								Tree
							</button>
							<button
								aria-pressed={view === "waterfall"}
								className={`rounded-md px-2.5 py-1 text-xs outline-none transition-[background-color,color,box-shadow] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring ${view === "waterfall" ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
								onClick={() => onViewChange("waterfall")}
								type="button"
							>
								Waterfall
							</button>
						</div>
					</fieldset>
					{view === "waterfall" ? (
						<TraceWaterfall run={run} />
					) : (
						<ScrollArea className="flex-1">
							<div className="py-1">
								{run.spans.map((span) => (
									<SpanRow depth={0} key={span.id} span={span} />
								))}
							</div>
						</ScrollArea>
					)}
				</>
			)}
		</div>
	);
}

export function RecentRunsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const navigate = Route.useNavigate();
	const searchId = useId();
	const {
		run: selectedRunId,
		search,
		view,
		status,
		offset = 0,
	} = Route.useSearch();

	const runsQuery = useRuns(workspaceId, {
		search,
		status,
		limit: PAGE_SIZE,
		offset: offset || undefined,
	});
	const runs = runsQuery.data?.data ?? [];
	const pagination = runsQuery.data?.pagination;
	const selectedRun = runs.find((run) => run.id === selectedRunId);

	const selectRun = useCallback(
		(runId: string | undefined) =>
			navigate({
				to: "/recent-runs",
				search: (previous) => ({ ...previous, run: runId }),
			}),
		[navigate],
	);
	const stepper = useRowKeys({
		rows: runs,
		selectedId: selectedRunId,
		onSelect: selectRun,
	});
	const filter = (patch: Partial<RecentRunsSearch>) =>
		navigate({
			to: "/recent-runs",
			replace: true,
			search: (previous) => ({
				...previous,
				run: undefined,
				offset: undefined,
				...patch,
			}),
		});

	return (
		<Page>
			<PageHeader
				actions={
					<Button
						render={
							<a
								href="https://docs.anlyon.com/sdks/typescript"
								rel="noreferrer"
								target="_blank"
							/>
						}
						size="sm"
						variant="outline"
					>
						SDK guide
						<ArrowUpRight aria-hidden="true" data-icon="inline-end" />
					</Button>
				}
				description="Each run your agent reported with the SDK, with its steps as a trace you can open."
				title="Agent runs"
			/>

			<PageToolbar>
				<InputGroup className="w-full sm:w-80">
					<InputGroupAddon>
						<Search aria-hidden="true" />
					</InputGroupAddon>
					<label className="sr-only" htmlFor={searchId}>
						Search runs
					</label>
					<InputGroupInput
						id={searchId}
						name="search"
						onChange={(event) =>
							filter({ search: event.target.value || undefined })
						}
						placeholder="Search by name, id or application"
						type="search"
						value={search ?? ""}
					/>
				</InputGroup>
				<Select
					items={STATUS_ITEMS}
					onValueChange={(value) =>
						filter({
							status: STATUSES.includes(value as RunStatus)
								? (value as RunStatus)
								: undefined,
						})
					}
					value={status ?? ANY_STATUS}
				>
					<SelectTrigger aria-label="Status" className="w-40">
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
				<span className="ms-auto inline-flex items-center gap-2 text-muted-foreground text-xs">
					<span aria-hidden="true" className="relative flex size-1.5">
						<span className="absolute inline-flex size-full rounded-full bg-success/60 motion-safe:animate-ping" />
						<span className="relative inline-flex size-1.5 rounded-full bg-success" />
					</span>
					Refreshes every 15 seconds
				</span>
			</PageToolbar>

			<ListFrame
				footer={
					runs.length > 0 ? (
						<Pager
							hasMore={pagination?.hasMore ?? false}
							noun={["run", "runs"]}
							offset={offset}
							onPage={(next) =>
								navigate({
									to: "/recent-runs",
									search: (previous) => ({
										...previous,
										run: undefined,
										offset: next,
									}),
								})
							}
							pageSize={PAGE_SIZE}
							shown={runs.length}
							total={pagination?.total}
						/>
					) : null
				}
			>
				{runsQuery.isLoading ? (
					<ListSkeleton />
				) : runsQuery.isError ? (
					<ListMessage title="Runs could not be loaded." tone="error">
						{(runsQuery.error as Error | null)?.message}
					</ListMessage>
				) : runs.length === 0 && (search || status) ? (
					<ListMessage
						action={
							<Button
								onClick={() => filter({ search: undefined, status: undefined })}
								size="sm"
								variant="outline"
							>
								Clear search
							</Button>
						}
						title={
							search ? `No runs match “${search}”` : "No runs with this status"
						}
					>
						{search
							? "Search by a run's name, its id or its application."
							: null}
					</ListMessage>
				) : runs.length === 0 ? (
					<ListMessage
						action={
							<Button
								render={
									<a
										href="https://docs.anlyon.com/sdks/typescript"
										rel="noreferrer"
										target="_blank"
									/>
								}
								size="sm"
								variant="outline"
							>
								Read the SDK guide
							</Button>
						}
						title="No agent runs yet"
					>
						A run appears here when your agent reports one with the SDK: start a
						run, send its spans, then end it.
					</ListMessage>
				) : (
					<Table className="text-[13px]">
						<TableHeader>
							<TableRow>
								<TableHead className="w-32">Status</TableHead>
								<TableHead>Run</TableHead>
								<TableHead className="hidden w-24 text-right sm:table-cell">
									Duration
								</TableHead>
								<TableHead className="hidden w-44 md:table-cell">
									Application
								</TableHead>
								<TableHead className="hidden w-40 text-right lg:table-cell">
									Tokens · Cost
								</TableHead>
								<TableHead className="hidden w-32 text-right sm:table-cell">
									Started
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{runs.map((run) => (
								<TableRow
									className="cursor-pointer"
									data-state={selectedRunId === run.id ? "selected" : undefined}
									key={run.id}
									onClick={() => selectRun(run.id)}
								>
									<TableCell className="py-2">
										<RunStatusLabel status={run.status} />
									</TableCell>
									<TableCell className="max-w-0 py-2">
										<button
											aria-label={`Inspect trace for ${run.name ?? run.id}`}
											className="block w-full truncate rounded-sm text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
											onClick={(event) => {
												event.stopPropagation();
												selectRun(run.id);
											}}
											type="button"
										>
											{run.name ?? run.id}
										</button>
									</TableCell>
									<TableCell className="hidden py-2 text-right text-muted-foreground tabular-nums sm:table-cell">
										{formatDuration(run.durationMs) || "—"}
									</TableCell>
									<TableCell className="hidden max-w-0 truncate py-2 font-mono text-muted-foreground text-xs md:table-cell">
										{run.application ?? "—"}
									</TableCell>
									<TableCell className="hidden py-2 text-right text-muted-foreground tabular-nums lg:table-cell">
										{run.tokens !== null
											? `${run.tokens.toLocaleString()} tok`
											: "—"}
										{formatCost(run.cost) !== null
											? ` · ${formatCost(run.cost)}`
											: ""}
									</TableCell>
									<TableCell className="hidden py-2 text-right text-muted-foreground tabular-nums sm:table-cell">
										<RelativeTime value={run.startedAt} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</ListFrame>

			<Sheet
				onOpenChange={(open) => {
					if (!open) selectRun(undefined);
				}}
				open={selectedRunId !== undefined}
			>
				<SheetPopup
					className="w-full max-w-none sm:max-w-2xl"
					inset
					side="right"
				>
					<SheetHeader className="gap-3 border-b pe-14">
						<div className="min-w-0">
							<SheetTitle className="truncate text-base">
								{selectedRun?.name ?? selectedRunId ?? "Run"}
							</SheetTitle>
							<SheetDescription className="truncate font-mono text-xs">
								{selectedRunId}
							</SheetDescription>
						</div>
						<RowStepper
							onNewer={
								stepper.newer ? () => selectRun(stepper.newer?.id) : undefined
							}
							onOlder={
								stepper.older ? () => selectRun(stepper.older?.id) : undefined
							}
							position={stepper.position}
						/>
					</SheetHeader>
					<div className="min-h-0 flex-1">
						{selectedRunId ? (
							<TraceTree
								onViewChange={(nextView) =>
									navigate({
										to: "/recent-runs",
										search: (previous) => ({ ...previous, view: nextView }),
									})
								}
								runId={selectedRunId}
								view={view}
								workspaceId={workspaceId}
							/>
						) : null}
					</div>
				</SheetPopup>
			</Sheet>
		</Page>
	);
}
