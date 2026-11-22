"use client";

import { isFeatureEnabled } from "@anlyon/feature-flags";
import { createFileRoute } from "@tanstack/react-router";
import {
	DetailCode,
	DetailField,
	DetailSheet,
	StatusDot,
} from "@/components/actions/detail-sheet";
import { PolicyFormDialog } from "@/components/approvals/policy-form-dialog";
import { PolicyHistory } from "@/components/approvals/policy-history";
import { PolicySuggestions } from "@/components/approvals/policy-suggestions";
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
import { RelativeTime } from "@/components/ui/relative-time";
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
	useApprovalPolicies,
	useDeleteApprovalPolicy,
} from "@/hooks/api/use-approval-policies";
import { useCan } from "@/hooks/api/use-permissions";
import { requireFeature } from "@/lib/feature-flags";
import {
	describePolicyConditions,
	describePolicyMatch,
	SCOPE_LABEL,
	scopeOf,
} from "@/lib/policy-targeting";
import { policyDecidedBy } from "@/lib/rule-subjects";
import type { ApprovalPolicy, ApprovalPolicyEffect } from "@/lib/types";
import { cn } from "@/lib/utils";

type PoliciesSearch = { policy?: string; version?: number };

export const Route = createFileRoute("/_protected/approval-policies")({
	beforeLoad: () => requireFeature("approval-policies"),
	validateSearch: (search: Record<string, unknown>): PoliciesSearch => {
		const version = Number(search.version);
		return {
			policy: typeof search.policy === "string" ? search.policy : undefined,
			version: Number.isInteger(version) && version > 0 ? version : undefined,
		};
	},
	component: ApprovalPoliciesPage,
});

const EFFECT_DOT: Record<ApprovalPolicyEffect, string> = {
	require_approval: "bg-warning",
	auto_approve: "bg-success",
	auto_deny: "bg-destructive",
};

const EFFECT_LABEL: Record<ApprovalPolicyEffect, string> = {
	require_approval: "Require approval",
	auto_approve: "Auto-approve",
	auto_deny: "Auto-deny",
};

function describeMatch(policy: ApprovalPolicy): string {
	return describePolicyMatch(policy);
}

function MatchSummary({ policy }: { policy: ApprovalPolicy }) {
	const scope = scopeOf(policy);
	const target =
		scope === "specific_action"
			? `Action: ${policy.match.actionName}`
			: SCOPE_LABEL[scope];
	const conditions = describePolicyConditions(policy.match).join(" · ");
	return (
		<span className="flex min-w-0 flex-col gap-0.5">
			<span className="flex min-w-0 items-center gap-2">
				<span className="truncate" title={target}>
					{target}
				</span>
				<span className="flex shrink-0 gap-1">
					<ReviewBadge policy={policy} />
					<ManagedBadge policy={policy} />
				</span>
			</span>
			{conditions ? (
				<span className="truncate font-mono text-xs" title={conditions}>
					{conditions}
				</span>
			) : null}
		</span>
	);
}

function DecidedByCell({ policy }: { policy: ApprovalPolicy }) {
	const decided = policyDecidedBy(policy);
	return (
		<span className="flex min-w-0 flex-col gap-0.5">
			<span
				className={cn(
					"truncate",
					decided.label === "Automatic" && "text-muted-foreground",
				)}
			>
				{decided.label}
			</span>
			{decided.note ? (
				<span className="truncate text-muted-foreground text-xs">
					{decided.note}
				</span>
			) : null}
		</span>
	);
}

function ManagedBadge({ policy }: { policy: ApprovalPolicy }) {
	if (!policy.managedBy) return null;
	return (
		<Badge
			title={`Managed by policy file "${policy.managedBy.file}" (key ${policy.managedBy.key}). Change it in the file and apply.`}
			variant="info"
		>
			File: {policy.managedBy.file}
		</Badge>
	);
}

const MANAGED_HINT =
	"Managed by a policy file. Change it in the file and apply with anlyon-policy.";

function ReviewBadge({ policy }: { policy: ApprovalPolicy }) {
	if (!policy.needsScopeReview) return null;
	return (
		<Badge
			title="Created before policies had to say what they apply to. Its scope is broader than its name may suggest. Edit it to confirm."
			variant="warning"
		>
			Review scope
		</Badge>
	);
}

