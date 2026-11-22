import {
	AlertCircle,
	Calendar,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	Clock,
	Copy,
	Timer,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { LogSortBy, LogSortOrder, UnifiedLogEntry } from "@/lib/types";
import { copyToClipboard as copyToClipboardUtil } from "@/lib/utils";

interface LogsTableProps {
	logs: UnifiedLogEntry[];
	isLoading: boolean;
	sortBy: LogSortBy;
	sortOrder: LogSortOrder;
	onSort: (sortBy: LogSortBy, sortOrder: LogSortOrder) => void;
}

function StatusBadge({ status }: { status: string }) {
	const variants: Record<
		string,
		"default" | "secondary" | "error" | "success" | "warning"
	> = {
		CREATED: "secondary",
		ACTIVE: "secondary",
		PROCESSING: "secondary",
		SUCCESS: "success",
		ERROR: "error",
		FAILED: "error",
		RETRY: "warning",
		STARTED: "secondary",
	};

	return (
		<Badge variant={variants[status] || "secondary"} size="sm">
			{status}
		</Badge>
	);
}

function HttpStatusBadge({ status }: { status: number | null | undefined }) {
	if (!status) return <span className="text-muted-foreground">-</span>;

	let variant: "secondary" | "success" | "warning" | "error" = "secondary";
	if (status >= 200 && status < 300) variant = "success";
	else if (status >= 400 && status < 500) variant = "warning";
	else if (status >= 500) variant = "error";

	return (
		<Badge variant={variant} size="sm" className="font-mono">
			{status}
		</Badge>
	);
}

function DurationDisplay({
	duration,
}: {
	duration: number | null | undefined;
}) {
	if (!duration) return <span className="text-muted-foreground">-</span>;

	let color = "text-success";
	if (duration > 1000) color = "text-warning";
	if (duration > 5000) color = "text-destructive";

	return <span className={`font-mono text-sm ${color}`}>{duration}ms</span>;
}

function TypeBadge({ type }: { type: UnifiedLogEntry["type"] }) {
	return (
		<Badge variant="outline" size="sm">
			{type === "message" ? "MSG" : "SCH"}
		</Badge>
	);
}

function SortableHeader({
	label,
	sortKey,
	currentSortBy,
	currentSortOrder,
	onSort,
}: {
	label: string;
	sortKey: LogSortBy;
	currentSortBy: LogSortBy;
	currentSortOrder: LogSortOrder;
	onSort: (sortBy: LogSortBy, sortOrder: LogSortOrder) => void;
}) {
	const isActive = currentSortBy === sortKey;

	const handleClick = () => {
		if (isActive) {
			onSort(sortKey, currentSortOrder === "asc" ? "desc" : "asc");
		} else {
			onSort(sortKey, "desc");
		}
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			className="flex items-center gap-1 hover:text-foreground transition-colors"
		>
			{label}
			{isActive ? (
				currentSortOrder === "asc" ? (
					<ChevronUp className="h-3 w-3" />
				) : (
					<ChevronDown className="h-3 w-3" />
				)
			) : (
				<ChevronDown className="h-3 w-3 opacity-30" />
			)}
		</button>
	);
}

function CopyIdButton({ id }: { id: string }) {
	const copyToClipboard = async () => {
		const result = await copyToClipboardUtil(id);
		if (result.success) {
			toast.success("Copied to clipboard");
		} else {
			toast.error(result.error || "Failed to copy");
		}
	};

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								copyToClipboard();
							}}
							className="rounded-md p-1 opacity-0 transition-opacity duration-150 ease-out hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100"
						>
							<Copy className="h-3 w-3" />
						</button>
					}
				/>
				<TooltipContent>Copy ID</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

