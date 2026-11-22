import { History, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "@/components/ui/dialog";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import type { ApiKeyHistoryEntry } from "@/lib/types";

export interface ApiKeyHistoryDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	apiKeyName: string;
	history: ApiKeyHistoryEntry[] | undefined;
	rollbackWindowMinutes: number | null | undefined;
	isLoading: boolean;
	getRollbackTimeRemaining: (expiresAt: string) => string;
	onClose: () => void;
	onRollback: () => void;
}

export function ApiKeyHistoryDialog({
	open,
	onOpenChange,
	apiKeyName,
	history,
	rollbackWindowMinutes,
	isLoading,
	getRollbackTimeRemaining,
	onClose,
	onRollback,
}: ApiKeyHistoryDialogProps) {
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => (!o ? onClose() : onOpenChange(o))}
		>
			<DialogPopup className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>API Key History</DialogTitle>
					<DialogDescription>
						Regeneration history for &quot;{apiKeyName}&quot; with rollback
						availability.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					{isLoading ? (
						<div className="space-y-2">
							<Skeleton className="h-16 w-full" />
							<Skeleton className="h-16 w-full" />
							<Skeleton className="h-16 w-full" />
						</div>
					) : history && history.length > 0 ? (
						<div className="space-y-4">
							{rollbackWindowMinutes != null && (
								<div className="text-sm text-muted-foreground">
									Rollback window: {rollbackWindowMinutes} minutes
								</div>
							)}
							<div className="max-h-80 space-y-3 overflow-y-auto">
								{history.map((entry, index) => (
									<div
										key={entry.id}
										className={`rounded-lg border p-3 ${
											index === 0 ? "border-primary bg-primary/5" : ""
										}`}
									>
										<div className="flex items-center justify-between">
											<div>
												<div className="flex items-center gap-2">
													<span className="text-sm font-medium">
														Version {entry.version}
													</span>
													{index === 0 && (
														<Badge variant="default" className="text-xs">
															Current
														</Badge>
													)}
													{entry.rollbackAvailable && index !== 0 && (
														<Badge variant="secondary" className="text-xs">
															Rollback Available
														</Badge>
													)}
												</div>
												<div className="mt-1 font-mono text-xs text-muted-foreground">
													{entry.keyPrefix}••••••••
												</div>
												<div className="mt-1 text-xs text-muted-foreground">
													Created <RelativeTime value={entry.createdAt} />
												</div>
												{entry.expiredAt && (
													<div className="text-xs text-muted-foreground">
														Expired <RelativeTime value={entry.expiredAt} />
													</div>
												)}
												{entry.rollbackAvailable && entry.rollbackExpiresAt && (
													<div className="mt-1 text-xs text-info">
														Rollback expires:{" "}
														{getRollbackTimeRemaining(entry.rollbackExpiresAt)}
													</div>
												)}
											</div>
											{entry.rollbackAvailable && index !== 0 && (
												<Button
													variant="outline"
													size="sm"
													onClick={onRollback}
												>
													<RotateCcw className="mr-2 h-4 w-4" />
													Rollback
												</Button>
											)}
										</div>
									</div>
								))}
							</div>
						</div>
					) : (
						<div className="py-8 text-center">
							<History className="mx-auto mb-3 h-12 w-12 text-muted-foreground/50" />
							<p className="mb-2 text-sm text-muted-foreground">
								No history available
							</p>
							<p className="text-xs text-muted-foreground">
								History will appear here after regenerating the API key.
							</p>
						</div>
					)}
				</DialogPanel>
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Close
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
