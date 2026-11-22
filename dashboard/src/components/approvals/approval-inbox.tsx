"use client";

import { Link } from "@tanstack/react-router";
import {
	AlertTriangle,
	ArrowRight,
	Check,
	Code2,
	Inbox,
	ListTree,
	ShieldCheck,
	UserCheck,
	X,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { PreviewBlocks } from "@/components/effects/preview-blocks";
import {
	boundPreviewId,
	type PreviewGate,
	previewGate,
} from "@/components/effects/preview-gate";
import { EndUserFilter } from "@/components/end-users/end-user-filter";
import {
	ActingFor,
	type ActingForFilter,
} from "@/components/shared/acting-for";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { RelativeTime } from "@/components/ui/relative-time";
import {
	Sheet,
	SheetDescription,
	SheetPopup,
	SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { useActorNames } from "@/hooks/api/use-actor-names";
import {
	useApprovalDetail,
	useApprovals,
	useDecideApproval,
} from "@/hooks/api/use-approvals";
import { useAuditQueue } from "@/hooks/api/use-assistant";
import { usePreview } from "@/hooks/api/use-effects";
import { useCan } from "@/hooks/api/use-permissions";
import {
	destinationHost,
	formatAgo,
	formatTimeLeft,
	groupForInbox,
	isActionable,
	msLeft,
	payloadFields,
	SELF_APPROVED_LABEL,
	sortForInbox,
	summarizePayload,
	type Urgency,
	urgencyOf,
} from "@/lib/approvals";
import { functionPlanPayload } from "@/lib/functions";
import type { Approval, ApprovalKind, ApprovalStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AdviceBadge, AdvicePanel } from "./advice-panel";
import { FunctionPlan } from "./function-plan";
import { Pill, TONE_PILL, TONE_SURFACE, TONE_TEXT, type Tone } from "./tone";

const PAGE_SIZE = 50;

type InboxView = "pending" | "human" | "automated" | "audit";

const VIEW_QUERY: Record<
	InboxView,
	{ status?: ApprovalStatus; decisionOrigin?: "human" | "automated" }
> = {
	pending: { status: "pending" },
	human: { decisionOrigin: "human" },
	automated: { decisionOrigin: "automated" },
	audit: { decisionOrigin: "automated" },
};

const VIEW_LABEL: Record<InboxView, string> = {
	pending: "pending",
	human: "decided by approvers",
	automated: "automated decisions",
	audit: "to audit",
};

const ORIGIN_LABEL = {
	human: "by an approver",
	policy: "by policy",
	system: "on expiry",
	unknown: "",
	assistant: "by Vigil",
} as const;

function originLabel(approval: Approval): string {
	const origin = approval.decisionOrigin;
	if (!origin) return "";
	if (origin === "human") {
		if (approval.decidedBy?.type === "user") return "by a user";
		if (approval.decidedBy?.type === "api_key") return "by an API key";
	}
	return ORIGIN_LABEL[origin] ?? "";
}

const STATUS_TONE: Record<ApprovalStatus, Tone> = {
	pending: "amber",
	approved: "emerald",
	denied: "rose",
	expired: "neutral",
};

const STATUS_LABEL: Record<ApprovalStatus, string> = {
	pending: "Waiting",
	approved: "Approved",
	denied: "Denied",
	expired: "Expired",
};

const KIND_LABEL: Record<ApprovalKind, string> = {
	action: "Action",
	custom: "Custom request",
	function_plan: "Function plan",
};

const URGENCY_TONE: Record<Urgency, Tone> = {
	overdue: "rose",
	critical: "rose",
	soon: "amber",
	later: "neutral",
};

function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [active]);
	return now;
}

const DESKTOP_QUERY = "(min-width: 1024px)";

function useIsDesktop(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			const mql = window.matchMedia(DESKTOP_QUERY);
			mql.addEventListener("change", onChange);
			return () => mql.removeEventListener("change", onChange);
		},
		() => window.matchMedia(DESKTOP_QUERY).matches,
		() => true,
	);
}

