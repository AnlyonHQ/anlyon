import {
	ChevronLeft,
	ChevronRight,
	ChevronsLeft,
	ChevronsRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

interface LogsPaginationProps {
	page: number;
	limit: number;
	total: number;
	totalPages: number;
	hasMore: boolean;
	onPageChange: (page: number) => void;
	onLimitChange: (limit: number) => void;
}

export function LogsPagination({
	page,
	limit,
	total,
	totalPages,
	hasMore,
	onPageChange,
	onLimitChange,
}: LogsPaginationProps) {
	const canGoPrevious = page > 1;
	const canGoNext = hasMore || page < totalPages;

	return (
		<div className="flex flex-wrap items-center justify-between gap-3 px-1 py-2">
			<div className="text-sm text-muted-foreground">
				Showing {(page - 1) * limit + 1} - {Math.min(page * limit, total)} of{" "}
				{total.toLocaleString()} logs
			</div>
			<div className="flex flex-wrap items-center gap-x-6 gap-y-2 lg:gap-x-8">
				<div className="flex items-center space-x-2">
					<p className="whitespace-nowrap text-muted-foreground text-sm">
						Per page
					</p>
					<Select
						value={limit.toString()}
						onValueChange={(value) => {
							if (value) {
								onLimitChange(parseInt(value, 10));
							}
						}}
					>
						<SelectTrigger className="h-8 w-[70px]">
							<SelectValue />
						</SelectTrigger>
						<SelectPopup>
							{[25, 50, 100].map((pageSize) => (
								<SelectItem key={pageSize} value={pageSize.toString()}>
									{pageSize}
								</SelectItem>
							))}
						</SelectPopup>
					</Select>
				</div>
				<div className="flex w-[100px] items-center justify-center text-sm tabular-nums">
					Page {page} of {totalPages || 1}
				</div>
				<div className="flex items-center space-x-2">
					<Button
						variant="outline"
						size="icon"
						className="hidden size-8 lg:flex"
						onClick={() => onPageChange(1)}
						disabled={!canGoPrevious}
					>
						<span className="sr-only">Go to first page</span>
						<ChevronsLeft className="h-4 w-4" />
					</Button>
					<Button
						variant="outline"
						size="icon"
						className="size-8"
						onClick={() => onPageChange(page - 1)}
						disabled={!canGoPrevious}
					>
						<span className="sr-only">Go to previous page</span>
						<ChevronLeft className="h-4 w-4" />
					</Button>
					<Button
						variant="outline"
						size="icon"
						className="size-8"
						onClick={() => onPageChange(page + 1)}
						disabled={!canGoNext}
					>
						<span className="sr-only">Go to next page</span>
						<ChevronRight className="h-4 w-4" />
					</Button>
					<Button
						variant="outline"
						size="icon"
						className="hidden size-8 lg:flex"
						onClick={() => onPageChange(totalPages)}
						disabled={!canGoNext}
					>
						<span className="sr-only">Go to last page</span>
						<ChevronsRight className="h-4 w-4" />
					</Button>
				</div>
			</div>
		</div>
	);
}
