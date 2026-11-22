"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useCallback } from "react";
import { DetailSheet } from "@/components/actions/detail-sheet";
import { FilterChips } from "@/components/actions/filter-chips";
import {
	ListMessage,
	ListSkeleton,
	Pager,
	RowStepper,
	useRowKeys,
} from "@/components/activity/list-parts";
import { OutcomeUnknownHint } from "@/components/defaults/defaults-hint";
import {
	EffectDetailView,
	GRADE_LABEL,
	GRADE_MEANING,
	GRADES,
	GradePill,
	OUTCOME_LABEL,
	OutcomePill,
	verificationLabel,
} from "@/components/effects/effect-detail";
import { EnvironmentSelect } from "@/components/effects/environment-select";
import { formatQuantity } from "@/components/effects/preview-blocks";
import { EndUserFilter } from "@/components/end-users/end-user-filter";
import {
	ListFrame,
	Page,
	PageHeader,
	PageToolbar,
} from "@/components/layout/page";
import {
	ActingFor,
	type ActingForFilter,
	ActingForSwitch,
	parseActingFor,
} from "@/components/shared/acting-for";
import { Button } from "@/components/ui/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
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
	EFFECTS_PAGE_SIZE,
	useEffectDetail,
	useEffects,
} from "@/hooks/api/use-effects";
import type { EffectGrade, EffectOutcome } from "@/lib/types";

type EffectsSearch = {
	effect: string | undefined;
	environmentId: string | undefined;
	action: string | undefined;
	outcome: EffectOutcome | undefined;
	grade: EffectGrade | undefined;
	unresolved: boolean | undefined;
	offset: number | undefined;
	endUser?: string;
	actingFor?: ActingForFilter;
};

const OUTCOMES: EffectOutcome[] = [
	"pending",
	"unknown",
	"succeeded",
	"failed",
	"not_dispatched",
];

export const Route = createFileRoute("/_protected/actions/effects")({
	validateSearch: (search: Record<string, unknown>): EffectsSearch => ({
		effect: typeof search.effect === "string" ? search.effect : undefined,
		environmentId:
			typeof search.environmentId === "string"
				? search.environmentId
				: undefined,
		action:
			typeof search.action === "string" && search.action
				? search.action
				: undefined,
		outcome: OUTCOMES.includes(search.outcome as EffectOutcome)
			? (search.outcome as EffectOutcome)
			: undefined,
		grade: GRADES.includes(search.grade as EffectGrade)
			? (search.grade as EffectGrade)
			: undefined,
		unresolved:
			search.unresolved === true || search.unresolved === "true"
				? true
				: undefined,
		offset:
			typeof search.offset === "number" && search.offset > 0
				? Math.floor(search.offset)
				: undefined,
		endUser:
			typeof search.endUser === "string" && search.endUser
				? search.endUser
				: undefined,
		actingFor: parseActingFor(search.actingFor),
	}),
	component: EffectsPage,
});

const ANY_OUTCOME = "any";
const OUTCOME_ITEMS = [
	{ value: ANY_OUTCOME, label: "Any outcome" },
	...OUTCOMES.map((outcome) => ({
		value: outcome,
		label: OUTCOME_LABEL[outcome],
	})),
];

const ANY_GRADE = "any";
const GRADE_ITEMS = [
	{ value: ANY_GRADE, label: "Any receipt" },
	...GRADES.map((grade) => ({ value: grade, label: GRADE_LABEL[grade] })),
];

const whenFormat = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

function EffectsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const navigate = Route.useNavigate();
	const search = Route.useSearch();
	const environmentId = search.environmentId;
	const offset = search.offset ?? 0;

	const list = useEffects(workspaceId, environmentId, {
		action: search.action,
		outcome: search.outcome,
		grade: search.grade,
		unresolved: search.unresolved,
		offset,
		endUserId: search.endUser,
		actingFor: search.actingFor,
	});
	const detail = useEffectDetail(workspaceId, environmentId, search.effect);
	const effects = list.data?.data ?? [];
	const filtered = Boolean(
		search.action ||
			search.outcome ||
			search.grade ||
			search.endUser ||
			search.actingFor,
	);
	const pagination = list.data?.pagination;

	const setSearch = useCallback(
		(patch: Partial<EffectsSearch>) =>
			navigate({
				to: "/actions/effects",
				search: (previous) => ({ ...previous, ...patch }),
			}),
		[navigate],
	);
	const filter = (patch: Partial<EffectsSearch>) =>
		setSearch({ ...patch, offset: undefined, effect: undefined });
	const open = useCallback(
		(id: string) => setSearch({ effect: id }),
		[setSearch],
	);
	const stepper = useRowKeys({
		rows: effects,
		selectedId: search.effect,
		onSelect: open,
	});

	return (
		<Page>
			<PageHeader
				actions={
					<EnvironmentSelect
						onChange={(next) => filter({ environmentId: next })}
						value={environmentId}
						workspaceId={workspaceId}
					/>
				}
				description="One receipt per governed action: what it changed, how far that was checked, and what still counts against an impact limit. The API calls it an effect."
				title="Receipts"
			/>
			<OutcomeUnknownHint
				show={effects.some((effect) => effect.outcome === "unknown")}
				workspaceId={workspaceId}
			/>

			<div className="flex flex-col gap-3">
				<PageToolbar>
					<fieldset className="contents">
						<legend className="sr-only">Filter receipts</legend>
						<ActingForSwitch
							onChange={(next) => filter({ actingFor: next })}
							value={search.actingFor}
						/>
						<InputGroup className="w-full sm:w-60">
							<InputGroupAddon>
								<Search aria-hidden="true" />
							</InputGroupAddon>
							<InputGroupInput
								aria-label="Action"
								defaultValue={search.action ?? ""}
								key={search.action ?? ""}
								onBlur={(e) => {
									const value = e.currentTarget.value.trim() || undefined;
									if (value !== search.action) filter({ action: value });
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter")
										filter({
											action: e.currentTarget.value.trim() || undefined,
										});
								}}
								placeholder="Filter by action"
								type="search"
							/>
						</InputGroup>
						<Select
							items={OUTCOME_ITEMS}
							onValueChange={(value) =>
								filter({
									outcome: OUTCOMES.includes(value as EffectOutcome)
										? (value as EffectOutcome)
										: undefined,
								})
							}
							value={search.outcome ?? ANY_OUTCOME}
						>
							<SelectTrigger aria-label="Outcome" className="w-44">
								<SelectValue />
							</SelectTrigger>
							<SelectPopup>
								{OUTCOME_ITEMS.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectPopup>
						</Select>
						<Select
							items={GRADE_ITEMS}
							onValueChange={(value) =>
								filter({
									grade: GRADES.includes(value as EffectGrade)
										? (value as EffectGrade)
										: undefined,
								})
							}
							value={search.grade ?? ANY_GRADE}
						>
							<SelectTrigger aria-label="Receipt grade" className="w-44">
								<SelectValue />
							</SelectTrigger>
							<SelectPopup>
								{GRADE_ITEMS.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectPopup>
						</Select>
						<EndUserFilter
							onChange={(next) => filter({ endUser: next })}
							value={search.endUser}
						/>
						<FilterChips
							className="sm:ms-auto"
							label="Which receipts to show"
							onChange={(value) =>
								filter({ unresolved: value === "holding" ? true : undefined })
							}
							options={[
								{ value: "all", label: "All receipts" },
								{ value: "holding", label: "Holding capacity" },
							]}
							value={search.unresolved ? "holding" : "all"}
						/>
					</fieldset>
				</PageToolbar>
				{search.grade ? (
					<p className="text-muted-foreground text-sm">
						<span className="font-medium text-foreground">
							{GRADE_LABEL[search.grade]}.
						</span>{" "}
						{GRADE_MEANING[search.grade]}
					</p>
				) : null}
			</div>

			<ListFrame
				footer={
					effects.length > 0 ? (
						<Pager
							hasMore={pagination?.hasMore ?? false}
							noun={["receipt", "receipts"]}
							offset={offset}
							onPage={(next) => setSearch({ offset: next, effect: undefined })}
							pageSize={EFFECTS_PAGE_SIZE}
							shown={effects.length}
							total={pagination?.total}
						/>
					) : null
				}
			>
				{list.isError ? (
					<ListMessage title="Receipts could not be loaded." tone="error">
						{(list.error as Error).message}
					</ListMessage>
				) : list.isLoading ? (
					<ListSkeleton rows={4} />
				) : effects.length === 0 ? (
					filtered ? (
						<ListMessage
							action={
								<Button
									onClick={() =>
										filter({
											action: undefined,
											outcome: undefined,
											grade: undefined,
											endUser: undefined,
											actingFor: undefined,
										})
									}
									size="sm"
									variant="outline"
								>
									Clear filters
								</Button>
							}
							title="No receipts match these filters"
						/>
					) : search.unresolved ? (
						<ListMessage
							action={
								<Button
									onClick={() => filter({ unresolved: undefined })}
									size="sm"
									variant="outline"
								>
									Show all receipts
								</Button>
							}
							title="Nothing is holding capacity"
						>
							A receipt shows here while its action still counts against an
							impact limit.
						</ListMessage>
					) : (
						<ListMessage
							action={
								<Button
									render={<Link search={{ action: undefined }} to="/actions" />}
									size="sm"
								>
									Go to Actions
								</Button>
							}
							title="No receipts yet"
						>
							Anlyon writes one for each governed action your agent takes.
							Install a pack, or declare an impact or a read-back on an action,
							to govern it.
						</ListMessage>
					)
				) : (
					<Table aria-busy={list.isFetching} className="text-[13px]">
						<TableHeader>
							<TableRow>
								<TableHead className="md:w-[22%]">Action</TableHead>
								<TableHead className="w-36">For</TableHead>
								<TableHead className="w-32">Receipt</TableHead>
								<TableHead className="hidden w-32 xl:table-cell">
									Outcome
								</TableHead>
								<TableHead className="hidden md:table-cell">
									Verification
								</TableHead>
								<TableHead className="hidden lg:table-cell">Resource</TableHead>
								<TableHead className="hidden sm:table-cell">Impact</TableHead>
								<TableHead className="hidden w-36 text-right md:table-cell">
									When
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{effects.map((effect) => (
								<TableRow
									className="cursor-pointer"
									data-state={
										search.effect === effect.id ? "selected" : undefined
									}
									key={effect.id}
									onClick={() => open(effect.id)}
								>
									<TableCell className="max-w-0 py-2">
										<button
											aria-label={`View effect ${effect.id} of ${effect.action.name}`}
											className="block w-full truncate rounded-sm text-left font-medium font-mono text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
											onClick={(e) => {
												e.stopPropagation();
												open(effect.id);
											}}
											translate="no"
											type="button"
										>
											{effect.action.name}
										</button>
									</TableCell>
									<TableCell className="max-w-0 py-2">
										<ActingFor
											endUserId={effect.endUserId}
											environmentId={environmentId}
										/>
									</TableCell>
									<TableCell className="py-2">
										<GradePill grade={effect.grade} />
										<span className="sr-only">
											{" "}
											{GRADE_MEANING[effect.grade]}
											{effect.unresolvedExposure ? " (holding capacity)" : ""}
										</span>
									</TableCell>
									<TableCell className="hidden py-2 xl:table-cell">
										<OutcomePill outcome={effect.outcome} />
									</TableCell>
									<TableCell className="hidden py-2 text-muted-foreground md:table-cell">
										{verificationLabel(effect)}
									</TableCell>
									<TableCell className="hidden max-w-0 truncate py-2 font-mono text-muted-foreground text-xs lg:table-cell">
										{String(effect.target.resourceKey ?? "")}
									</TableCell>
									<TableCell className="hidden py-2 text-muted-foreground tabular-nums sm:table-cell">
										{effect.impact.map(formatQuantity).join(", ")}
									</TableCell>
									<TableCell className="hidden py-2 text-right text-muted-foreground tabular-nums md:table-cell">
										{whenFormat.format(new Date(effect.createdAt))}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</ListFrame>

			<DetailSheet
				description={search.effect}
				onClose={() => setSearch({ effect: undefined })}
				open={search.effect !== undefined}
				title={detail.data?.action.name ?? "Receipt"}
			>
				<RowStepper
					onNewer={
						stepper.newer ? () => open(stepper.newer?.id as string) : undefined
					}
					onOlder={
						stepper.older ? () => open(stepper.older?.id as string) : undefined
					}
					position={stepper.position}
				/>
				{detail.isError ? (
					<p className="text-destructive text-sm" role="alert">
						{(detail.error as Error).message}
					</p>
				) : detail.data ? (
					<EffectDetailView
						effect={detail.data}
						environmentId={environmentId}
						workspaceId={workspaceId}
					/>
				) : (
					<Skeleton className="h-24 w-full" />
				)}
			</DetailSheet>
		</Page>
	);
}
