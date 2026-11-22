import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ListSearch } from "@/components/actions/list-search";
import { ListEmpty } from "@/components/governance/list-empty";
import { ListFrame, PageToolbar } from "@/components/layout/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
	type McpAdoptChoice,
	type McpAdoptResult,
	type McpUpstream,
	useAdoptMcpTools,
} from "@/hooks/api/use-mcp-upstreams";
import {
	filterRows,
	groupRows,
	groupSelectable,
	initialChoice,
	MAX_ADOPT,
	RISK_LABEL,
	RISK_MEANING,
	RISK_VARIANT,
	type ToolRow as Row,
	selectionSummary,
	type ToolFilter,
	type ToolGroup,
	toolRows,
} from "@/lib/mcp-servers";
import { ToolRow } from "./tool-row";

export const TOOLS_LIST_ID = "mcp-server-tools";

function GroupHeader({
	group,
	selection,
	canManage,
	onSelect,
}: {
	group: ToolGroup;
	selection: Record<string, McpAdoptChoice>;
	canManage: boolean;
	onSelect: (rows: Row[], on: boolean) => void;
}) {
	const selectable = groupSelectable(group.rows);
	const allOn =
		selectable.length > 0 &&
		selectable.every((row) => selection[row.name] !== undefined);
	const label =
		group.key === "gone" ? "No longer listed" : RISK_LABEL[group.key];
	return (
		<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b bg-muted/50 px-3.5 py-1.5">
			<Badge
				size="sm"
				variant={group.key === "gone" ? "error" : RISK_VARIANT[group.key]}
			>
				{label}
			</Badge>
			<span className="min-w-0 flex-1 basis-48 text-muted-foreground text-xs">
				{group.key === "gone"
					? "Adopted tools the server has dropped. Calls to them are refused."
					: RISK_MEANING[group.key]}
			</span>
			{canManage && selectable.length > 0 ? (
				<Button
					onClick={() => onSelect(selectable, !allOn)}
					size="xs"
					variant="ghost"
				>
					{allOn ? "Clear" : `Select ${selectable.length}`}
				</Button>
			) : null}
		</div>
	);
}

