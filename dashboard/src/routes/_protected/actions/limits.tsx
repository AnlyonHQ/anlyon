"use client";

import { createFileRoute } from "@tanstack/react-router";
import { Archive, Pencil } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { EnvironmentSelect } from "@/components/effects/environment-select";
import {
	Available,
	formatLimitAmount,
	periodLabel,
	UsageBar,
} from "@/components/governance/limit-usage";
import { ListEmpty, ListLoading } from "@/components/governance/list-empty";
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
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogForm,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
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
	type CreateImpactLimitInput,
	useArchiveImpactLimit,
	useCreateImpactLimit,
	useImpactLimits,
	useUpdateImpactLimit,
} from "@/hooks/api/use-effects";
import { useCan } from "@/hooks/api/use-permissions";
import { limitAllowance } from "@/lib/rule-subjects";
import type { ImpactLimit, ImpactLimitSubject } from "@/lib/types";

export { formatLimitAmount };

type LimitsSearch = { environmentId: string | undefined };

export const Route = createFileRoute("/_protected/actions/limits")({
	validateSearch: (search: Record<string, unknown>): LimitsSearch => ({
		environmentId:
			typeof search.environmentId === "string"
				? search.environmentId
				: undefined,
	}),
	component: LimitsRoute,
});

function LimitsRoute() {
	const navigate = Route.useNavigate();
	const { environmentId } = Route.useSearch();
	return (
		<LimitsPage
			environmentId={environmentId}
			onEnvironmentChange={(next) =>
				navigate({ to: "/actions/limits", search: { environmentId: next } })
			}
		/>
	);
}

type Period = CreateImpactLimitInput["period"];
type Kind = "money" | "resource_mutations" | "declared";

const KINDS = [
	{ value: "money", label: "Money moved" },
	{ value: "resource_mutations", label: "Resource changes" },
	{ value: "declared", label: "A declared unit" },
] as const;

const DECLARED_UNIT = /^[a-z][a-z0-9_]{0,31}$/;

function countNoun(dimension: string): string {
	return dimension === "resource_mutations" ? "changes" : dimension;
}

const PERIODS = [
	{ value: "day", label: "Per day (UTC)" },
	{ value: "month", label: "Per month (UTC)" },
	{ value: "total", label: "All time" },
] as const;

function toUnits(dimension: string, value: string): number | null {
	const number = Number(value);
	if (!value.trim() || !Number.isFinite(number) || number < 0) return null;
	const units = dimension === "money" ? Math.round(number * 100) : number;
	return Number.isInteger(units) ? units : null;
}

function toEditable(limit: ImpactLimit): string {
	return limit.dimension === "money"
		? (limit.limit / 100).toFixed(2)
		: String(limit.limit);
}

