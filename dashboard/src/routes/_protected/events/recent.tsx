"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useId } from "react";
import {
	DetailCode,
	DetailField,
	DetailSheet,
	StatusDot,
} from "@/components/actions/detail-sheet";
import {
	ListMessage,
	ListSkeleton,
	Pager,
	RowStepper,
	useRowKeys,
} from "@/components/activity/list-parts";
import { EventsTabs } from "@/components/events/events-tabs";
import {
	ListFrame,
	Page,
	PageHeader,
	PageToolbar,
} from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { RelativeTime } from "@/components/ui/relative-time";
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
import { useEvent, useEvents, useEventTopics } from "@/hooks/api/use-events";
import type { EventRecord } from "@/lib/types";

type RecentEventsSearch = {
	event: string | undefined;
	topic: string | undefined;
	offset?: number;
};

export const Route = createFileRoute("/_protected/events/recent")({
	validateSearch: (search: Record<string, unknown>): RecentEventsSearch => ({
		event: typeof search.event === "string" ? search.event : undefined,
		topic: typeof search.topic === "string" ? search.topic : undefined,
		offset:
			typeof search.offset === "number" && search.offset > 0
				? Math.floor(search.offset)
				: undefined,
	}),
	component: RecentEventsPage,
});

const PAGE_SIZE = 50;

function statusDot(status: string): string {
	if (status === "fanned_out") return "bg-success";
	if (status === "no_subscribers") return "bg-muted-foreground/60";
	return "bg-warning";
}