export function ApprovalInbox({
	deepLinkId,
	workspaceId,
	endUserId,
	actingFor,
	onEndUserChange,
}: {
	deepLinkId?: string;
	workspaceId?: string;
	endUserId?: string;
	actingFor?: ActingForFilter;
	onEndUserChange?: (endUserId: string | undefined) => void;
}) {
	const [view, setView] = useState<InboxView>("pending");
	const status: ApprovalStatus | undefined =
		view === "pending" ? "pending" : undefined;
	const [limit, setLimit] = useState(PAGE_SIZE);
	const [selectedId, setSelectedId] = useState<string | null>(
		deepLinkId ?? null,
	);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const isDesktop = useIsDesktop();
	const listRef = useRef<HTMLDivElement>(null);

	const listQuery = useApprovals(workspaceId, {
		...VIEW_QUERY[view],
		limit,
		endUserId,
		actingFor,
	});
	const auditQuery = useAuditQueue(workspaceId);
	const auditCount = auditQuery.data?.length ?? 0;
	const approvalsQuery =
		view === "audit"
			? {
					data: auditQuery.data
						? { data: auditQuery.data, pagination: undefined }
						: undefined,
					isLoading: auditQuery.isLoading,
					isError: auditQuery.isError,
					error: auditQuery.error,
					isFetching: auditQuery.isFetching,
					refetch: auditQuery.refetch,
				}
			: listQuery;
	const rows = useMemo(
		() => sortForInbox(approvalsQuery.data?.data ?? []),
		[approvalsQuery.data],
	);
	const pagination = approvalsQuery.data?.pagination;

	const pendingCount = useApprovals(workspaceId, {
		status: "pending",
		limit: 1,
		endUserId,
		actingFor,
	});
	const humanRejections = useApprovals(workspaceId, {
		status: "denied",
		decisionOrigin: "human",
		limit: 1,
		endUserId,
		actingFor,
	});
	const policyDenials = useApprovals(workspaceId, {
		status: "denied",
		decisionOrigin: "policy",
		limit: 1,
		endUserId,
		actingFor,
	});

	const now = useNow(status === "pending" && rows.length > 0);
	const groups = useMemo(() => groupForInbox(rows, now), [rows, now]);

	const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;
	useEffect(() => {
		if (rows.length && !rows.some((r) => r.id === selectedId)) {
			setSelectedId(rows[0].id);
		}
	}, [rows, selectedId]);

	const claimedDeepLink = useRef(false);
	useEffect(() => {
		if (claimedDeepLink.current || !deepLinkId) return;
		if (!rows.some((r) => r.id === deepLinkId)) return;
		claimedDeepLink.current = true;
		setSelectedId(deepLinkId);
		listRef.current
			?.querySelector<HTMLElement>(`[data-approval-id="${deepLinkId}"]`)
			?.scrollIntoView({ block: "center" });
	}, [deepLinkId, rows]);

	const move = useCallback(
		(delta: number) => {
			if (!rows.length) return;
			const i = rows.findIndex((r) => r.id === selected?.id);
			const next = Math.min(
				Math.max((i === -1 ? 0 : i) + delta, 0),
				rows.length - 1,
			);
			setSelectedId(rows[next].id);
			const el = listRef.current?.querySelector<HTMLElement>(
				`[data-approval-id="${rows[next].id}"] button`,
			);
			el?.focus();
			el?.scrollIntoView({ block: "nearest" });
		},
		[rows, selected],
	);

	const waiting = pendingCount.data?.pagination?.total;

	return (
		<section
			aria-label="Approvals"
			className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card shadow-xs"
		>
			<header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-2 sm:px-3">
				<h2 className="sr-only">Approvals</h2>
				<Tabs
					onValueChange={(value) => {
						setView(value as InboxView);
						setLimit(PAGE_SIZE);
						setSelectedId(null);
						setDrawerOpen(false);
					}}
					value={view}
				>
					<TabsList
						className="h-9 data-[orientation=horizontal]:py-0"
						variant="underline"
					>
						<TabsTab value="pending">
							Pending
							{waiting ? (
								<span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 text-[11px] text-amber-800 tabular-nums dark:text-amber-200">
									{waiting}
								</span>
							) : null}
						</TabsTab>
						<TabsTab aria-label="Approver history" value="human">
							<span className="sm:hidden">Approvers</span>
							<span className="hidden sm:inline">Approver history</span>
						</TabsTab>
						<TabsTab aria-label="Automated decisions" value="automated">
							<span className="sm:hidden">Automated</span>
							<span className="hidden sm:inline">Automated decisions</span>
						</TabsTab>
						{auditCount > 0 || view === "audit" ? (
							<TabsTab value="audit">
								To audit
								{auditCount ? (
									<span className="ml-1.5 rounded-full bg-sky-500/15 px-1.5 text-[11px] text-sky-800 tabular-nums dark:text-sky-200">
										{auditCount}
									</span>
								) : null}
							</TabsTab>
						) : null}
					</TabsList>
				</Tabs>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-2 pb-2 sm:pb-0">
					{onEndUserChange ? (
						<EndUserFilter onChange={onEndUserChange} value={endUserId} />
					) : null}
					<p
						className="text-muted-foreground text-xs tabular-nums"
						data-testid="denial-counts"
					>
						Approver rejections:{" "}
						{humanRejections.data?.pagination?.total ?? "–"}
						{" · "}
						Policy denials: {policyDenials.data?.pagination?.total ?? "–"}
					</p>
				</div>
			</header>

			{approvalsQuery.isLoading ? (
				<div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] lg:grid-cols-[22rem_minmax(0,1fr)] xl:grid-cols-[24rem_minmax(0,1fr)]">
					<div className="space-y-2 bg-muted/30 p-3 lg:border-r">
						{[1, 2, 3, 4].map((i) => (
							<Skeleton className="h-[4.5rem] w-full rounded-lg" key={i} />
						))}
					</div>
					<div className="hidden space-y-4 p-8 lg:block">
						<Skeleton className="h-7 w-2/3" />
						<Skeleton className="h-24 w-full rounded-lg" />
						<Skeleton className="h-40 w-full rounded-lg" />
					</div>
				</div>
			) : approvalsQuery.isError ? (
				<CenteredEmpty
					action={
						<Button
							className="mt-4"
							onClick={() => approvalsQuery.refetch()}
							size="sm"
							variant="outline"
						>
							Try again
						</Button>
					}
					description={`${
						approvalsQuery.error instanceof Error
							? approvalsQuery.error.message
							: "Something went wrong."
					} Nothing has been decided.`}
					icon={<AlertTriangle />}
					title="Could not load approvals"
				/>
			) : rows.length === 0 ? (
				<CenteredEmpty
					action={
						view === "pending" ? (
							<Button
								className="mt-4"
								render={<Link search={{}} to="/approval-policies" />}
								size="sm"
								variant="outline"
							>
								Go to Policies
							</Button>
						) : undefined
					}
					description={
						view === "pending"
							? "When a policy holds one of your agent's calls for a person, it waits here for a decision."
							: view === "human"
								? "Decisions made by a member, or by an API key allowed to decide, are listed here."
								: view === "audit"
									? "Every Vigil approval picked for a check has a verdict. New ones appear here."
									: "Requests decided by a policy, Vigil, or that expired, are recorded here without needing anyone."
					}
					icon={<Inbox />}
					title={
						view === "pending"
							? "No approvals waiting"
							: `Nothing ${VIEW_LABEL[view]} yet`
					}
				/>
			) : (
				<div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] lg:grid-cols-[22rem_minmax(0,1fr)] xl:grid-cols-[24rem_minmax(0,1fr)]">
					<div className="flex min-h-0 flex-col bg-muted/25 lg:border-r">
						<div
							aria-label={`${VIEW_LABEL[view]} approvals`}
							className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2"
							ref={listRef}
							role="list"
						>
							{groups.map((group) => (
								<div key={group.id} role="presentation">
									<div
										className="sticky top-0 z-[1] bg-[color-mix(in_oklab,var(--color-muted)_30%,var(--color-card))]/95 px-2 pt-3 pb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wider backdrop-blur"
										role="presentation"
									>
										{group.label}
										<span className="ml-1.5 font-normal tabular-nums normal-case tracking-normal">
											{group.rows.length}
										</span>
									</div>
									<ul className="space-y-0.5">
										{group.rows.map((approval) => (
											<ApprovalRow
												approval={approval}
												key={approval.id}
												now={now}
												onSelect={() => {
													setSelectedId(approval.id);
													setDrawerOpen(true);
												}}
												selected={isDesktop && approval.id === selected?.id}
											/>
										))}
									</ul>
								</div>
							))}
						</div>

						<div className="flex items-center justify-between gap-2 border-t px-4 py-2.5">
							<span className="text-muted-foreground text-xs tabular-nums">
								{pagination
									? `${rows.length} of ${pagination.total}`
									: `${rows.length}`}
							</span>
							{pagination?.hasMore ? (
								<Button
									disabled={approvalsQuery.isFetching}
									onClick={() => setLimit((l) => l + PAGE_SIZE)}
									size="xs"
									variant="outline"
								>
									Load more
								</Button>
							) : (
								<span className="hidden items-center gap-1 text-muted-foreground text-xs sm:flex">
									<Kbd>j</Kbd>
									<Kbd>k</Kbd> move · <Kbd>a</Kbd> approve · <Kbd>d</Kbd> deny
								</span>
							)}
						</div>
					</div>

					{isDesktop ? (
						<div className="min-h-0 bg-card">
							{selected ? (
								<ApprovalDetail
									approval={selected}
									key={selected.id}
									now={now}
									onMove={move}
									workspaceId={workspaceId}
								/>
							) : null}
						</div>
					) : null}
				</div>
			)}

			{!isDesktop ? (
				<Sheet onOpenChange={setDrawerOpen} open={drawerOpen && !!selected}>
					<SheetPopup
						className="w-full max-w-none sm:max-w-xl"
						inset
						side="right"
					>
						<SheetTitle className="sr-only">
							{selected?.title ?? "Approval"}
						</SheetTitle>
						<SheetDescription className="sr-only">
							Review the request, then approve or deny it.
						</SheetDescription>
						<div className="flex min-h-0 flex-1 flex-col pt-6">
							{selected ? (
								<ApprovalDetail
									approval={selected}
									key={selected.id}
									now={now}
									onMove={move}
									workspaceId={workspaceId}
								/>
							) : null}
						</div>
					</SheetPopup>
				</Sheet>
			) : null}
		</section>
	);
}

