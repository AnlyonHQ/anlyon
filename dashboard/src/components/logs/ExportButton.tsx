import { FileJson, FileSpreadsheet } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { exportLogs } from "@/hooks/api/use-logs";
import type { LogFilters } from "@/lib/types";

interface ExportButtonProps {
	workspaceId: string;
	filters: Partial<LogFilters>;
	disabled?: boolean;
}

export function ExportButton({
	workspaceId,
	filters,
	disabled,
}: ExportButtonProps) {
	const [isExporting, setIsExporting] = useState(false);
	const [isOpen, setIsOpen] = useState(false);

	const handleExport = async (format: "csv" | "json") => {
		setIsExporting(true);
		try {
			const { url, filename } = await exportLogs(workspaceId, filters, format);

			const link = document.createElement("a");
			link.href = url;
			link.download = filename;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);

			URL.revokeObjectURL(url);

			toast.success(`Logs exported as ${format.toUpperCase()}.`);
			setIsOpen(false);
		} catch (error) {
			toast.error("Failed to export logs.");
		} finally {
			setIsExporting(false);
		}
	};

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen}>
			<PopoverTrigger
				render={
					<Button
						variant="outline"
						disabled={disabled || isExporting}
						loading={isExporting}
						className="gap-2"
					>
						Export
					</Button>
				}
			/>
			<PopoverPopup className="w-48">
				<div className="space-y-1">
					<button
						type="button"
						onClick={() => handleExport("csv")}
						disabled={isExporting}
						className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-muted transition-colors duration-150 disabled:opacity-50"
					>
						<FileSpreadsheet className="h-4 w-4" />
						Export as CSV
					</button>
					<button
						type="button"
						onClick={() => handleExport("json")}
						disabled={isExporting}
						className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-muted transition-colors duration-150 disabled:opacity-50"
					>
						<FileJson className="h-4 w-4" />
						Export as JSON
					</button>
				</div>
			</PopoverPopup>
		</Popover>
	);
}
