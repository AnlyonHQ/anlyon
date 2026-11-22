import { createFileRoute } from "@tanstack/react-router";
import {
	AlertTriangle,
	Eye,
	MoreHorizontal,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from "@/components/ui/frame";
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
import {
	useClearDlq,
	useDeleteDlqMessage,
	useDlqMessages,
	useDlqStats,
	useRetryAllDlqMessages,
	useRetryDlqMessage,
} from "@/hooks/api/use-dlq";
import { requireFeature } from "@/lib/feature-flags";
import { isEventDeliveryMessage } from "@/lib/messages";
import type { Message } from "@/lib/types";

export const Route = createFileRoute("/_protected/dlq")({
	beforeLoad: () => requireFeature("dlq"),
	component: DlqPage,
});

function DlqPage() {
	const { currentWorkspace } = useWorkspace();
	const [page, setPage] = useState(1);
	const [clearDialogOpen, setClearDialogOpen] = useState(false);
	const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
	const [messageToDelete, setMessageToDelete] = useState<Message | null>(null);
	const [retryDialogOpen, setRetryDialogOpen] = useState(false);
	const [messageToRetry, setMessageToRetry] = useState<Message | null>(null);
	const [retryAllDialogOpen, setRetryAllDialogOpen] = useState(false);

	const { data: stats } = useDlqStats(currentWorkspace?.id);
	const { data, isLoading } = useDlqMessages(currentWorkspace?.id, page, 20);
	const retryMutation = useRetryDlqMessage();
	const retryAllMutation = useRetryAllDlqMessages();
	const deleteMutation = useDeleteDlqMessage();
	const clearMutation = useClearDlq();

	const handleRetry = (messageId: string) => {
		if (!currentWorkspace?.id) return;
		retryMutation.mutate({
			messageId,
			workspaceId: currentWorkspace.id,
		});
		setRetryDialogOpen(false);
		setMessageToRetry(null);
	};

	const handleRetryClick = (message: Message) => {
		setMessageToRetry(message);
		setRetryDialogOpen(true);
	};

	const handleDelete = (messageId: string) => {
		if (!currentWorkspace?.id) return;
		deleteMutation.mutate({
			messageId,
			workspaceId: currentWorkspace.id,
		});
		setDeleteDialogOpen(false);
		setMessageToDelete(null);
		if (selectedMessage?.messageId === messageId) {
			setSelectedMessage(null);
		}
	};

	const handleDeleteClick = (message: Message) => {
		setMessageToDelete(message);
		setDeleteDialogOpen(true);
	};

	const handleRetryAll = () => {
		if (!currentWorkspace?.id) return;
		retryAllMutation.mutate(currentWorkspace.id);
		setRetryAllDialogOpen(false);
	};

	const handleClearAll = () => {
		if (!currentWorkspace?.id) return;
		clearMutation.mutate(currentWorkspace.id);
		setClearDialogOpen(false);
	};

	return (
		<div className="space-y-6">

			<Frame className="w-full overflow-hidden">
				<FrameHeader>
					<FrameTitle>Failed messages</FrameTitle>
					<FrameDescription>
						Messages that exhausted all retry attempts.
					</FrameDescription>
				</FrameHeader>
				<FramePanel className="p-0">
					{isLoading ? (
						<div className="space-y-3 p-6">
							{[1, 2, 3, 4, 5].map((i) => (
								<Skeleton key={i} className="h-16 w-full rounded-lg" />
							))}
						</div>
					) : data?.data && data.data.length > 0 ? (
						<>
							<div className="overflow-x-auto">
								<Table>
									<TableHeader>
										<TableRow className="border-b border-border/60">
											<TableHead>Message ID</TableHead>
											<TableHead>URL</TableHead>
											<TableHead>Method</TableHead>
											<TableHead>Last error</TableHead>
											<TableHead>Attempts</TableHead>
											<TableHead>Failed at</TableHead>
											<TableHead className="text-right">Actions</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.data.map((message) => (
											<TableRow
												key={message.messageId}
												className="border-b border-border/40"
											>
												<TableCell>
													<div className="flex flex-wrap items-center gap-1.5">
														<code className="px-2 py-1 rounded-md bg-muted/50 text-xs font-mono border border-border/40">
															{message.messageId.slice(0, 8)}…
														</code>
														{isEventDeliveryMessage(message) && (
															<Badge
																variant="soft"
																size="sm"
																className="shrink-0"
																title="Failed event fan-out delivery"
															>
																Event delivery
															</Badge>
														)}
													</div>
												</TableCell>
												<TableCell className="max-w-xs">
													<span className="truncate block text-sm">
														{message.url}
													</span>
												</TableCell>
												<TableCell>
													<Badge
														variant="outline"
														className="font-mono font-medium"
													>
														{message.method}
													</Badge>
												</TableCell>
												<TableCell className="max-w-xs">
													<span className="truncate block text-sm text-destructive">
														{message.errorMessage || "Unknown error"}
													</span>
												</TableCell>
												<TableCell className="text-sm">
													<span className="font-medium">
														{message.attempts}
													</span>
													<span className="text-muted-foreground">
														/{message.maxRetries}
													</span>
												</TableCell>
												<TableCell className="text-sm text-muted-foreground">
													{message.failedAt
														? new Date(message.failedAt).toLocaleString()
														: new Date(message.updatedAt).toLocaleString()}
												</TableCell>
												<TableCell className="text-right">
													<DropdownMenu>
														<DropdownMenuTrigger asChild>
															<Button variant="ghost" size="icon">
																<MoreHorizontal />
															</Button>
														</DropdownMenuTrigger>
														<DropdownMenuContent align="end">
															<DropdownMenuLabel>Actions</DropdownMenuLabel>
															<DropdownMenuSeparator />
															<DropdownMenuItem
																onClick={() => setSelectedMessage(message)}
															>
																<Eye />
																View details
															</DropdownMenuItem>
															<DropdownMenuItem
																variant="default"
																onClick={() => handleRetryClick(message)}
																disabled={retryMutation.isPending}
															>
																<RotateCcw />
																Retry message
															</DropdownMenuItem>
															<DropdownMenuSeparator />
															<DropdownMenuItem
																variant="destructive"
																onClick={() => handleDeleteClick(message)}
																disabled={deleteMutation.isPending}
															>
																<Trash2 />
																Delete message
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
							{data.pagination && data.pagination.totalPages > 1 && (
								<div className="mt-4 px-6 pb-6 flex items-center justify-between border-t border-border/40 pt-4">
									<p className="text-sm text-muted-foreground font-medium">
										Page {data.pagination.page} of {data.pagination.totalPages}
									</p>
									<div className="flex gap-2">
										<Button
											variant="outline"
											size="sm"
											onClick={() => setPage((p) => Math.max(1, p - 1))}
											disabled={page === 1}
											className="font-medium"
											aria-label={`Go to page ${page - 1} of ${data.pagination.totalPages}`}
										>
											Previous
										</Button>
										<Button
											variant="outline"
											size="sm"
											onClick={() => setPage((p) => p + 1)}
											disabled={page >= data.pagination.totalPages}
											className="font-medium"
											aria-label={`Go to page ${page + 1} of ${data.pagination.totalPages}`}
										>
											Next
										</Button>
									</div>
								</div>
							)}
						</>
					) : (
						<div className="flex flex-col items-center justify-center py-16">
							<p className="text-sm font-medium text-muted-foreground mb-1">
								No failed messages
							</p>
							<p className="text-xs text-muted-foreground/80">
								Messages that exhaust all retries appear here.
							</p>
						</div>
					)}
				</FramePanel>
			</Frame>

			<AlertDialog open={retryDialogOpen} onOpenChange={setRetryDialogOpen}>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>Retry message?</AlertDialogTitle>
						<AlertDialogDescription>
							Re-queue message
							{messageToRetry && ` ${messageToRetry.messageId.slice(0, 8)}…`}{" "}
							for delivery.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<AlertDialogClose
							render={<Button loading={retryMutation.isPending} />}
							onClick={() =>
								messageToRetry && handleRetry(messageToRetry.messageId)
							}
						>
							Retry message
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>

			<AlertDialog
				open={retryAllDialogOpen}
				onOpenChange={setRetryAllDialogOpen}
			>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>Retry all messages?</AlertDialogTitle>
						<AlertDialogDescription>
							Re-queue all {stats?.totalMessages || 0} failed messages for
							delivery.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<AlertDialogClose
							render={<Button loading={retryAllMutation.isPending} />}
							onClick={handleRetryAll}
						>
							Retry all
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>

			<AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2">
							<AlertTriangle className="h-5 w-5 text-destructive" />
							Clear dead letter queue?
						</AlertDialogTitle>
						<AlertDialogDescription>
							Delete all {stats?.totalMessages || 0} failed messages. This can't
							be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<AlertDialogClose
							render={
								<Button
									variant="destructive"
									loading={clearMutation.isPending}
								/>
							}
							onClick={handleClearAll}
						>
							Clear all
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>

			<AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete message?</AlertDialogTitle>
						<AlertDialogDescription>
							Delete message
							{messageToDelete && ` ${messageToDelete.messageId.slice(0, 8)}…`}.
							This can't be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<AlertDialogClose
							render={
								<Button
									variant="destructive"
									loading={deleteMutation.isPending}
								/>
							}
							onClick={() =>
								messageToDelete && handleDelete(messageToDelete.messageId)
							}
						>
							Delete
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>

			<Dialog
				open={!!selectedMessage}
				onOpenChange={(open) => !open && setSelectedMessage(null)}
			>
				<DialogPopup className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>Message details</DialogTitle>
						<DialogDescription>Failed message information.</DialogDescription>
					</DialogHeader>
					{selectedMessage && (
						<DialogPanel className="space-y-4">
							<div className="grid grid-cols-2 gap-4">
								<div>
									<p className="text-xs text-muted-foreground mb-1">
										Message ID
									</p>
									<div className="flex flex-wrap items-center gap-1.5">
										<code className="text-sm font-mono">
											{selectedMessage.messageId}
										</code>
										{isEventDeliveryMessage(selectedMessage) && (
											<Badge variant="soft" size="sm">
												Event delivery
											</Badge>
										)}
									</div>
								</div>
								<div>
									<p className="text-xs text-muted-foreground mb-1">Status</p>
									<Badge variant="destructive">{selectedMessage.status}</Badge>
								</div>
								<div>
									<p className="text-xs text-muted-foreground mb-1">Method</p>
									<Badge variant="outline">{selectedMessage.method}</Badge>
								</div>
								<div>
									<p className="text-xs text-muted-foreground mb-1">Attempts</p>
									<span className="text-sm">
										{selectedMessage.attempts}/{selectedMessage.maxRetries}
									</span>
								</div>
							</div>

							{isEventDeliveryMessage(selectedMessage) && (
								<p className="text-xs text-muted-foreground">
									This is a failed event fan-out delivery. Inspect deliveries on
									the Events page for topic-level context.
								</p>
							)}

							<div>
								<p className="text-xs text-muted-foreground mb-1">URL</p>
								<code className="text-sm font-mono break-all">
									{selectedMessage.url}
								</code>
							</div>

							{selectedMessage.errorMessage && (
								<div>
									<p className="text-xs text-muted-foreground mb-1">
										Last error
									</p>
									<div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
										{selectedMessage.errorMessage}
									</div>
								</div>
							)}

							{selectedMessage.body !== undefined &&
								selectedMessage.body !== null && (
									<div>
										<p className="text-xs text-muted-foreground mb-1">Body</p>
										<pre className="rounded-md bg-muted p-3 text-xs overflow-auto max-h-48">
											{JSON.stringify(selectedMessage.body, null, 2)}
										</pre>
									</div>
								)}
						</DialogPanel>
					)}
					<DialogFooter>
						<DialogClose render={<Button variant="ghost" />}>Close</DialogClose>
						{selectedMessage && (
							<>
								<Button
									onClick={() => {
										handleRetryClick(selectedMessage);
										setSelectedMessage(null);
									}}
									disabled={retryMutation.isPending}
								>
									Retry message
								</Button>
								<Button
									variant="destructive"
									onClick={() => handleDeleteClick(selectedMessage)}
									disabled={deleteMutation.isPending}
								>
									Delete
								</Button>
							</>
						)}
					</DialogFooter>
				</DialogPopup>
			</Dialog>
		</div>
	);
}