function CenteredEmpty({
	icon,
	title,
	description,
	action,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
	action?: React.ReactNode;
}) {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center p-8">
			<div className="flex max-w-sm flex-col items-center text-center">
				<span
					aria-hidden="true"
					className="mb-3 text-muted-foreground [&_svg]:size-5"
				>
					{icon}
				</span>
				<p className="font-medium text-sm">{title}</p>
				<p className="mt-1 text-pretty text-muted-foreground text-sm leading-relaxed">
					{description}
				</p>
				{action}
			</div>
		</div>
	);
}

function ApprovalRow({
	approval,
	now,
	onSelect,
	selected,
}: {
	approval: Approval;
	now: number;
	onSelect: () => void;
	selected: boolean;
}) {
	const pending = isActionable(approval);
	const urgency = urgencyOf(approval, now);
	const { method, target, amount, destructive } = summarizePayload(approval);
	const host = destinationHost(approval);
	const plan = functionPlanPayload(approval);
	const subtitle = plan
		? `Function plan · ${plan.writes.length} ${plan.writes.length === 1 ? "write" : "writes"}`
		: [target, method, host].filter(Boolean).join(" · ");

	return (
		<li data-approval-id={approval.id}>
			<button
				aria-current={selected ? "true" : undefined}
				className={cn(
					"group relative w-full space-y-1 rounded-lg px-3 py-2.5 text-left transition-[background-color,box-shadow] duration-150 ease-out",
					"hover:bg-card/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					selected &&
						"bg-background shadow-xs ring-1 ring-border/70 before:absolute before:inset-y-2.5 before:left-0 before:w-0.5 before:rounded-full before:bg-foreground hover:bg-background",
				)}
				onClick={onSelect}
				type="button"
			>
				<div className="flex items-start justify-between gap-3">
					<span className="line-clamp-2 font-medium text-[13px] leading-5">
						{approval.title}
					</span>
					<span
						className={cn(
							"mt-0.5 shrink-0 text-xs tabular-nums",
							pending
								? TONE_TEXT[URGENCY_TONE[urgency]]
								: "text-muted-foreground",
						)}
					>
						{pending
							? formatTimeLeft(msLeft(approval, now))
							: formatAgo(approval.decidedAt ?? approval.createdAt, now)}
					</span>
				</div>
				{subtitle ? (
					<p className="truncate text-muted-foreground text-xs">{subtitle}</p>
				) : null}
				<ActingFor endUserId={approval.endUserId} link={false} />
				<div className="flex flex-wrap items-center gap-1.5 pt-0.5">
					{pending ? null : (
						<Pill tone={STATUS_TONE[approval.status]}>
							{STATUS_LABEL[approval.status]}
							{originLabel(approval) ? ` ${originLabel(approval)}` : ""}
						</Pill>
					)}
					{destructive ? <Pill tone="rose">Deletes data</Pill> : null}
					{typeof amount === "number" ? (
						<Pill className="tabular-nums">{amount.toLocaleString()}</Pill>
					) : null}
					{approval.requiredApprovals > 1 ? (
						<Pill className="tabular-nums" tone="sky">
							{approval.approvedCount} of {approval.requiredApprovals} approvals
						</Pill>
					) : null}
					{pending ? <AdviceBadge advice={approval.advice} /> : null}
				</div>
			</button>
		</li>
	);
}

