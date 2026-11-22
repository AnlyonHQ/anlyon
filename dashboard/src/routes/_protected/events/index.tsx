"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, Trash2 } from "lucide-react";
import { DetailField, DetailSheet } from "@/components/actions/detail-sheet";
import { ListMessage, ListSkeleton } from "@/components/activity/list-parts";
import { EventsTabs } from "@/components/events/events-tabs";
import {
	CreateSubscriptionDialog,
	SubscriptionsList,
} from "@/components/events/subscriptions";
import { ListFrame, Page, PageHeader } from "@/components/layout/page";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import { useWorkspace } from "@/contexts/workspace-context";
import { useDeleteTopic, useEventTopics } from "@/hooks/api/use-events";
import type { EventTopic } from "@/lib/types";

type TopicsSearch = { topic: string | undefined };

export const Route = createFileRoute("/_protected/events/")({
	validateSearch: (search: Record<string, unknown>): TopicsSearch => ({
		topic: typeof search.topic === "string" ? search.topic : undefined,
	}),
	component: TopicsPage,
});

function TopicsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const navigate = Route.useNavigate();
	const { topic: selectedName } = Route.useSearch();

	const { data: allTopics, isLoading } = useEventTopics(workspaceId);
	const topics = allTopics?.filter((topic) => topic.isReserved);
	const deleteTopic = useDeleteTopic();
	const selected = topics?.find((topic) => topic.name === selectedName) ?? null;

	const select = (name: string | undefined) =>
		navigate({
			to: "/events",
			search: (previous) => ({ ...previous, topic: name }),
		});

	return (
		<Page>
			<PageHeader
				actions={
					<Button
						render={
							<a
								href="https://docs.anlyon.com/guides/webhooks"
								rel="noreferrer"
								target="_blank"
							/>
						}
						size="sm"
						variant="outline"
					>
						Webhooks guide
						<ArrowUpRight aria-hidden="true" data-icon="inline-end" />
					</Button>
				}
				description={
					<>
						Subscribe a webhook to a topic to get Anlyon's events at your own
						endpoint. The <code className="font-mono text-xs">anlyon</code>{" "}
						topic carries approval, invocation and environment events.
					</>
				}
				title="Event topics"
			/>
			<EventsTabs />

			<ListFrame
				footer={
					topics?.length ? (
						<span className="tabular-nums">
							{topics.length} {topics.length === 1 ? "topic" : "topics"}
						</span>
					) : null
				}
			>
				{isLoading ? (
					<ListSkeleton rows={2} />
				) : !topics?.length ? (
					<ListMessage title="No event topics yet">
						The <code className="font-mono text-xs">anlyon</code> topic appears
						here once this workspace is set up. Your webhooks then subscribe to
						it.
					</ListMessage>
				) : (
					<Table className="text-[13px]">
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead className="hidden md:table-cell">
									Description
								</TableHead>
								<TableHead className="hidden w-32 text-right sm:table-cell">
									Created
								</TableHead>
								<TableHead className="hidden w-14 md:table-cell">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{topics.map((topic) => (
								<TableRow
									className="cursor-pointer"
									data-state={
										selectedName === topic.name ? "selected" : undefined
									}
									key={topic.id}
									onClick={() => select(topic.name)}
								>
									<TableCell className="max-w-0 py-2.5">
										<div className="flex min-w-0 items-center gap-2">
											<button
												aria-label={`Open topic ${topic.name}`}
												className="truncate rounded-sm text-left font-medium font-mono text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
												onClick={(event) => {
													event.stopPropagation();
													select(topic.name);
												}}
												translate="no"
												type="button"
											>
												{topic.name}
											</button>
											{topic.isReserved && (
												<Badge
													className="shrink-0 text-[10px]"
													variant="secondary"
												>
													Reserved
												</Badge>
											)}
										</div>
									</TableCell>
									<TableCell className="hidden max-w-0 truncate py-2.5 text-muted-foreground md:table-cell">
										{topic.description ?? "—"}
									</TableCell>
									<TableCell className="hidden py-2.5 text-right text-muted-foreground tabular-nums sm:table-cell">
										<RelativeTime value={topic.createdAt} />
									</TableCell>
									<TableCell
										className="hidden py-1.5 text-right md:table-cell"
										onClick={(e) => e.stopPropagation()}
									>
										{!topic.isReserved && (
											<DeleteTopicButton
												onDelete={() =>
													workspaceId &&
													deleteTopic.mutate({
														topicRef: topic.name,
														workspaceId,
													})
												}
												pending={deleteTopic.isPending}
												topic={topic}
												workspaceId={workspaceId}
											/>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</ListFrame>

			<DetailSheet
				description={selected?.id}
				onClose={() => select(undefined)}
				open={selected !== null}
				title={selected?.name ?? "Topic"}
			>
				{selected ? (
					<>
						{selected.description ? (
							<p className="text-muted-foreground text-sm">
								{selected.description}
							</p>
						) : null}
						<div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b pb-5">
							<DetailField label="Type">
								{selected.isReserved ? "Reserved (platform)" : "Custom"}
							</DetailField>
							<DetailField label="Created">
								<RelativeTime value={selected.createdAt} />
							</DetailField>
						</div>

						<section aria-label="Subscriptions" className="space-y-3">
							<div className="flex items-center justify-between gap-2">
								<h3 className="font-medium text-sm">Subscriptions</h3>
								<CreateSubscriptionDialog
									topicRef={selected.name}
									workspaceId={workspaceId}
								/>
							</div>
							<SubscriptionsList
								topicRef={selected.name}
								workspaceId={workspaceId}
							/>
						</section>

						<div className="flex flex-wrap gap-2 border-t pt-5">
							<Button
								render={
									<Link
										search={{ topic: selected.name, event: undefined }}
										to="/events/recent"
									/>
								}
								size="sm"
								variant="outline"
							>
								View recent events
							</Button>
							{!selected.isReserved && (
								<DeleteTopicButton
									labelled
									onDelete={() =>
										workspaceId &&
										deleteTopic.mutate({
											topicRef: selected.name,
											workspaceId,
										})
									}
									pending={deleteTopic.isPending}
									topic={selected}
									workspaceId={workspaceId}
								/>
							)}
						</div>
					</>
				) : null}
			</DetailSheet>
		</Page>
	);
}

function DeleteTopicButton({
	topic,
	workspaceId,
	pending,
	labelled = false,
	onDelete,
}: {
	topic: EventTopic;
	workspaceId?: string;
	pending: boolean;
	labelled?: boolean;
	onDelete: () => void;
}) {
	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={
					labelled ? (
						<Button
							disabled={!workspaceId || pending}
							size="sm"
							variant="destructive-outline"
						>
							<Trash2 className="size-4" />
							Delete topic
						</Button>
					) : (
						<Button
							aria-label={`Delete topic ${topic.name}`}
							disabled={!workspaceId || pending}
							size="icon-sm"
							variant="ghost"
						>
							<Trash2 className="size-4" />
						</Button>
					)
				}
			/>
			<AlertDialogPopup>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {topic.name}?</AlertDialogTitle>
					<AlertDialogDescription>
						This permanently deletes “{topic.name}”, its subscriptions, and
						published events.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogClose render={<Button variant="ghost">Cancel</Button>} />
					<Button
						disabled={!workspaceId || pending}
						onClick={onDelete}
						variant="destructive"
					>
						Delete
					</Button>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}