function LogRow({ log }: { log: UnifiedLogEntry }) {
	const [isExpanded, setIsExpanded] = useState(false);

	const getStatusIcon = (status: string) => {
		switch (status) {
			case "SUCCESS":
				return <CheckCircle2 className="h-4 w-4 text-success" />;
			case "ERROR":
			case "FAILED":
				return <XCircle className="h-4 w-4 text-destructive" />;
			case "RETRY":
				return <AlertCircle className="h-4 w-4 text-warning" />;
			default:
				return <Clock className="h-4 w-4 text-muted-foreground" />;
		}
	};

	const formatTimestamp = (timestamp: string) => {
		const date = new Date(timestamp);
		return date.toLocaleString("en-US", {
			month: "short",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
	};

	const formatRelativeTime = (timestamp: string) => {
		const date = new Date(timestamp);
		const now = new Date();
		const diff = now.getTime() - date.getTime();

		if (diff < 60000) return "Just now";
		if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
		if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
		return `${Math.floor(diff / 86400000)}d ago`;
	};

	return (
		<Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
			<div
				className={`border-b border-border/40 ${isExpanded ? "bg-muted/30" : "hover:bg-muted/20"} transition-colors`}
			>
				<CollapsibleTrigger
					render={
						<button type="button" className="w-full p-3 text-left">
							<div className="grid grid-cols-[140px_60px_1fr_140px_80px_80px_40px] gap-3 items-center">
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger
											render={
												<div className="flex items-center gap-2">
													<Calendar className="h-3 w-3 text-muted-foreground" />
													<span className="text-xs text-muted-foreground font-mono truncate">
														{formatRelativeTime(log.timestamp)}
													</span>
												</div>
											}
										/>
										<TooltipContent>
											{formatTimestamp(log.timestamp)}
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>

								<TypeBadge type={log.type} />

								<div className="group flex items-center gap-1 min-w-0">
									<code className="text-xs font-mono truncate text-muted-foreground">
										{log.entityId}
									</code>
									<CopyIdButton id={log.entityId} />
								</div>

								<div className="flex items-center gap-2 min-w-0">
									{getStatusIcon(log.status)}
									<StatusBadge status={log.status} />
								</div>

								<div className="flex items-center min-w-0">
									<HttpStatusBadge status={log.responseStatus} />
								</div>

								<div className="flex items-center min-w-0">
									<DurationDisplay duration={log.duration} />
								</div>

								{isExpanded ? (
									<ChevronDown className="h-4 w-4 text-muted-foreground" />
								) : (
									<ChevronRight className="h-4 w-4 text-muted-foreground" />
								)}
							</div>
						</button>
					}
				/>

				<CollapsiblePanel>
					<div className="px-4 pb-4 space-y-4 border-t border-border/40 pt-4 bg-muted/10">
						{log.type === "message" && (
							<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
								<div className="space-y-3">
									<h4 className="text-sm font-semibold">Request</h4>
									{log.requestUrl && (
										<div>
											<div className="text-xs text-muted-foreground mb-1">
												URL
											</div>
											<code className="text-xs font-mono bg-muted/50 px-2 py-1 rounded-md block break-all">
												{log.requestMethod && (
													<Badge variant="outline" size="sm" className="mr-2">
														{log.requestMethod}
													</Badge>
												)}
												{log.requestUrl}
											</code>
										</div>
									)}
									{log.requestBody != null && (
										<div>
											<div className="text-xs text-muted-foreground mb-1">
												Body
											</div>
											<pre className="text-xs font-mono bg-muted/50 p-2 rounded-lg overflow-auto max-h-32">
												{typeof log.requestBody === "string"
													? log.requestBody
													: JSON.stringify(
															log.requestBody as Record<string, unknown>,
															null,
															2,
														)}
											</pre>
										</div>
									)}
									{log.attemptNumber !== undefined &&
										log.attemptNumber !== null && (
											<div className="text-xs text-muted-foreground">
												Attempt #{log.attemptNumber}
											</div>
										)}
								</div>

								<div className="space-y-3">
									<h4 className="text-sm font-semibold">Response</h4>
									{log.responseStatus && (
										<div>
											<div className="text-xs text-muted-foreground mb-1">
												Status
											</div>
											<HttpStatusBadge status={log.responseStatus} />
										</div>
									)}
									{log.responseBody && (
										<div>
											<div className="text-xs text-muted-foreground mb-1">
												Body
											</div>
											<pre className="text-xs font-mono bg-muted/50 p-2 rounded-lg overflow-auto max-h-32">
												{log.responseBody}
											</pre>
										</div>
									)}
								</div>
							</div>
						)}

						{log.errorMessage && (
							<div>
								<div className="text-xs font-semibold text-destructive mb-1">
									Error
								</div>
								<div className="rounded-lg bg-destructive/10 p-3 text-destructive text-sm">
									{log.errorCode && (
										<Badge variant="error" size="sm" className="mr-2">
											{log.errorCode}
										</Badge>
									)}
									{log.errorMessage}
								</div>
							</div>
						)}

						{log.duration && (
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<Timer className="h-3 w-3" />
								Total duration: {log.duration}ms
							</div>
						)}
					</div>
				</CollapsiblePanel>
			</div>
		</Collapsible>
	);
}

export function LogsTable({
	logs,
	isLoading,
	sortBy,
	sortOrder,
	onSort,
}: LogsTableProps) {
	if (isLoading) {
		return (
			<div className="space-y-2">
				{[1, 2, 3, 4, 5].map((i) => (
					<Skeleton key={i} className="h-14 w-full rounded-lg" />
				))}
			</div>
		);
	}

	if (logs.length === 0) {
		return null;
	}

	return (
		<div className="min-w-[540px] overflow-hidden rounded-lg border border-border">
			<div className="grid grid-cols-[140px_60px_1fr_140px_80px_80px_40px] gap-3 items-center p-3 bg-muted/30 border-b border-border text-xs font-medium text-muted-foreground">
				<div className="min-w-0">
					<SortableHeader
						label="Time"
						sortKey="timestamp"
						currentSortBy={sortBy}
						currentSortOrder={sortOrder}
						onSort={onSort}
					/>
				</div>
				<div className="min-w-0">Type</div>
				<div className="min-w-0">ID</div>
				<div className="min-w-0">
					<SortableHeader
						label="Status"
						sortKey="status"
						currentSortBy={sortBy}
						currentSortOrder={sortOrder}
						onSort={onSort}
					/>
				</div>
				<div className="min-w-0">
					<SortableHeader
						label="HTTP"
						sortKey="httpStatus"
						currentSortBy={sortBy}
						currentSortOrder={sortOrder}
						onSort={onSort}
					/>
				</div>
				<div className="min-w-0">
					<SortableHeader
						label="Duration"
						sortKey="duration"
						currentSortBy={sortBy}
						currentSortOrder={sortOrder}
						onSort={onSort}
					/>
				</div>
				<div className="min-w-0"></div>
			</div>

			<div>
				{logs.map((log) => (
					<LogRow key={log.id} log={log} />
				))}
			</div>
		</div>
	);
}