function ApprovalDetail({
	approval: listedApproval,
	now,
	onMove,
	workspaceId,
}: {
	approval: Approval;
	now: number;
	onMove: (delta: number) => void;
	workspaceId?: string;
}) {
	const detail = useApprovalDetail(workspaceId, listedApproval.id);
	const approval = detail.data ?? listedApproval;
	const nameOf = useActorNames(workspaceId);
	const [note, setNote] = useState("");
	const [armed, setArmed] = useState(false);
	const decide = useDecideApproval();
	const noteRef = useRef<HTMLInputElement>(null);
	const pending = isActionable(approval);
	const can = useCan(workspaceId);
	const approvalEnvironmentId =
		typeof approval.payload?.environmentId === "string"
			? approval.payload.environmentId
			: undefined;
	const canDecide = can("approvals.decide", approvalEnvironmentId);
	const urgency = urgencyOf(approval, now);
	const { method, target, amount, destructive } = summarizePayload(approval);
	const host = destinationHost(approval);
	const previewQuery = usePreview(
		workspaceId,
		typeof approval.payload?.environmentId === "string"
			? approval.payload.environmentId
			: undefined,
		boundPreviewId(approval),
	);
	const gate = previewGate(approval, previewQuery, now);
	const approveBlocked = gate.kind === "blocked";
	const approveBlockedId = useId();

	const submit = useCallback(
		(decision: "approve" | "deny") => {
			if (!workspaceId || decide.isPending) return;
			decide.mutate({
				approvalId: approval.id,
				decision,
				note: note.trim() || undefined,
				workspaceId,
			});
			setArmed(false);
		},
		[approval.id, decide, note, workspaceId],
	);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			const el = e.target as HTMLElement | null;
			const typing =
				el?.isContentEditable ||
				["INPUT", "TEXTAREA", "SELECT"].includes(el?.tagName ?? "");

			if (e.key === "Escape" && typing) {
				(el as HTMLElement).blur();
				return;
			}
			if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

			if (e.key === "Enter") {
				e.preventDefault();
				noteRef.current?.focus();
				return;
			}
			if (e.key === "j" || e.key === "ArrowDown") {
				e.preventDefault();
				onMove(1);
				return;
			}
			if (e.key === "k" || e.key === "ArrowUp") {
				e.preventDefault();
				onMove(-1);
				return;
			}
			if (!pending || !canDecide) return;

			if (e.key === "d") {
				e.preventDefault();
				submit("deny");
				return;
			}
			if (e.key === "a") {
				e.preventDefault();
				if (approveBlocked) return;
				if (destructive && !armed) {
					setArmed(true);
					return;
				}
				submit("approve");
			}
		}

		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [approveBlocked, armed, canDecide, destructive, onMove, pending, submit]);

	useEffect(() => {
		if (!armed) return;
		const id = setTimeout(() => setArmed(false), 3000);
		return () => clearTimeout(id);
	}, [armed]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				<article className="mx-auto max-w-3xl px-5 py-6 sm:px-8">
					<header className="space-y-2 pb-6">
						<div className="flex flex-wrap items-center gap-1.5">
							<Pill tone={STATUS_TONE[approval.status]}>
								{STATUS_LABEL[approval.status]}
							</Pill>
							<Pill>{KIND_LABEL[approval.kind]}</Pill>
							{pending ? (
								<Pill tone={URGENCY_TONE[urgency]}>
									{urgency === "overdue"
										? "Past its expiry"
										: `${formatTimeLeft(msLeft(approval, now))} left`}
								</Pill>
							) : null}
							<span className="text-muted-foreground text-xs">
								Requested {formatAgo(approval.createdAt, now)}
							</span>
						</div>
						<h2 className="text-balance font-semibold text-xl tracking-tight">
							{approval.title}
						</h2>
						<p className="flex min-w-0 items-baseline gap-1.5 text-muted-foreground text-xs">
							For
							<ActingFor endUserId={approval.endUserId} />
						</p>
						{approval.description && approval.kind !== "function_plan" ? (
							<p className="text-muted-foreground text-sm leading-relaxed">
								{approval.description}
							</p>
						) : null}
					</header>

					<div className="flex flex-col gap-6 [&>*+*]:border-t [&>*+*]:pt-6">
						<WhatHappens
							amount={amount}
							approval={approval}
							destructive={destructive}
							host={host}
							method={method}
							target={target}
						/>

						{approval.policyExplanation ? (
							<div className="flex gap-3">
								<ShieldCheck
									aria-hidden="true"
									className="mt-0.5 size-4 shrink-0 text-sky-700 dark:text-sky-300"
								/>
								<div className="space-y-0.5">
									<p className="font-medium text-sm">
										{pending ? "Why this needs you" : "Policy"}
									</p>
									<p className="text-muted-foreground text-sm leading-relaxed">
										{approval.policyExplanation}
									</p>
								</div>
							</div>
						) : null}

						<AdvicePanel approval={approval} workspaceId={workspaceId} />

						<ApprovalPreview gate={gate} />
						<RequestDetails approval={approval} />
						<section aria-label="Recorded votes" className="space-y-2 text-sm">
							<h3 className="font-medium">Recorded votes</h3>
							{detail.isError ? (
								<p role="alert">
									Vote history could not be loaded.{" "}
									<button
										type="button"
										className="underline"
										onClick={() => detail.refetch()}
									>
										Retry
									</button>
								</p>
							) : detail.isLoading ? (
								<output className="block text-muted-foreground">
									Loading vote history…
								</output>
							) : approval.votes?.length ? (
								<ol className="divide-y overflow-hidden rounded-lg border">
									{approval.votes.map((vote, index) => (
										<li
											key={`${vote.decidedBy?.id ?? "unattributed"}-${vote.decidedAt}-${index}`}
											className="flex gap-3 px-4 py-3"
										>
											<span
												aria-hidden="true"
												className={cn(
													"mt-px flex size-5 shrink-0 items-center justify-center rounded-full",
													vote.decision === "approve"
														? TONE_PILL.emerald
														: TONE_PILL.rose,
												)}
											>
												{vote.decision === "approve" ? (
													<Check className="size-3" />
												) : (
													<X className="size-3" />
												)}
											</span>
											<div className="min-w-0 flex-1 space-y-1.5">
												<p className="break-words">
													<span className="font-medium">
														{vote.decision === "approve"
															? "Approved"
															: "Denied"}
													</span>{" "}
													by{" "}
													{vote.decidedBy ? (
														<span title={nameOf(vote.decidedBy).title}>
															{vote.decidedBy.displayName ??
																nameOf(vote.decidedBy).text}
														</span>
													) : (
														"an unrecorded reviewer"
													)}
													<span className="text-muted-foreground">
														{" · "}
														<RelativeTime value={vote.decidedAt} />
													</span>
												</p>
												{vote.selfApproved ? (
													<Pill
														className="h-auto min-h-5 whitespace-normal py-0.5"
														data-testid="self-approved"
														tone="amber"
													>
														<UserCheck aria-hidden="true" className="size-3" />
														{SELF_APPROVED_LABEL}
													</Pill>
												) : null}
												{vote.note ? (
													<p className="text-muted-foreground">{vote.note}</p>
												) : null}
											</div>
										</li>
									))}
								</ol>
							) : (
								<p className="text-muted-foreground">
									{approval.votes
										? "No recorded votes."
										: "Vote history is not available."}
								</p>
							)}
						</section>

						{pending ? null : (
							<div
								className={cn(
									"space-y-1.5 rounded-lg px-4 py-3 text-sm",
									TONE_SURFACE[STATUS_TONE[approval.status]],
								)}
							>
								<p className="font-medium">
									{approval.status === "expired" ? (
										"Expired without a decision. Anlyon did not run it."
									) : (
										<>
											{STATUS_LABEL[approval.status]}
											{originLabel(approval) ? ` ${originLabel(approval)}` : ""}
											{approval.decidedAt ? (
												<>
													{" "}
													<RelativeTime value={approval.decidedAt} />
												</>
											) : null}
											.
										</>
									)}
								</p>
								{approval.decidedBy ? (
									<p className="break-all text-muted-foreground">
										Final reviewer:{" "}
										<span title={nameOf(approval.decidedBy).title}>
											{approval.decidedBy.displayName ??
												nameOf(approval.decidedBy).text}
										</span>
									</p>
								) : approval.decisionOrigin === "human" ? (
									<p className="text-muted-foreground">
										Reviewer identity was not recorded.
									</p>
								) : null}
								{approval.decisionNote ? (
									<p className="text-muted-foreground italic">
										“{approval.decisionNote}”
									</p>
								) : null}
							</div>
						)}
					</div>

					<p className="mt-8 font-mono text-[11px] text-muted-foreground/70">
						{approval.id}
						{approval.matchedPolicyId ? (
							<>
								{" · "}
								<Link
									className="underline underline-offset-2 hover:text-foreground"
									search={{
										policy: approval.matchedPolicyId,
										version: approval.matchedPolicyVersion ?? undefined,
									}}
									title="Open the exact policy version that governed this decision"
									to="/approval-policies"
								>
									policy {approval.matchedPolicyId}
									{approval.matchedPolicyVersion
										? ` v${approval.matchedPolicyVersion}`
										: ""}
								</Link>
							</>
						) : null}
					</p>
				</article>
			</div>

			{pending && !canDecide ? (
				<footer className="border-t bg-card/95 px-5 py-3 backdrop-blur sm:px-8">
					<p
						className="mx-auto max-w-3xl text-muted-foreground text-sm"
						data-testid="decide-not-allowed"
					>
						Your role can view this approval but not decide it.
					</p>
				</footer>
			) : null}
			{pending && canDecide ? (
				<footer className="border-t bg-card/95 px-5 py-3 backdrop-blur sm:px-8">
					<div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2">
						{gate.kind === "blocked" ? (
							<output
								className="block basis-full text-muted-foreground text-xs"
								data-testid="approve-blocked"
								id={approveBlockedId}
							>
								Approve is unavailable: {gate.reason}
							</output>
						) : null}
						<Input
							aria-label="Note, recorded with your decision"
							className="basis-full sm:min-w-48 sm:basis-0 sm:flex-1"
							onChange={(e) => setNote(e.target.value)}
							placeholder="Add a note for the record (optional)"
							ref={noteRef}
							value={note}
						/>
						<Button
							className="flex-1 sm:flex-none"
							disabled={!workspaceId || decide.isPending}
							onClick={() => submit("deny")}
							variant="outline"
						>
							<X className="size-4" />
							Deny
						</Button>
						<Button
							aria-live="polite"
							className={cn(
								"flex-1 sm:flex-none",
								destructive &&
									"border border-rose-500/25 bg-rose-500/10 text-rose-700 shadow-none hover:bg-rose-500/15 dark:text-rose-200",
							)}
							aria-describedby={approveBlocked ? approveBlockedId : undefined}
							disabled={!workspaceId || decide.isPending || approveBlocked}
							onClick={() => submit("approve")}
						>
							<Check className="size-4" />
							{armed
								? "Press a again to approve"
								: destructive
									? "Approve and delete"
									: "Approve"}
						</Button>
					</div>
				</footer>
			) : null}
		</div>
	);
}

