import { ChevronDown, ChevronUp, RotateCcw, Search, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { LogFilters } from "@/lib/types";

interface LogsFiltersProps {
	filters: LogFilters;
	onChange: (filters: LogFilters) => void;
	onReset: () => void;
}

const MESSAGE_STATUSES = [
	"CREATED",
	"ACTIVE",
	"PROCESSING",
	"SUCCESS",
	"ERROR",
	"RETRY",
];

const HTTP_STATUS_GROUPS = [
	{ label: "2xx Success", values: [200, 201, 202, 204] },
	{ label: "4xx Client Error", values: [400, 401, 403, 404, 422, 429] },
	{ label: "5xx Server Error", values: [500, 502, 503, 504] },
];

const DATE_PRESETS = [
	{ label: "Last hour", value: "1h" },
	{ label: "Last 24 hours", value: "24h" },
	{ label: "Last 7 days", value: "7d" },
	{ label: "Last 30 days", value: "30d" },
	{ label: "Custom", value: "custom" },
];

export function LogsFilters({ filters, onChange, onReset }: LogsFiltersProps) {
	const [isExpanded, setIsExpanded] = useState(false);
	const [datePreset, setDatePreset] = useState<string | null>(null);

	const activeFilterCount = [
		filters.type !== "all",
		filters.status.length > 0,
		filters.httpStatus.length > 0,
		filters.dateRange.start || filters.dateRange.end,
		filters.duration.min !== undefined || filters.duration.max !== undefined,
		filters.url,
		filters.messageId,
		filters.errorCode,
		filters.search,
	].filter(Boolean).length;

	const availableStatuses = MESSAGE_STATUSES;

	const toggleStatus = (status: string) => {
		const newStatuses = filters.status.includes(status)
			? filters.status.filter((s) => s !== status)
			: [...filters.status, status];
		onChange({ ...filters, status: newStatuses, page: 1 });
	};

	const toggleHttpStatus = (httpStatus: number) => {
		const newHttpStatuses = filters.httpStatus.includes(httpStatus)
			? filters.httpStatus.filter((s) => s !== httpStatus)
			: [...filters.httpStatus, httpStatus];
		onChange({ ...filters, httpStatus: newHttpStatuses, page: 1 });
	};

	const applyDatePreset = (preset: string) => {
		setDatePreset(preset);
		if (preset === "custom") return;

		const now = new Date();
		let start: Date;

		switch (preset) {
			case "1h":
				start = new Date(now.getTime() - 60 * 60 * 1000);
				break;
			case "24h":
				start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
				break;
			case "7d":
				start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
				break;
			case "30d":
				start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
				break;
			default:
				return;
		}

		onChange({
			...filters,
			dateRange: {
				start: start.toISOString(),
				end: now.toISOString(),
			},
			page: 1,
		});
	};

	const handleSearchChange = (value: string) => {
		onChange({ ...filters, search: value, page: 1 });
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-3">
				<div className="relative flex-1">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					<Input
						placeholder="Search logs by error message or response body"
						value={filters.search}
						onChange={(e) => handleSearchChange(e.target.value)}
						className="pl-10"
					/>
				</div>

				<Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
					<CollapsibleTrigger
						render={
							<Button variant="outline" className="gap-2">
								Filters
								{activeFilterCount > 0 && (
									<Badge variant="secondary" size="sm">
										{activeFilterCount}
									</Badge>
								)}
								{isExpanded ? (
									<ChevronUp className="h-4 w-4 pt-1" />
								) : (
									<ChevronDown className="h-4 w-4 pt-1" />
								)}
							</Button>
						}
					/>
				</Collapsible>

				{activeFilterCount > 0 && (
					<Button variant="ghost" size="sm" onClick={onReset} className="gap-1">
						<RotateCcw className="h-3 w-3" />
						Reset
					</Button>
				)}
			</div>

			<Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
				<CollapsiblePanel>
					<div className="rounded-lg border border-border/40 bg-muted/20 p-4 space-y-4">
						<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
							<Field>
								<FieldLabel>Log type</FieldLabel>
								<Select
									value={filters.type}
									onValueChange={(value) => {
										if (value && (value === "all" || value === "message")) {
											onChange({
												...filters,
												type: value,
												status: [],
												page: 1,
											});
										}
									}}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectPopup>
										<SelectItem value="all">All logs</SelectItem>
										<SelectItem value="message">Message executions</SelectItem>
									</SelectPopup>
								</Select>
							</Field>

							<Field>
								<FieldLabel>Status</FieldLabel>
								<Popover>
									<PopoverTrigger
										render={
											<Button
												variant="outline"
												className="w-full justify-between"
											>
												<span className="truncate">
													{filters.status.length === 0
														? "All statuses"
														: `${filters.status.length} selected`}
												</span>
												<ChevronDown className="h-4 w-4 opacity-50" />
											</Button>
										}
									/>
									<PopoverPopup className="w-56">
										<div className="space-y-2">
											{availableStatuses.map((status) => (
												<label
													key={status}
													className="flex items-center gap-2 cursor-pointer"
												>
													<input
														type="checkbox"
														checked={filters.status.includes(status)}
														onChange={() => toggleStatus(status)}
														className="rounded border-border"
													/>
													<Badge
														variant={
															status === "SUCCESS"
																? "success"
																: status === "ERROR" || status === "FAILED"
																	? "destructive"
																	: status === "RETRY"
																		? "warning"
																		: "secondary"
														}
														size="sm"
													>
														{status}
													</Badge>
												</label>
											))}
										</div>
									</PopoverPopup>
								</Popover>
							</Field>

							{(filters.type === "all" || filters.type === "message") && (
								<Field>
									<FieldLabel>HTTP status</FieldLabel>
									<Popover>
										<PopoverTrigger
											render={
												<Button
													variant="outline"
													className="w-full justify-between"
												>
													<span className="truncate">
														{filters.httpStatus.length === 0
															? "All HTTP codes"
															: `${filters.httpStatus.length} selected`}
													</span>
													<ChevronDown className="h-4 w-4 opacity-50" />
												</Button>
											}
										/>
										<PopoverPopup className="w-64">
											<div className="space-y-3">
												{HTTP_STATUS_GROUPS.map((group) => (
													<div key={group.label}>
														<div className="text-xs font-medium text-muted-foreground mb-1">
															{group.label}
														</div>
														<div className="flex flex-wrap gap-1">
															{group.values.map((code) => (
																<Badge
																	key={code}
																	variant={
																		filters.httpStatus.includes(code)
																			? "default"
																			: "outline"
																	}
																	size="sm"
																	className="cursor-pointer"
																	onClick={() => toggleHttpStatus(code)}
																>
																	{code}
																</Badge>
															))}
														</div>
													</div>
												))}
											</div>
										</PopoverPopup>
									</Popover>
								</Field>
							)}
						</div>

						<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
							<Field className="md:col-span-2">
								<FieldLabel>Date range</FieldLabel>
								<div className="flex items-center gap-2">
									<div className="flex flex-wrap gap-1">
										{DATE_PRESETS.map((preset) => (
											<Badge
												key={preset.value}
												variant={
													datePreset === preset.value ? "default" : "outline"
												}
												size="sm"
												className="cursor-pointer"
												onClick={() => applyDatePreset(preset.value)}
											>
												{preset.label}
											</Badge>
										))}
									</div>
									{datePreset === "custom" && (
										<div className="flex items-center gap-2">
											<Input
												type="datetime-local"
												value={filters.dateRange.start?.slice(0, 16) || ""}
												onChange={(e) =>
													onChange({
														...filters,
														dateRange: {
															...filters.dateRange,
															start: e.target.value
																? new Date(e.target.value).toISOString()
																: undefined,
														},
														page: 1,
													})
												}
												className="w-auto"
											/>
											<span className="text-muted-foreground">to</span>
											<Input
												type="datetime-local"
												value={filters.dateRange.end?.slice(0, 16) || ""}
												onChange={(e) =>
													onChange({
														...filters,
														dateRange: {
															...filters.dateRange,
															end: e.target.value
																? new Date(e.target.value).toISOString()
																: undefined,
														},
														page: 1,
													})
												}
												className="w-auto"
											/>
										</div>
									)}
									{(filters.dateRange.start || filters.dateRange.end) && (
										<Button
											variant="ghost"
											size="sm"
											onClick={() => {
												setDatePreset(null);
												onChange({
													...filters,
													dateRange: {},
													page: 1,
												});
											}}
										>
											<X className="h-3 w-3" />
										</Button>
									)}
								</div>
							</Field>

							<Field>
								<FieldLabel>Duration (ms)</FieldLabel>
								<div className="flex items-center gap-2">
									<Input
										type="number"
										placeholder="Min"
										value={filters.duration.min ?? ""}
										onChange={(e) =>
											onChange({
												...filters,
												duration: {
													...filters.duration,
													min: e.target.value
														? parseInt(e.target.value, 10)
														: undefined,
												},
												page: 1,
											})
										}
										className="w-24"
									/>
									<span className="text-muted-foreground">-</span>
									<Input
										type="number"
										placeholder="Max"
										value={filters.duration.max ?? ""}
										onChange={(e) =>
											onChange({
												...filters,
												duration: {
													...filters.duration,
													max: e.target.value
														? parseInt(e.target.value, 10)
														: undefined,
												},
												page: 1,
											})
										}
										className="w-24"
									/>
								</div>
							</Field>
						</div>

						<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
							<Field>
								<FieldLabel>Message ID</FieldLabel>
								<Input
									placeholder="msg_"
									value={filters.messageId}
									onChange={(e) =>
										onChange({ ...filters, messageId: e.target.value, page: 1 })
									}
								/>
							</Field>

							<Field>
								<FieldLabel>URL (partial)</FieldLabel>
								<Input
									placeholder="https://"
									value={filters.url}
									onChange={(e) =>
										onChange({ ...filters, url: e.target.value, page: 1 })
									}
								/>
							</Field>
						</div>
					</div>
				</CollapsiblePanel>
			</Collapsible>
		</div>
	);
}
