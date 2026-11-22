"use client";

import { createFileRoute } from "@tanstack/react-router";
import { OctagonPause, Play } from "lucide-react";
import { useId, useState } from "react";
import { StatusDot } from "@/components/actions/detail-sheet";
import { hasPlanActions, PlanAction } from "@/components/extension-slots";
import { ListFrame, Page, PageHeader } from "@/components/layout/page";
import { ListEmpty } from "@/components/settings/settings-page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RelativeTime } from "@/components/ui/relative-time";
import {
	Select,
	SelectGroup,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
	useCreateEnvironment,
	useDeleteEnvironment,
	useEnvironments,
	useHaltEnvironment,
	useResumeEnvironment,
	useUpdateEnvironment,
} from "@/hooks/api/use-environments";
import { useCan } from "@/hooks/api/use-permissions";
import { usePlanDetails } from "@/hooks/api/use-plan";
import { requireFeature } from "@/lib/feature-flags";
import type { Environment } from "@/lib/types";

export const Route = createFileRoute("/_protected/environments")({
	beforeLoad: () => requireFeature("environments"),
	component: EnvironmentsPage,
});

function CreateEnvironmentDialog({ workspaceId }: { workspaceId?: string }) {
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<Environment["kind"]>("development");
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const nameId = useId();
	const slugId = useId();
	const create = useCreateEnvironment(workspaceId);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button size="sm">New environment</Button>} />
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Create environment</DialogTitle>
					<DialogDescription>
						Environments keep development, staging and production data apart
						within this workspace. The separation is logical: rows in shared
						storage, scoped by environment. An API key belongs to one
						environment.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="flex flex-col gap-4 py-2">
					<Field>
						<FieldLabel>Environment kind</FieldLabel>
						<Select
							value={kind}
							onValueChange={(value) => {
								if (
									value === "development" ||
									value === "staging" ||
									value === "production"
								)
									setKind(value);
							}}
							items={[
								{ value: "development", label: "Development" },
								{ value: "staging", label: "Staging" },
								{ value: "production", label: "Production" },
							]}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectPopup>
								<SelectGroup>
									{(["development", "staging", "production"] as const).map(
										(value) => (
											<SelectItem key={value} value={value}>
												{value}
											</SelectItem>
										),
									)}
								</SelectGroup>
							</SelectPopup>
						</Select>
					</Field>
					{create.error && (
						<Alert variant="error">
							<AlertDescription>{create.error.message}</AlertDescription>
						</Alert>
					)}
					<div className="space-y-1.5">
						<Label htmlFor={nameId}>Name</Label>
						<Input
							id={nameId}
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Staging"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={slugId}>Slug</Label>
						<Input
							id={slugId}
							value={slug}
							onChange={(e) => setSlug(e.target.value.toLowerCase())}
							placeholder="staging"
						/>
					</div>
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="outline">Cancel</Button>} />
					<Button
						loading={create.isPending}
						disabled={!name || !slug}
						onClick={async () => {
							try {
								await create.mutateAsync({ name, slug, kind });
								setOpen(false);
								setName("");
								setSlug("");
							} catch {
							}
						}}
					>
						Create
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function HaltDialog({
	env,
	workspaceId,
}: {
	env: Environment;
	workspaceId?: string;
}) {
	const [reason, setReason] = useState("");
	const haltMutation = useHaltEnvironment(workspaceId);

	return (
		<Dialog>
			<DialogTrigger
				render={
					<Button
						size="sm"
						variant="destructive-outline"
						aria-label={`Halt ${env.name}`}
					>
						<OctagonPause className="size-4" aria-hidden="true" /> Halt
					</Button>
				}
			/>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Halt “{env.name}”?</DialogTitle>
					<DialogDescription>
						Halting stops new dispatch from this environment until you resume.
						Action invocations are blocked, including approved ones. Agent
						writes and agent publishes are refused. The dashboard and keys
						holding messages:ingest can still publish, and approvals can still
						be decided. A request another server already accepted is not
						recalled.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="space-y-1.5 py-2">
					<Label htmlFor={`halt-reason-${env.id}`}>
						Reason (recorded for the audit trail)
					</Label>
					<Input
						id={`halt-reason-${env.id}`}
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						placeholder="Incident #42: agent issuing wrong refunds"
						maxLength={500}
					/>
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="outline">Cancel</Button>} />
					<DialogClose
						render={
							<Button
								variant="destructive"
								disabled={haltMutation.isPending}
								onClick={() =>
									haltMutation.mutate({
										environmentId: env.id,
										reason: reason || undefined,
									})
								}
							>
								Halt environment
							</Button>
						}
					/>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function ManageEnvironmentDialog({
	env,
	workspaceId,
}: {
	env: Environment;
	workspaceId?: string;
}) {
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState(env.kind);
	const [confirmation, setConfirmation] = useState("");
	const update = useUpdateEnvironment(workspaceId);
	const remove = useDeleteEnvironment(workspaceId);
	const canDelete = useCan(workspaceId)("environments.delete");
	const kinds = ["development", "staging", "production"] as const;
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				setOpen(value);
				setKind(env.kind);
				setConfirmation("");
			}}
		>
			<DialogTrigger render={<Button size="sm" variant="outline" />}>
				Manage…
			</DialogTrigger>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Manage {env.name}</DialogTitle>
					<DialogDescription>
						Reclassifying preserves resources and API keys. A plan counts
						environments, whatever their kind. Turn protection off before
						changing the kind of a protected environment.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor={`kind-${env.id}`}>
								Environment kind
							</FieldLabel>
							<Select
								items={kinds.map((value) => ({ label: value, value }))}
								value={kind}
								onValueChange={(value) => {
									if (value) setKind(value);
								}}
							>
								<SelectTrigger id={`kind-${env.id}`}>
									<SelectValue />
								</SelectTrigger>
								<SelectPopup>
									<SelectGroup>
										{kinds.map((value) => (
											<SelectItem key={value} value={value}>
												{value}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectPopup>
							</Select>
						</Field>
						<p className="text-sm text-muted-foreground">
							Remove protection before reclassifying a protected environment.
							Plan limits are checked when saving.
						</p>
						<Button
							variant="outline"
							loading={update.isPending}
							disabled={env.isProtected || kind === env.kind}
							onClick={() => update.mutate({ environmentId: env.id, kind })}
						>
							Save kind
						</Button>
						{!env.isDefault && (
							<Button
								variant="outline"
								loading={update.isPending}
								onClick={() =>
									update.mutate({ environmentId: env.id, isDefault: true })
								}
							>
								Make default
							</Button>
						)}
						<Field>
							<FieldLabel htmlFor={`delete-${env.id}`}>
								Type {env.slug} to delete this empty environment
							</FieldLabel>
							<Input
								id={`delete-${env.id}`}
								value={confirmation}
								onChange={(event) => setConfirmation(event.target.value)}
								autoComplete="off"
							/>
						</Field>
						<p className="text-sm text-muted-foreground">
							Admins only. First halt it, remove protection, choose another
							default, and remove its resources. Retained history must expire.
							Deletion cannot be undone.
						</p>
						<Button
							variant="destructive"
							loading={remove.isPending}
							disabled={
								!canDelete ||
								env.isDefault ||
								env.isProtected ||
								!env.halted ||
								confirmation !== env.slug
							}
							onClick={async () => {
								try {
									await remove.mutateAsync({
										environmentId: env.id,
										confirmSlug: confirmation,
									});
									setOpen(false);
								} catch {
								}
							}}
						>
							Delete empty environment
						</Button>
						{(update.error || remove.error) && (
							<p role="alert">
								{update.error?.message ?? remove.error?.message}
							</p>
						)}
					</FieldGroup>
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>Close</DialogClose>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function EnvironmentRow({
	env,
	workspaceId,
}: {
	env: Environment;
	workspaceId?: string;
}) {
	const resume = useResumeEnvironment(workspaceId);
	const update = useUpdateEnvironment(workspaceId);
	const [unprotectOpen, setUnprotectOpen] = useState(false);
	const plan = usePlanDetails(workspaceId);
	const can = useCan(workspaceId);
	const canManage = can("environments.manage");
	const canHalt = can("environments.halt", env.id);
	const canResume = can("environments.resume", env.id);

	return (
		<TableRow key={env.id} data-halted={env.halted || undefined}>
			<TableCell className="py-3">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="font-medium">{env.name}</span>
					{env.isDefault && (
						<Badge size="sm" variant="outline">
							Default
						</Badge>
					)}
					{env.isProtected && (
						<Badge size="sm" variant="warning">
							Protected
						</Badge>
					)}
				</div>
				<div className="text-muted-foreground text-xs">
					<span className="capitalize">{env.kind}</span>
					<span className="sm:hidden">
						{" · "}
						{env.halted ? "Halted" : "Active"}
					</span>
				</div>
			</TableCell>
			<TableCell className="hidden py-3 font-mono text-muted-foreground text-xs md:table-cell">
				{env.slug}
			</TableCell>
			<TableCell className="hidden py-3 sm:table-cell">
				<span
					className="inline-flex items-center gap-2"
					title={env.halted ? (env.haltedReason ?? undefined) : undefined}
				>
					<StatusDot className={env.halted ? "bg-destructive" : "bg-success"} />
					{env.halted ? "Halted" : "Active"}
				</span>
			</TableCell>
			<TableCell className="py-3">
				<div className="flex items-center gap-2">
					<Switch
						checked={env.isProtected}
						disabled={
							!canManage ||
							update.isPending ||
							(!env.isProtected && !plan.data?.features.protectedProduction)
						}
						onCheckedChange={(checked) => {
							if (!checked) setUnprotectOpen(true);
							else update.mutate({ environmentId: env.id, isProtected: true });
						}}
						aria-label={`Production protection for ${env.name}`}
					/>
					{plan.data &&
						!plan.data.features.protectedProduction &&
						(plan.data.access?.paidPlansAvailable && hasPlanActions() ? (
							<PlanAction
								className="text-sm underline"
								site="feature-unavailable"
							/>
						) : (
							<span className="text-sm text-muted-foreground">
								Not included in your plan.
							</span>
						))}
				</div>
				<Dialog open={unprotectOpen} onOpenChange={setUnprotectOpen}>
					<DialogPopup>
						<DialogHeader>
							<DialogTitle>Remove protection from {env.name}?</DialogTitle>
							<DialogDescription>
								Destructive operations will no longer require an explicit
								protection override.
							</DialogDescription>
						</DialogHeader>
						<DialogPanel>
							{update.error && <p role="alert">{update.error.message}</p>}
						</DialogPanel>
						<DialogFooter>
							<Button variant="outline" onClick={() => setUnprotectOpen(false)}>
								Keep protection
							</Button>
							<Button
								loading={update.isPending}
								onClick={async () => {
									try {
										await update.mutateAsync({
											environmentId: env.id,
											isProtected: false,
											confirmProtected: true,
										});
										setUnprotectOpen(false);
									} catch {
									}
								}}
							>
								Remove protection
							</Button>
						</DialogFooter>
					</DialogPopup>
				</Dialog>
			</TableCell>
			<TableCell className="hidden py-3 text-muted-foreground tabular-nums xl:table-cell">
				<RelativeTime value={env.createdAt} />
			</TableCell>
			<TableCell className="py-2 text-right">
				<div className="inline-flex flex-wrap justify-end gap-2">
					{canManage && (
						<ManageEnvironmentDialog env={env} workspaceId={workspaceId} />
					)}
					{env.halted
						? canResume && (
								<Button
									size="sm"
									variant="outline"
									disabled={resume.isPending}
									onClick={() => resume.mutate({ environmentId: env.id })}
									aria-label={`Resume ${env.name}`}
								>
									<Play className="size-4" aria-hidden="true" /> Resume
								</Button>
							)
						: canHalt && <HaltDialog env={env} workspaceId={workspaceId} />}
				</div>
			</TableCell>
		</TableRow>
	);
}

export function EnvironmentsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const query = useEnvironments(workspaceId);
	const environments = query.data ?? [];
	const halted = environments.filter((env) => env.halted);
	const canCreate = useCan(workspaceId)("environments.manage");
	const isEmpty = !query.isLoading && environments.length === 0;

	return (
		<Page>
			<PageHeader
				actions={
					canCreate && !isEmpty ? (
						<CreateEnvironmentDialog workspaceId={workspaceId} />
					) : undefined
				}
				description="Keep testing apart from production: each environment has its own API keys, actions, secrets, connections and limits. Halt one to stop its new calls until you resume it."
				title="Environments"
			>
				{halted.length > 0 && (
					<Alert variant="error" role="status">
						<OctagonPause className="size-4" aria-hidden="true" />
						<AlertTitle>
							{halted.length === 1
								? `“${halted[0].name}” is halted`
								: `${halted.length} environments are halted`}
						</AlertTitle>
						<AlertDescription>
							{halted[0].haltedReason
								? `Reason: ${halted[0].haltedReason}. `
								: ""}
							Deliveries are deferred and action invocations are blocked until
							resumed.
						</AlertDescription>
					</Alert>
				)}
			</PageHeader>
			{query.isLoading ? (
				<ListFrame padded>
					<div className="space-y-2">
						{[0, 1, 2].map((i) => (
							<Skeleton key={i} className="h-10 w-full rounded-lg" />
						))}
					</div>
				</ListFrame>
			) : environments.length === 0 ? (
				<ListFrame>
					<ListEmpty
						action={
							canCreate ? (
								<CreateEnvironmentDialog workspaceId={workspaceId} />
							) : undefined
						}
					>
						No environments yet. Add one to keep testing apart from production,
						within your plan's allowance.
					</ListEmpty>
				</ListFrame>
			) : (
				<ListFrame
					footer={
						<span className="tabular-nums">
							{environments.length}{" "}
							{environments.length === 1 ? "environment" : "environments"}
						</span>
					}
				>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead className="hidden md:table-cell">Slug</TableHead>
								<TableHead className="hidden sm:table-cell">Status</TableHead>
								<TableHead>Protection</TableHead>
								<TableHead className="hidden xl:table-cell">Created</TableHead>
								<TableHead className="text-right">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{environments.map((env) => (
								<EnvironmentRow
									key={env.id}
									env={env}
									workspaceId={workspaceId}
								/>
							))}
						</TableBody>
					</Table>
				</ListFrame>
			)}
		</Page>
	);
}