function WhatHappens({
	approval,
	method,
	target,
	host,
	amount,
	destructive,
}: {
	approval: Approval;
	method?: string;
	target?: string;
	host?: string;
	amount?: number;
	destructive: boolean;
}) {
	const facts: Array<[string, string]> = [];
	if (target) facts.push(["Action", target]);
	if (method) facts.push(["Method", method]);
	if (host) facts.push(["Destination", host]);
	if (typeof amount === "number")
		facts.push(["Amount", amount.toLocaleString()]);
	if (approval.requiredApprovals > 1) {
		facts.push([
			"Approvals",
			`${approval.approvedCount} of ${approval.requiredApprovals}`,
		]);
	}

	const plan = functionPlanPayload(approval);
	const functionName =
		typeof approval.payload?.functionName === "string"
			? approval.payload.functionName
			: null;
	if (plan) {
		facts.push([
			"Writes",
			`${plan.writes.length}: ${[...new Set(plan.writes.map((w) => w.action))].join(", ")}`,
		]);
	}

	const sentence =
		approval.kind === "action" && method && host
			? `Approving sends ${method} to ${host}${target ? ` as “${target}”` : ""}, using the credentials bound to that action.`
			: plan
				? `Approving lets one run of ${functionName ? `“${functionName}”` : "this function version"}, with this input, make exactly the ${plan.writes.length === 1 ? "write" : `${plan.writes.length} writes`} below, in this order.`
				: "The agent is waiting for your answer and continues once you decide.";

	return (
		<section aria-label="What approving does" className="space-y-4">
			<div
				className={cn(
					"flex items-start gap-3",
					destructive && cn("-mx-3 rounded-lg px-3 py-2.5", TONE_SURFACE.rose),
				)}
			>
				<ArrowRight
					aria-hidden="true"
					className="mt-1 size-4 shrink-0 text-muted-foreground"
				/>
				<p className="text-[15px] leading-relaxed">
					{sentence}
					{destructive ? (
						<span className="font-medium text-rose-700 dark:text-rose-300">
							{" "}
							This deletes data.
						</span>
					) : null}
					{approval.requiredApprovals > 1 ? (
						<span className="text-muted-foreground">
							{" "}
							It runs once {approval.requiredApprovals} distinct approvers have
							approved.
						</span>
					) : null}
				</p>
			</div>
			{facts.length > 0 ? (
				<dl className="grid grid-cols-2 gap-x-6 gap-y-3 ps-7 sm:grid-cols-4">
					{facts.map(([label, value]) => (
						<div
							className={cn("min-w-0", label === "Writes" && "col-span-2")}
							key={label}
						>
							<dt className="text-muted-foreground text-xs">{label}</dt>
							<dd
								className="truncate font-medium font-mono text-[13px]"
								title={value}
							>
								{value}
							</dd>
						</div>
					))}
				</dl>
			) : null}
		</section>
	);
}