export function ApprovalPoliciesPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const query = useApprovalPolicies(workspaceId);
	const policies: ApprovalPolicy[] = query.data ?? [];
	const remove = useDeleteApprovalPolicy(workspaceId);
	const can = useCan(workspaceId);
	const navigate = Route.useNavigate();
	const { policy: selectedId, version: highlightVersion } = Route.useSearch();
	const selected = policies.find((policy) => policy.id === selectedId) ?? null;
	const deletedId =
		selectedId && !selected && query.isSuccess ? selectedId : null;
	const select = (policyId: string | null) =>
		navigate({ search: policyId ? { policy: policyId } : {} });
	const isEmpty = !query.isLoading && policies.length === 0;

	const newPolicy = (
		<PolicyFormDialog
			trigger={<Button size="sm">New policy</Button>}
			workspaceId={workspaceId}
		/>
	);

	return (
		<Page>
			<PageHeader
				actions={can("policies.manage") && !isEmpty ? newPolicy : undefined}
				description="Rules that approve a call, deny it, or hold it for a person. They run in priority order, and the earliest match decides."
				title="Policies"
			/>
			{isFeatureEnabled("ai-assistant") && can("assistant.manage") ? (
				<PolicySuggestions workspaceId={workspaceId} />
			) : null}
			{query.isLoading ? (
				<ListFrame>
					<ListLoading rows={3} />
				</ListFrame>
			) : policies.length === 0 ? (
				<ListFrame>
					<ListEmpty
						action={can("policies.manage") ? newPolicy : undefined}
						description="Until you add one, each action follows its own approval setting. Add a policy to hold or deny calls based on what they would do."
						title="No policies yet"
					/>
				</ListFrame>
			) : (
				<ListFrame
					footer={
						<>
							<span className="tabular-nums">
								{policies.length}{" "}
								{policies.length === 1 ? "policy" : "policies"}
							</span>
							<span>Lower numbers run earlier.</span>
						</>
					}
				>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-20">Priority</TableHead>
								<TableHead className="w-[24%]">Name</TableHead>
								<TableHead className="hidden md:table-cell">Matches</TableHead>
								<TableHead className="w-40">Effect</TableHead>
								<TableHead className="hidden w-44 lg:table-cell">
									Decided by
								</TableHead>
								<TableHead className="hidden w-24 text-right sm:table-cell">
									Approvers
								</TableHead>
								<TableHead className="hidden w-24 sm:table-cell">
									Enabled
								</TableHead>
								<TableHead className="hidden w-36 md:table-cell">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{policies.map((policy) => (
								<TableRow
									className={cn(
										"cursor-pointer",
										!policy.enabled && "text-muted-foreground",
									)}
									data-state={selectedId === policy.id ? "selected" : undefined}
									key={policy.id}
									onClick={() => select(policy.id)}
								>
									<TableCell className="py-3 font-mono text-[13px] text-muted-foreground tabular-nums">
										{policy.priority}
									</TableCell>
									<TableCell className="max-w-0 py-3">
										<button
											aria-label={`View policy ${policy.name}`}
											className="block w-full truncate rounded-sm text-left font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
											type="button"
										>
											{policy.name}
										</button>
									</TableCell>
									<TableCell className="hidden max-w-0 py-3 text-muted-foreground md:table-cell">
										<MatchSummary policy={policy} />
									</TableCell>
									<TableCell className="py-3">
										<span className="inline-flex items-center gap-2">
											<StatusDot className={EFFECT_DOT[policy.effect]} />
											{EFFECT_LABEL[policy.effect] ?? policy.effect}
										</span>
									</TableCell>
									<TableCell className="hidden max-w-0 py-3 lg:table-cell">
										<DecidedByCell policy={policy} />
									</TableCell>
									<TableCell className="hidden py-3 text-right tabular-nums sm:table-cell">
										{policy.requiredApprovals}
									</TableCell>
									<TableCell className="hidden py-3 sm:table-cell">
										<EnabledLabel enabled={policy.enabled} />
									</TableCell>
									<TableCell
										className="hidden py-2 text-right md:table-cell"
										onClick={(e) => e.stopPropagation()}
									>
										{policy.managedBy ? (
											<span className="text-muted-foreground text-xs">
												Edit in file
											</span>
										) : !can("policies.manage", policy.environmentId) ? null : (
											<span className="inline-flex gap-1">
												<PolicyFormDialog
													policy={policy}
													trigger={
														<Button size="xs" variant="ghost">
															Edit
														</Button>
													}
													workspaceId={workspaceId}
												/>
												<DeletePolicy
													onConfirm={() => remove.mutate(policy.id)}
													pending={remove.isPending}
													policy={policy}
													trigger={
														<Button
															disabled={remove.isPending}
															size="xs"
															variant="ghost"
														>
															Delete
														</Button>
													}
												/>
											</span>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</ListFrame>
			)}

			<DetailSheet
				description={selected?.id ?? deletedId ?? undefined}
				onClose={() => select(null)}
				open={selected !== null || deletedId !== null}
				title={selected?.name ?? (deletedId ? "Deleted policy" : "Policy")}
			>
				{deletedId ? (
					<>
						<p className="text-muted-foreground text-sm">
							This policy no longer exists. Its retained history is kept as
							evidence for the decisions it governed.
						</p>
						<DetailField label="History">
							<PolicyHistory
								highlightVersion={highlightVersion}
								policyId={deletedId}
								workspaceId={workspaceId}
							/>
						</DetailField>
					</>
				) : null}
				{selected ? (
					<>
						{selected.managedBy ? (
							<p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
								{MANAGED_HINT} File{" "}
								<span className="font-mono">{selected.managedBy.file}</span>,
								key <span className="font-mono">{selected.managedBy.key}</span>.
							</p>
						) : !can("policies.manage", selected.environmentId) ? null : (
							<div className="flex gap-2">
								<PolicyFormDialog
									policy={selected}
									trigger={
										<Button size="sm" variant="outline">
											Edit policy
										</Button>
									}
									workspaceId={workspaceId}
								/>
								<DeletePolicy
									onConfirm={() => remove.mutate(selected.id)}
									pending={remove.isPending}
									policy={selected}
									trigger={
										<Button
											disabled={remove.isPending}
											size="sm"
											variant="destructive-outline"
										>
											Delete policy
										</Button>
									}
								/>
							</div>
						)}
						<dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
							<PolicyFact label="Effect">
								<span className="inline-flex items-center gap-2">
									<StatusDot className={EFFECT_DOT[selected.effect]} />
									{EFFECT_LABEL[selected.effect] ?? selected.effect}
								</span>
							</PolicyFact>
							<PolicyFact label="Enabled">
								<EnabledLabel enabled={selected.enabled} />
							</PolicyFact>
							<PolicyFact label="Priority">
								<span className="tabular-nums">{selected.priority}</span>
							</PolicyFact>
							<PolicyFact label="Required approvals">
								<span className="tabular-nums">
									{selected.requiredApprovals}
								</span>
							</PolicyFact>
							<PolicyFact label="Decided by">
								<DecidedByCell policy={selected} />
							</PolicyFact>
							<PolicyFact label="Version">v{selected.version}</PolicyFact>
							<PolicyFact className="col-span-2" label="Matches">
								<span className="inline-flex flex-wrap items-center gap-2">
									{describeMatch(selected)}
									<ReviewBadge policy={selected} />
									<ManagedBadge policy={selected} />
								</span>
							</PolicyFact>
							<PolicyFact label="Created">
								<RelativeTime value={selected.createdAt} />
							</PolicyFact>
							<PolicyFact label="Updated">
								<RelativeTime value={selected.updatedAt} />
							</PolicyFact>
						</dl>
						{selected.match ? (
							<DetailField label="Match rules">
								<DetailCode>
									{JSON.stringify(selected.match, null, 2)}
								</DetailCode>
							</DetailField>
						) : null}
						<DetailField label="History">
							<PolicyHistory
								highlightVersion={highlightVersion}
								policyId={selected.id}
								workspaceId={workspaceId}
							/>
						</DetailField>
					</>
				) : null}
			</DetailSheet>
		</Page>
	);
}

function PolicyFact({
	label,
	className,
	children,
}: {
	label: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={cn("min-w-0 space-y-0.5", className)}>
			<dt className="text-muted-foreground text-xs">{label}</dt>
			<dd className="min-w-0 break-words">{children}</dd>
		</div>
	);
}

function DeletePolicy({
	policy,
	trigger,
	pending,
	onConfirm,
}: {
	policy: ApprovalPolicy;
	trigger: React.ReactElement;
	pending: boolean;
	onConfirm: () => void;
}) {
	return (
		<AlertDialog>
			<AlertDialogTrigger render={trigger} />
			<AlertDialogPopup>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {policy.name}?</AlertDialogTitle>
					<AlertDialogDescription>
						Calls it matched go to the next policy in priority order, or to each
						action's own approval setting. Its history is kept as evidence for
						the decisions it governed.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogClose
						render={<Button variant="outline">Cancel</Button>}
					/>
					<AlertDialogClose
						render={
							<Button
								disabled={pending}
								onClick={onConfirm}
								variant="destructive"
							>
								Delete policy
							</Button>
						}
					/>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}

function EnabledLabel({ enabled }: { enabled: boolean }) {
	return (
		<span className="inline-flex items-center gap-2">
			<StatusDot
				className={enabled ? "bg-success" : "bg-muted-foreground/60"}
			/>
			{enabled ? "On" : "Off"}
		</span>
	);
}