export function ToolsTab({
	server,
	workspaceId,
	canManage,
	filter,
}: {
	server: McpUpstream;
	workspaceId?: string;
	canManage: boolean;
	filter: ToolFilter;
}) {
	const navigate = useNavigate();
	const adopt = useAdoptMcpTools(workspaceId);
	const [query, setQuery] = useState("");
	const [selection, setSelection] = useState<Record<string, McpAdoptChoice>>(
		{},
	);
	const [skipped, setSkipped] = useState<McpAdoptResult["skipped"]>([]);

	const rows = useMemo(() => toolRows(server), [server]);
	const groups = useMemo(
		() => groupRows(filterRows(rows, query, filter)),
		[rows, query, filter],
	);
	const needsReview = rows.filter(
		(row) => row.state === "changed" || row.state === "missing",
	).length;
	const chosen = Object.fromEntries(
		rows.flatMap((row) => {
			const choice = selection[row.name];
			return choice && (row.state === "available" || row.state === "changed")
				? [[row.name, choice] as const]
				: [];
		}),
	);
	const chosenCount = Object.keys(chosen).length;
	const readopting = rows.filter(
		(row) => row.state === "changed" && chosen[row.name],
	).length;
	const tooMany = chosenCount > MAX_ADOPT;

	const toggle = (row: Row, on: boolean) =>
		setSelection((current) => {
			const next = { ...current };
			if (on) next[row.name] = initialChoice(row);
			else delete next[row.name];
			return next;
		});
	const selectGroup = (group: Row[], on: boolean) =>
		setSelection((current) => {
			const next = { ...current };
			for (const row of group) {
				if (on) next[row.name] ??= initialChoice(row);
				else delete next[row.name];
			}
			return next;
		});

	if (rows.length === 0) {
		return (
			<ListFrame>
				<ListEmpty
					description="Anlyon shows them here as soon as it can list them. The step above says what that needs."
					title="No tools listed yet"
				/>
			</ListFrame>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<p className="max-w-[44rem] text-pretty text-[13px] text-muted-foreground leading-relaxed">
				Adopting a tool makes it an action your agent can call, under your
				approvals and receipts. A tool you leave out cannot be reached. Each
				rating is Anlyon's reading of the tool's definition: a suggestion to
				check, not a verdict.
			</p>
			<PageToolbar>
				<ListSearch
					className="min-w-48 flex-1 sm:max-w-xs"
					label="Search tools"
					onChange={setQuery}
					placeholder="Search tools"
					value={query}
				/>
				<SegmentedControl
					label="Show"
					onChange={(next: ToolFilter) =>
						navigate({
							to: ".",
							search: (previous: Record<string, unknown>) => ({
								...previous,
								filter: next === "all" ? undefined : next,
							}),
							replace: true,
						} as never)
					}
					options={[
						{ value: "all", label: "All" },
						{ value: "adopted", label: "Adopted" },
						{
							value: "review",
							label:
								needsReview > 0
									? `Needs review (${needsReview})`
									: "Needs review",
						},
					]}
					value={filter}
				/>
			</PageToolbar>

			<ListFrame className="scroll-mt-16" id={TOOLS_LIST_ID}>
				{groups.length === 0 ? (
					<ListEmpty
						description={
							filter === "review"
								? "Every adopted tool is still the one you reviewed."
								: "Nothing here matches. Try another search or filter."
						}
						role="status"
						title={filter === "review" ? "Nothing to review" : "No tools"}
					/>
				) : (
					groups.map((group) => (
						<section
							aria-label={
								group.key === "gone"
									? "No longer listed"
									: `${RISK_LABEL[group.key]} tools`
							}
							className="border-b last:border-b-0"
							key={group.key}
						>
							<GroupHeader
								canManage={canManage}
								group={group}
								onSelect={selectGroup}
								selection={selection}
							/>
							<ul>
								{group.rows.map((row) => (
									<ToolRow
										canManage={canManage}
										choice={chosen[row.name]}
										key={row.name}
										onChoice={(name, choice) =>
											setSelection((current) => ({
												...current,
												[name]: choice,
											}))
										}
										onToggle={toggle}
										row={row}
									/>
								))}
							</ul>
						</section>
					))
				)}
			</ListFrame>

			{skipped.length > 0 ? (
				<Alert role="alert" variant="warning">
					<AlertTitle>
						{skipped.length} {skipped.length === 1 ? "tool" : "tools"} not
						adopted
					</AlertTitle>
					<AlertDescription>
						<ul className="space-y-0.5">
							{skipped.map((item) => (
								<li key={item.tool}>
									<code className="font-mono" translate="no">
										{item.tool}
									</code>
									: {item.reason}
								</li>
							))}
						</ul>
					</AlertDescription>
				</Alert>
			) : null}

			{canManage && chosenCount > 0 ? (
				<div
					className="sticky bottom-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-background px-3.5 py-2.5 shadow-lg"
					data-slot="adopt-bar"
				>
					<output className="block min-w-0 flex-1 basis-48 text-[13px]">
						{selectionSummary(chosen, readopting)}
						{tooMany ? (
							<span className="text-destructive">
								. Adopt at most {MAX_ADOPT} at a time
							</span>
						) : null}
					</output>
					<Button onClick={() => setSelection({})} size="sm" variant="ghost">
						Clear
					</Button>
					<Button
						disabled={tooMany}
						loading={adopt.isPending}
						onClick={() =>
							adopt.mutate(
								{ id: server.id, tools: chosen },
								{
									onSuccess: (result) => {
										setSelection({});
										setSkipped(result.skipped);
									},
								},
							)
						}
						size="sm"
					>
						{readopting === chosenCount ? "Re-adopt" : "Adopt"} {chosenCount}{" "}
						{chosenCount === 1 ? "tool" : "tools"}
					</Button>
				</div>
			) : null}
		</div>
	);
}