function statusLabel(status: string): string {
	if (status === "fanned_out") return "Sent to subscribers";
	if (status === "no_subscribers") return "No subscribers";
	if (status === "pending") return "Pending";
	const words = status.replace(/_/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function deliveryDot(status: string): string {
	if (status === "delivered") return "bg-success";
	if (status === "failed") return "bg-destructive";
	return "bg-warning";
}

function RecentEventsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const navigate = Route.useNavigate();
	const topicFilterId = useId();
	const {
		event: selectedId,
		topic: topicFilter,
		offset = 0,
	} = Route.useSearch();

	const topicsQuery = useEventTopics(workspaceId);
	const { data, isLoading, isError, error } = useEvents(workspaceId, {
		topic: topicFilter,
		limit: PAGE_SIZE,
		offset: offset || undefined,
	});
	const rows = data?.data ?? [];
	const pagination = data?.pagination;

	const select = useCallback(
		(id: string | undefined) =>
			navigate({
				to: "/events/recent",
				search: (previous) => ({ ...previous, event: id }),
			}),
		[navigate],
	);
	const stepper = useRowKeys({ rows, selectedId, onSelect: select });
	const filterTopic = (topic: string | undefined) =>
		navigate({
			to: "/events/recent",
			replace: true,
			search: (previous) => ({
				...previous,
				event: undefined,
				offset: undefined,
				topic,
			}),
		});

	return (
		<Page>
			<PageHeader
				description="What Anlyon published, such as an approval requested, and whether it reached your webhooks."
				title="Events"
			/>
			<EventsTabs />

			<PageToolbar>
				<div className="w-full sm:w-56">
					<label className="sr-only" htmlFor={topicFilterId}>
						Filter by topic
					</label>
					<NativeSelect
						className="w-full"
						id={topicFilterId}
						onChange={(e) => filterTopic(e.target.value || undefined)}
						value={topicFilter ?? ""}
					>
						<NativeSelectOption value="">All topics</NativeSelectOption>
						{(topicsQuery.data ?? []).map((topic) => (
							<NativeSelectOption key={topic.id} value={topic.name}>
								{topic.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
			</PageToolbar>

			<ListFrame
				footer={
					rows.length > 0 ? (
						<Pager
							hasMore={pagination?.hasMore ?? false}
							noun={["event", "events"]}
							offset={offset}
							onPage={(next) =>
								navigate({
									to: "/events/recent",
									search: (previous) => ({
										...previous,
										event: undefined,
										offset: next,
									}),
								})
							}
							pageSize={PAGE_SIZE}
							shown={rows.length}
							total={pagination?.total}
						/>
					) : null
				}
			>
				{isLoading ? (
					<ListSkeleton />
				) : isError ? (
					<ListMessage title="Events could not be loaded." tone="error">
						{(error as Error | null)?.message}
					</ListMessage>
				) : rows.length === 0 && topicFilter ? (
					<ListMessage
						action={
							<Button
								onClick={() => filterTopic(undefined)}
								size="sm"
								variant="outline"
							>
								Show all topics
							</Button>
						}
						title="No events on this topic yet"
					>
						Nothing has been published to{" "}
						<span className="font-mono" translate="no">
							{topicFilter}
						</span>
						.
					</ListMessage>
				) : rows.length === 0 ? (
					<ListMessage
						action={
							<Button
								render={<Link search={{ topic: undefined }} to="/events" />}
								size="sm"
							>
								Go to Event topics
							</Button>
						}
						title="No events yet"
					>
						One appears when an approval, an invocation or an environment
						changes. Subscribe a webhook to a topic to receive them.
					</ListMessage>
				) : (
					<Table className="text-[13px]">
						<TableHeader>
							<TableRow>
								<TableHead className="w-44">Status</TableHead>
								<TableHead>Type</TableHead>
								<TableHead className="hidden md:table-cell">Topic</TableHead>
								<TableHead className="hidden w-28 text-right sm:table-cell">
									Subscribers
								</TableHead>
								<TableHead className="hidden w-32 text-right sm:table-cell">
									Published
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((ev: EventRecord) => (
								<TableRow
									className="cursor-pointer"
									data-state={selectedId === ev.id ? "selected" : undefined}
									key={ev.id}
									onClick={() => select(ev.id)}
								>
									<TableCell className="py-2">
										<span className="inline-flex items-center gap-2">
											<StatusDot className={statusDot(ev.status)} />
											{statusLabel(ev.status)}
										</span>
									</TableCell>
									<TableCell className="max-w-0 py-2">
										<button
											aria-label={`Inspect event ${ev.type}`}
											className="block w-full truncate rounded-sm text-left font-medium font-mono text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
											onClick={(event) => {
												event.stopPropagation();
												select(ev.id);
											}}
											translate="no"
											type="button"
										>
											{ev.type}
										</button>
									</TableCell>
									<TableCell className="hidden py-2 font-mono text-muted-foreground text-xs md:table-cell">
										{ev.topic ?? "—"}
									</TableCell>
									<TableCell className="hidden py-2 text-right tabular-nums sm:table-cell">
										{ev.subscriptionCount}
									</TableCell>
									<TableCell className="hidden py-2 text-right text-muted-foreground tabular-nums sm:table-cell">
										<RelativeTime value={ev.createdAt} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</ListFrame>

			<EventDrawer
				eventId={selectedId}
				onClose={() => select(undefined)}
				stepper={
					<RowStepper
						onNewer={
							stepper.newer ? () => select(stepper.newer?.id) : undefined
						}
						onOlder={
							stepper.older ? () => select(stepper.older?.id) : undefined
						}
						position={stepper.position}
					/>
				}
				workspaceId={workspaceId}
			/>
		</Page>
	);
}

function EventDrawer({
	eventId,
	workspaceId,
	onClose,
	stepper,
}: {
	eventId?: string;
	workspaceId?: string;
	onClose: () => void;
	stepper?: ReactNode;
}) {
	const { data: event, isLoading } = useEvent(eventId, workspaceId);

	return (
		<DetailSheet
			description={eventId}
			onClose={onClose}
			open={eventId !== undefined}
			title={event?.type ?? "Event"}
		>
			{stepper}
			{isLoading ? (
				<div className="space-y-3">
					<Skeleton className="h-6 w-2/3" />
					<Skeleton className="h-20 w-full" />
				</div>
			) : !event ? (
				<p className="text-muted-foreground text-sm">Event not found.</p>
			) : (
				<>
					<div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b pb-5">
						<DetailField label="Status">
							<span className="inline-flex items-center gap-2">
								<StatusDot className={statusDot(event.status)} />
								{statusLabel(event.status)}
							</span>
						</DetailField>
						<DetailField label="Topic">
							<span className="font-mono text-xs">{event.topic ?? "—"}</span>
						</DetailField>
						<DetailField label="Subscriptions">
							<span className="tabular-nums">{event.subscriptionCount}</span>
						</DetailField>
						<DetailField label="Created">
							<RelativeTime value={event.createdAt} />
						</DetailField>
					</div>

					{event.data ? (
						<DetailField label="Payload">
							<DetailCode>{JSON.stringify(event.data, null, 2)}</DetailCode>
						</DetailField>
					) : null}

					<DetailField label="Deliveries">
						{event.deliveries.length === 0 ? (
							<p className="text-muted-foreground">
								No deliveries recorded for this event.
							</p>
						) : (
							<ul className="divide-y overflow-hidden rounded-lg border text-xs">
								{event.deliveries.map((d) => (
									<li
										className="flex flex-col gap-1 px-3 py-2.5"
										key={d.messageId}
									>
										<div className="flex items-start justify-between gap-3">
											<span className="min-w-0 break-all font-mono">
												{d.url}
											</span>
											<span className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
												<StatusDot className={deliveryDot(d.status)} />
												{d.status}
											</span>
										</div>
										<div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground tabular-nums">
											<span>attempts {d.attempts}</span>
											{d.responseStatus != null && (
												<span>HTTP {d.responseStatus}</span>
											)}
											{d.deliveredAt && (
												<span>
													delivered {new Date(d.deliveredAt).toLocaleString()}
												</span>
											)}
											{d.failedAt && (
												<span>
													failed {new Date(d.failedAt).toLocaleString()}
												</span>
											)}
										</div>
									</li>
								))}
							</ul>
						)}
					</DetailField>
				</>
			)}
		</DetailSheet>
	);
}