function ApprovalPreview({ gate }: { gate: PreviewGate }) {
	if (gate.kind === "not_governed") return null;
	return (
		<section aria-label="What you are approving" className="space-y-2">
			<h3 className="font-medium text-sm">What you are approving</h3>
			{gate.preview ? (
				<PreviewBlocks preview={gate.preview} />
			) : gate.kind === "blocked" ? (
				<p className="text-muted-foreground text-sm" role="status">
					{gate.reason}
				</p>
			) : null}
		</section>
	);
}

function RequestDetails({ approval }: { approval: Approval }) {
	const [raw, setRaw] = useState(false);
	const { fields, truncated } = payloadFields(approval);
	const plan = functionPlanPayload(approval);
	if (Object.keys(approval.payload ?? {}).length === 0) return null;
	if (plan && plan.writes.length > 0)
		return <FunctionPlan approval={approval} />;

	return (
		<section aria-label="Request" className="space-y-2">
			<div className="flex items-center justify-between">
				<h3 className="font-medium text-sm">
					{approval.kind === "action"
						? "Input"
						: approval.kind === "function_plan"
							? "Plan"
							: "Request"}
				</h3>
				<Button
					aria-pressed={raw}
					onClick={() => setRaw((v) => !v)}
					size="xs"
					variant="ghost"
				>
					{raw ? (
						<ListTree className="size-3.5" />
					) : (
						<Code2 className="size-3.5" />
					)}
					{raw ? "Fields" : "Raw JSON"}
				</Button>
			</div>
			{raw || fields.length === 0 ? (
				<pre className="max-h-80 overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-relaxed">
					{JSON.stringify(approval.payload, null, 2)}
				</pre>
			) : (
				<div className="overflow-hidden rounded-lg border">
					<dl className="divide-y divide-border/50">
						{fields.map((field) => (
							<div
								className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-4 px-4 py-2"
								key={field.key}
							>
								<dt className="truncate font-mono text-muted-foreground text-xs leading-5">
									{field.key}
								</dt>
								<dd className="break-words font-mono text-xs leading-5">
									{field.value}
								</dd>
							</div>
						))}
					</dl>
					{truncated ? (
						<p className="border-t px-4 py-2 text-muted-foreground text-xs">
							More fields in the raw JSON.
						</p>
					) : null}
				</div>
			)}
		</section>
	);
}