export function LimitsPage({
	environmentId,
	onEnvironmentChange,
}: {
	environmentId: string | undefined;
	onEnvironmentChange: (environmentId: string | undefined) => void;
}) {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const limits = useImpactLimits(workspaceId, environmentId);
	const rows = limits.data ?? [];
	const canManage = useCan(workspaceId)("limits.manage", environmentId);
	const isEmpty = !limits.isLoading && !limits.isError && rows.length === 0;

	return (
		<Page>
			<PageHeader
				actions={
					<>
						<EnvironmentSelect
							onChange={onEnvironmentChange}
							value={environmentId}
							workspaceId={workspaceId}
						/>
						{canManage && !isEmpty && (
							<CreateLimitDialog
								environmentId={environmentId}
								workspaceId={workspaceId}
							/>
						)}
					</>
				}
				description="Caps on what your agents change, such as money moved or emails sent, across the environment or for each user. A call that would go over is stopped before it runs."
				title="Limits"
			/>

			{limits.isError ? (
				<ListFrame padded>
					<p className="text-destructive text-sm" role="alert">
						Impact limits could not be loaded: {(limits.error as Error).message}
					</p>
				</ListFrame>
			) : limits.isLoading ? (
				<ListFrame>
					<ListLoading rows={3} />
				</ListFrame>
			) : rows.length === 0 ? (
				<ListFrame>
					<ListEmpty
						action={
							canManage ? (
								<CreateLimitDialog
									environmentId={environmentId}
									workspaceId={workspaceId}
								/>
							) : undefined
						}
						description="Cap money moved, records changed or any unit an action declares. Until then, approvals and policies are what bound your agents."
						title="No impact limits yet"
					/>
				</ListFrame>
			) : (
				<ListFrame
					footer={
						<>
							<span className="tabular-nums">
								{rows.length} {rows.length === 1 ? "limit" : "limits"}
							</span>
							<span className="max-w-2xl sm:text-right">
								Held amounts include unknown exposure. It is not an additional
								amount. Lowering a limit never releases capacity that is already
								held.
							</span>
						</>
					}
				>
					<Table aria-busy={limits.isFetching}>
						<TableHeader>
							<TableRow>
								<TableHead>Limit</TableHead>
								<TableHead className="hidden lg:table-cell">Actions</TableHead>
								<TableHead className="hidden w-56 md:table-cell">
									Allowance
								</TableHead>
								<TableHead className="hidden w-64 sm:table-cell">
									Usage
								</TableHead>
								<TableHead className="w-36 text-right">Available</TableHead>
								{canManage ? (
									<TableHead className="w-24">
										<span className="sr-only">Manage</span>
									</TableHead>
								) : null}
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((limit) => (
								<TableRow key={limit.id}>
									<TableCell className="max-w-0 py-3">
										<p className="flex min-w-0 items-center gap-2">
											<span className="truncate font-medium">{limit.name}</span>
											{limit.scope.kind === "end_user" ? (
												<Badge size="sm" variant="outline">
													Each user
												</Badge>
											) : null}
										</p>
										<p className="truncate text-muted-foreground text-xs">
											{periodLabel(limit)}
										</p>
									</TableCell>
									<TableCell className="hidden max-w-0 py-3 lg:table-cell">
										<p className="truncate">
											{limit.scope.actionName ? (
												<span className="font-mono text-xs" translate="no">
													{limit.scope.actionName}
												</span>
											) : (
												<span className="text-muted-foreground">
													All actions
												</span>
											)}
										</p>
										{limit.scope.resourcePrefix ? (
											<p
												className="truncate font-mono text-muted-foreground text-xs"
												translate="no"
											>
												{limit.scope.resourcePrefix}…
											</p>
										) : null}
									</TableCell>
									<TableCell className="hidden max-w-0 py-3 md:table-cell">
										<p className="line-clamp-2 whitespace-normal text-muted-foreground">
											{limitAllowance(limit)}
										</p>
									</TableCell>
									<TableCell className="hidden py-3 sm:table-cell">
										<UsageBar limit={limit} />
									</TableCell>
									<TableCell className="py-3 text-right">
										<Available limit={limit} />
									</TableCell>
									{canManage ? (
										<TableCell className="py-2">
											<div className="flex justify-end gap-1">
												<EditLimitDialog
													environmentId={environmentId}
													limit={limit}
													workspaceId={workspaceId}
												/>
												<ArchiveLimitButton
													environmentId={environmentId}
													limit={limit}
													workspaceId={workspaceId}
												/>
											</div>
										</TableCell>
									) : null}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</ListFrame>
			)}
		</Page>
	);
}

function CreateLimitDialog({
	workspaceId,
	environmentId,
}: {
	workspaceId?: string;
	environmentId?: string;
}) {
	const id = useId();
	const create = useCreateImpactLimit(workspaceId, environmentId);
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<Kind>("money");
	const [unit, setUnit] = useState("");
	const [name, setName] = useState("");
	const [currency, setCurrency] = useState("USD");
	const [period, setPeriod] = useState<Period>("day");
	const [amount, setAmount] = useState("");
	const [actionName, setActionName] = useState("");
	const [resourcePrefix, setResourcePrefix] = useState("");
	const [subject, setSubject] = useState<ImpactLimitSubject>("environment");
	const [error, setError] = useState<string | null>(null);

	const reset = () => {
		setSubject("environment");
		setKind("money");
		setUnit("");
		setName("");
		setCurrency("USD");
		setPeriod("day");
		setAmount("");
		setActionName("");
		setResourcePrefix("");
		setError(null);
	};

	const submit = (event: FormEvent) => {
		event.preventDefault();
		setError(null);
		const dimension = kind === "declared" ? unit.trim().toLowerCase() : kind;
		const units = toUnits(dimension, amount);
		if (!name.trim()) return setError("Name the limit.");
		if (kind === "declared" && !DECLARED_UNIT.test(dimension))
			return setError(
				"Name the unit in lowercase letters, digits and underscores, such as emails.",
			);
		if (units === null)
			return setError(
				dimension === "money"
					? "Enter an amount such as 500.00."
					: `Enter a whole number of ${countNoun(dimension)}.`,
			);
		if (dimension === "money" && !/^[a-z]{3}$/i.test(currency.trim()))
			return setError("Enter a three-letter currency code, such as USD.");
		create.mutate(
			{
				name: name.trim(),
				dimension,
				...(dimension === "money"
					? { currency: currency.trim().toLowerCase() }
					: {}),
				period,
				amount: units,
				actionName: actionName.trim() || null,
				resourcePrefix: resourcePrefix.trim() || null,
				...(subject === "end_user" ? { scope: subject } : {}),
			},
			{
				onSuccess: () => {
					setOpen(false);
					reset();
				},
				onError: (err: Error) => setError(err.message),
			},
		);
	};

	return (
		<Dialog
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setError(null);
			}}
			open={open}
		>
			<DialogTrigger
				render={
					<Button disabled={!workspaceId} size="sm">
						New limit
					</Button>
				}
			/>
			<DialogPopup className="sm:max-w-lg">
				<DialogForm noValidate onSubmit={submit}>
					<DialogHeader>
						<DialogTitle>New impact limit</DialogTitle>
						<DialogDescription>
							A cap every agent in this environment shares. Anlyon reserves
							against it before each dispatch and refuses what would go over.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel>
						<FieldGroup>
							<Field>
								<FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
								<Input
									autoComplete="off"
									autoFocus
									id={`${id}-name`}
									maxLength={120}
									onChange={(e) => setName(e.target.value)}
									placeholder="Daily refund cap"
									value={name}
								/>
							</Field>

							<div className="grid gap-5 sm:grid-cols-2">
								<Field>
									<FieldLabel>Caps</FieldLabel>
									<Select
										items={[...KINDS]}
										onValueChange={(value) => {
											const next = KINDS.find((k) => k.value === value);
											if (next) setKind(next.value);
										}}
										value={kind}
									>
										<SelectTrigger aria-label="What the limit caps">
											<SelectValue />
										</SelectTrigger>
										<SelectPopup>
											{KINDS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
										</SelectPopup>
									</Select>
								</Field>
								<Field>
									<FieldLabel>Resets</FieldLabel>
									<Select
										items={[...PERIODS]}
										onValueChange={(value) => {
											if (
												value === "day" ||
												value === "month" ||
												value === "total"
											)
												setPeriod(value);
										}}
										value={period}
									>
										<SelectTrigger aria-label="When the limit resets">
											<SelectValue />
										</SelectTrigger>
										<SelectPopup>
											{PERIODS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
										</SelectPopup>
									</Select>
								</Field>
							</div>

							{kind === "declared" ? (
								<Field>
									<FieldLabel htmlFor={`${id}-unit`}>Unit</FieldLabel>
									<Input
										autoCapitalize="none"
										autoComplete="off"
										className="font-mono"
										id={`${id}-unit`}
										maxLength={32}
										onChange={(e) => setUnit(e.target.value)}
										placeholder="emails"
										spellCheck={false}
										value={unit}
									/>
									<FieldDescription>
										The unit name an action declares as its impact dimension.
									</FieldDescription>
								</Field>
							) : null}

							{kind === "money" ? (
								<div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_7rem]">
									<Field>
										<FieldLabel htmlFor={`${id}-amount`}>Amount</FieldLabel>
										<Input
											id={`${id}-amount`}
											inputMode="decimal"
											onChange={(e) => setAmount(e.target.value)}
											placeholder="500.00"
											value={amount}
										/>
									</Field>
									<Field>
										<FieldLabel htmlFor={`${id}-currency`}>Currency</FieldLabel>
										<Input
											id={`${id}-currency`}
											maxLength={3}
											onChange={(e) =>
												setCurrency(e.target.value.toUpperCase())
											}
											value={currency}
										/>
									</Field>
								</div>
							) : (
								<Field>
									<FieldLabel htmlFor={`${id}-amount`}>
										{kind === "declared" ? "Amount" : "Number of changes"}
									</FieldLabel>
									<Input
										id={`${id}-amount`}
										inputMode="numeric"
										onChange={(e) => setAmount(e.target.value)}
										placeholder="50"
										value={amount}
									/>
								</Field>
							)}

							<Field>
								<FieldLabel htmlFor={`${id}-subject`}>Scope</FieldLabel>
								<NativeSelect
									className="w-full"
									id={`${id}-subject`}
									onChange={(e) =>
										setSubject(
											e.target.value === "end_user"
												? "end_user"
												: "environment",
										)
									}
									value={subject}
								>
									<NativeSelectOption value="environment">
										Environment
									</NativeSelectOption>
									<NativeSelectOption value="end_user">
										Each user
									</NativeSelectOption>
								</NativeSelect>
								<FieldDescription>
									{subject === "end_user"
										? "Each user gets this amount. Calls without a user share one counter."
										: "One amount for every call in this environment."}
								</FieldDescription>
							</Field>

							<div className="space-y-1 border-t pt-5">
								<h3 className="font-medium text-sm">Narrow it (optional)</h3>
								<p className="text-muted-foreground text-xs">
									Leave both empty to count every governed action in this
									environment that changes this unit.
								</p>
							</div>
							<div className="grid gap-5 sm:grid-cols-2">
								<Field>
									<FieldLabel htmlFor={`${id}-action`}>
										Only this action
									</FieldLabel>
									<Input
										autoComplete="off"
										className="font-mono"
										id={`${id}-action`}
										onChange={(e) => setActionName(e.target.value)}
										placeholder="refund_payment"
										value={actionName}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor={`${id}-prefix`}>
										Resources starting with
									</FieldLabel>
									<Input
										autoComplete="off"
										className="font-mono"
										id={`${id}-prefix`}
										onChange={(e) => setResourcePrefix(e.target.value)}
										placeholder="github:acme/fixtures@"
										value={resourcePrefix}
									/>
								</Field>
							</div>

							{error ? (
								<p className="text-destructive text-sm" role="alert">
									{error}
								</p>
							) : null}
						</FieldGroup>
					</DialogPanel>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							Cancel
						</DialogClose>
						<Button loading={create.isPending} type="submit">
							Create limit
						</Button>
					</DialogFooter>
				</DialogForm>
			</DialogPopup>
		</Dialog>
	);
}

function EditLimitDialog({
	limit,
	workspaceId,
	environmentId,
}: {
	limit: ImpactLimit;
	workspaceId?: string;
	environmentId?: string;
}) {
	const id = useId();
	const update = useUpdateImpactLimit(workspaceId, environmentId);
	const [open, setOpen] = useState(false);
	const [name, setName] = useState(limit.name);
	const [amount, setAmount] = useState(() => toEditable(limit));
	const [error, setError] = useState<string | null>(null);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		setError(null);
		const units = toUnits(limit.dimension, amount);
		if (!name.trim()) return setError("Name the limit.");
		if (units === null)
			return setError(
				limit.dimension === "money"
					? "Enter an amount such as 500.00."
					: `Enter a whole number of ${countNoun(limit.dimension)}.`,
			);
		const changes = {
			...(name.trim() !== limit.name ? { name: name.trim() } : {}),
			...(units !== limit.limit ? { amount: units } : {}),
		};
		if (Object.keys(changes).length === 0) return setOpen(false);
		update.mutate(
			{ id: limit.id, ...changes },
			{
				onSuccess: () => setOpen(false),
				onError: (err: Error) => setError(err.message),
			},
		);
	};

	return (
		<Dialog
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					setName(limit.name);
					setAmount(toEditable(limit));
					setError(null);
				}
			}}
			open={open}
		>
			<DialogTrigger
				render={
					<Button
						aria-label={`Edit ${limit.name}`}
						size="icon-sm"
						variant="ghost"
					>
						<Pencil className="size-4" />
					</Button>
				}
			/>
			<DialogPopup className="sm:max-w-md">
				<DialogForm noValidate onSubmit={submit}>
					<DialogHeader>
						<DialogTitle>Edit limit</DialogTitle>
						<DialogDescription>
							{periodLabel(limit)}.{" "}
							{formatLimitAmount(limit, limit.consumed + limit.reserved)} is
							used or held right now.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel>
						<FieldGroup>
							<Field>
								<FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
								<Input
									autoComplete="off"
									id={`${id}-name`}
									maxLength={120}
									onChange={(e) => setName(e.target.value)}
									value={name}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-amount`}>
									{limit.dimension === "money"
										? `Amount (${limit.currency?.toUpperCase()})`
										: `Number of ${countNoun(limit.dimension)}`}
								</FieldLabel>
								<Input
									autoFocus
									id={`${id}-amount`}
									inputMode={
										limit.dimension === "money" ? "decimal" : "numeric"
									}
									onChange={(e) => setAmount(e.target.value)}
									value={amount}
								/>
								<FieldDescription>
									Lowering a limit never releases capacity that is already held.
								</FieldDescription>
							</Field>
							{error ? (
								<p className="text-destructive text-sm" role="alert">
									{error}
								</p>
							) : null}
						</FieldGroup>
					</DialogPanel>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							Cancel
						</DialogClose>
						<Button loading={update.isPending} type="submit">
							Save changes
						</Button>
					</DialogFooter>
				</DialogForm>
			</DialogPopup>
		</Dialog>
	);
}

function ArchiveLimitButton({
	limit,
	workspaceId,
	environmentId,
}: {
	limit: ImpactLimit;
	workspaceId?: string;
	environmentId?: string;
}) {
	const archive = useArchiveImpactLimit(workspaceId, environmentId);
	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={
					<Button
						aria-label={`Archive ${limit.name}`}
						disabled={!workspaceId || archive.isPending}
						size="icon-sm"
						variant="ghost"
					>
						<Archive className="size-4" />
					</Button>
				}
			/>
			<AlertDialogPopup>
				<AlertDialogHeader>
					<AlertDialogTitle>Archive {limit.name}?</AlertDialogTitle>
					<AlertDialogDescription>
						It stops applying to new dispatches and can no longer be edited.
						Reservations it already holds still settle.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogClose
						render={<Button variant="outline">Cancel</Button>}
					/>
					<AlertDialogClose
						render={
							<Button
								onClick={() => archive.mutate(limit.id)}
								variant="destructive"
							>
								Archive
							</Button>
						}
					/>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}
