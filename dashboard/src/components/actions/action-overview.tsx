"use client";

import { Link } from "@tanstack/react-router";
import { Check, ChevronRight, Minus, Trash2 } from "lucide-react";
import type * as React from "react";
import {
	AdapterDeclarations,
	DeclarationsForm,
} from "@/components/actions/declarations-form";
import { DetailCode, DetailField } from "@/components/actions/detail-sheet";
import { PolicyFormDialog } from "@/components/approvals/policy-form-dialog";
import { ListFrame, PageSection } from "@/components/layout/page";
import { ServerDescription } from "@/components/mcp-servers/server-description";
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
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	useDeleteAction,
	useInvocations,
	useSecrets,
	useUpdateAction,
} from "@/hooks/api/use-actions";
import { useApprovalPolicies } from "@/hooks/api/use-approval-policies";
import { useImpactLimits } from "@/hooks/api/use-effects";
import type { AdoptedToolSource } from "@/hooks/api/use-mcp-upstreams";
import { useCan } from "@/hooks/api/use-permissions";
import {
	actionHost,
	approvalLines,
	CALL_STATUS,
	inputRows,
	limitLines,
} from "@/lib/action-summary";
import { secretIntegrationId } from "@/lib/integration-catalog";
import { LOOSE_CHECK_TEXT } from "@/lib/mcp-servers";
import {
	policiesForAction,
	SCOPE_LABEL,
	scopeOf,
} from "@/lib/policy-targeting";
import type { Action, Secret } from "@/lib/types";
import { cn } from "@/lib/utils";

const dateTime = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

export function ActionOverview({
	action,
	workspaceId,
	source = null,
}: {
	action: Action;
	workspaceId?: string;
	source?: AdoptedToolSource | null;
}) {
	const environmentId = action.environmentId;
	const can = useCan(workspaceId);
	const canPolicies = can("policies.manage", environmentId);
	const canLimits = can("limits.manage", environmentId);
	const policies = useApprovalPolicies(workspaceId, environmentId).data ?? [];
	const limits = useImpactLimits(workspaceId, environmentId).data ?? [];
	const secrets = useSecrets(workspaceId).data ?? [];
	const calls =
		useInvocations(workspaceId, { action: action.name, limit: 3 }).data?.data ??
		[];

	const approvals = approvalLines(policies, action);
	const counted = limitLines(limits, action);
	const inputs = inputRows(action);
	const connected = secrets.filter(
		(secret: Secret) =>
			secretIntegrationId(secret) !== null &&
			action.secrets.includes(secret.name),
	);

	return (
		<>
			<PageSection title="When your agent calls it">
				<div className="max-w-2xl space-y-4">
					<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
						{source ? (
							<WhatAToolDoes action={action} source={source} />
						) : (
							<WhatItDoes action={action} connected={connected} />
						)}
					</p>
					{source && action.description ? (
						<ServerDescription
							label="What your agent reads about it. It starts as the server's text."
							text={action.description}
						/>
					) : null}
				</div>
			</PageSection>

			<PageSection title="Safeguards">
				<ul className="divide-y overflow-hidden rounded-lg border bg-card">
					{source?.schemaCheck === "loose" ? (
						<SafeguardRow
							on={false}
							text="Loosely checked"
							detail={LOOSE_CHECK_TEXT}
						/>
					) : null}
					{source && source.state !== "current" ? (
						<SafeguardRow
							on
							text="Calls are refused"
							detail={
								source.state === "changed"
									? "The server changed this tool after it was adopted. Read what it says now on the server's page, and re-adopt it if you still trust it."
									: "The server no longer lists this tool. If it comes back unchanged, calls work again."
							}
						/>
					) : null}
					{approvals.length === 0 ? (
						<SafeguardRow
							on={false}
							text="Runs without approval"
							detail="No policy asks a person to approve calls to this action."
							aside={
								canPolicies && (
									<PolicyFormDialog
										initial={{ environmentId, actionName: action.name }}
										trigger={
											<Button size="sm" variant="outline">
												Require approval
											</Button>
										}
										workspaceId={workspaceId}
									/>
								)
							}
						/>
					) : (
						approvals.map((line) => {
							const policy = policies.find((p) => p.id === line.policyId);
							return (
								<SafeguardRow
									key={line.policyId ?? "action-flag"}
									on
									text={line.text}
									detail={
										<>
											{line.source}
											{line.code ? (
												<code className="mt-1 block font-mono text-xs">
													{line.code}
												</code>
											) : null}
										</>
									}
									aside={
										canPolicies && policy && !policy.managedBy ? (
											<PolicyFormDialog
												policy={policy}
												trigger={
													<Button size="sm" variant="ghost">
														Edit
													</Button>
												}
												workspaceId={workspaceId}
											/>
										) : null
									}
								/>
							);
						})
					)}
					{action.impact === null ? null : counted.length === 0 ? (
						<SafeguardRow
							on={false}
							text="No limit counts these calls"
							detail="A limit refuses a call that would go past it."
							aside={
								canLimits && (
									<Button
										render={
											<Link search={{ environmentId }} to="/actions/limits" />
										}
										size="sm"
										variant="outline"
									>
										Add a limit
									</Button>
								)
							}
						/>
					) : (
						counted.map((limit) => (
							<SafeguardRow
								key={limit.id}
								on
								text={`Counts toward ${limit.name}`}
								detail={limit.usage}
								aside={
									canLimits && (
										<Button
											render={
												<Link search={{ environmentId }} to="/actions/limits" />
											}
											size="sm"
											variant="ghost"
										>
											Edit
										</Button>
									)
								}
							/>
						))
					)}
					{source ? (
						<SafeguardRow
							on={false}
							text="Not read back after the call"
							detail="Anlyon records what the server answered, but an MCP tool gives it nothing to read the result back with, so its receipts read acknowledged."
						/>
					) : action.verify ? (
						<SafeguardRow
							on
							text="Checked after every call"
							detail="Anlyon reads the result back from the API to confirm it happened."
						/>
					) : action.adapter ? (
						<SafeguardRow
							on
							text="Checked after every call"
							detail="The built-in step confirms the result with the provider."
						/>
					) : (
						<SafeguardRow
							on={false}
							text="Not checked after the call"
							detail="Anlyon records what the API answered but does not read the result back."
						/>
					)}
				</ul>
			</PageSection>

			{inputs.length > 0 ? (
				<PageSection title="What your agent sends">
					<ListFrame>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-44">Field</TableHead>
									<TableHead>What it is</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{inputs.map((input) => (
									<TableRow key={input.name}>
										<TableCell className="py-2.5 align-top font-mono text-xs">
											<span translate="no">{input.name}</span>
											{input.required ? null : (
												<span className="ms-1.5 font-sans text-muted-foreground">
													optional
												</span>
											)}
										</TableCell>
										<TableCell className="whitespace-normal py-2.5 align-top text-muted-foreground">
											<span className="line-clamp-3" title={input.hint}>
												{input.hint}
											</span>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</ListFrame>
				</PageSection>
			) : null}

			<PageSection
				actions={
					<Link
						className="inline-flex items-center gap-1 rounded-sm text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
						search={{ invocation: undefined, status: undefined }}
						to="/actions/invocations"
					>
						See all calls
						<ChevronRight aria-hidden="true" className="size-3.5" />
					</Link>
				}
				title="Recent calls"
			>
				{calls.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No calls yet. Calls appear here as soon as your agent makes one.
					</p>
				) : (
					<ul className="divide-y overflow-hidden rounded-lg border bg-card text-sm">
						{calls.map((call) => {
							const status = CALL_STATUS[call.status];
							return (
								<li key={call.id}>
									<Link
										className="flex items-center justify-between gap-3 px-4 py-2.5 outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
										search={{ invocation: call.id, status: undefined }}
										to="/actions/invocations"
									>
										<span className="text-muted-foreground tabular-nums">
											{dateTime.format(new Date(call.createdAt))}
										</span>
										<Badge
											variant={
												status.tone === "good"
													? "success"
													: status.tone === "wait"
														? "warning"
														: status.tone === "bad"
															? "error"
															: "outline"
											}
										>
											{status.label}
										</Badge>
									</Link>
								</li>
							);
						})}
					</ul>
				)}
			</PageSection>

			<div className="border-y">
				<Disclosure
					hint="What one call changes, and how Anlyon reads it back"
					title="Counting and checking"
				>
					{action.adapter ? (
						<AdapterDeclarations action={action} workspaceId={workspaceId} />
					) : (
						<DeclarationsForm
							action={action}
							key={`${action.id}:${action.updatedAt}`}
							workspaceId={workspaceId}
						/>
					)}
				</Disclosure>
				<Disclosure
					hint="Request, input schema, policy order, ID"
					title="Technical details"
				>
					<TechnicalDetails
						action={action}
						policies={policiesForAction(policies, action.name)}
						source={source}
					/>
				</Disclosure>
			</div>
		</>
	);
}

export function ActionControls({
	action,
	workspaceId,
	onDeleted,
}: {
	action: Action;
	workspaceId?: string;
	onDeleted: () => void;
}) {
	const canManage = useCan(workspaceId)("actions.manage", action.environmentId);
	const updateAction = useUpdateAction();
	if (!canManage) return null;
	return (
		<>
			<DeleteAction
				action={action}
				onDeleted={onDeleted}
				workspaceId={workspaceId}
			/>
			<Button
				disabled={!workspaceId || updateAction.isPending}
				onClick={() => {
					if (!workspaceId) return;
					updateAction.mutate({
						ref: action.name,
						workspaceId,
						enabled: !action.enabled,
					});
				}}
				size="sm"
				variant={action.enabled ? "outline" : "default"}
			>
				{action.enabled ? "Turn off" : "Turn on"}
			</Button>
		</>
	);
}

function WhatAToolDoes({
	action,
	source,
}: {
	action: Action;
	source: AdoptedToolSource;
}) {
	return (
		<>
			Anlyon calls the tool{" "}
			<code className="font-mono text-foreground text-xs" translate="no">
				{source.tool}
			</code>{" "}
			on the <span translate="no">{source.server}</span> MCP server at{" "}
			<span className="font-medium text-foreground" translate="no">
				{actionHost(action.urlTemplate) ?? source.url}
			</span>
			, with the account of the user each call is made for. The agent never sees
			the token.
		</>
	);
}

function WhatItDoes({
	action,
	connected,
}: {
	action: Action;
	connected: Secret[];
}) {
	if (action.adapter) {
		return (
			<>
				Anlyon runs the built-in{" "}
				<span className="font-mono text-xs">{action.adapter.type}</span> step
				with the stored credentials. The agent never sees them.
			</>
		);
	}
	const host = actionHost(action.urlTemplate);
	const account = connected[0];
	return (
		<>
			Anlyon sends a {action.method} request to{" "}
			<span className="font-medium text-foreground">
				{host ?? "the action's API"}
			</span>
			{account ? (
				<>
					{" "}
					as the connected{" "}
					<span translate="no">{secretIntegrationId(account)}</span> account{" "}
					<span className="font-mono text-xs">{account.name}</span>
					{(account.health?.status ?? account.connection?.status) ===
					"needs_reauth"
						? ", which needs reconnecting"
						: ""}
					. The agent never sees its token.
				</>
			) : action.secrets.length > 0 ? (
				<>
					{" "}
					using the stored {action.secrets.length === 1 ? "secret" : "secrets"}{" "}
					<span className="font-mono text-xs">{action.secrets.join(", ")}</span>
					. The agent never sees {action.secrets.length === 1 ? "it" : "them"}.
				</>
			) : (
				"."
			)}
		</>
	);
}

function SafeguardRow({
	on,
	text,
	detail,
	aside,
}: {
	on: boolean;
	text: string;
	detail: React.ReactNode;
	aside?: React.ReactNode;
}) {
	return (
		<li className="flex items-start gap-3 px-4 py-3" data-testid="safeguard">
			<span
				aria-hidden="true"
				className={cn(
					"mt-px flex size-5 shrink-0 items-center justify-center rounded-full",
					on
						? "bg-success/10 text-success-foreground"
						: "bg-muted text-muted-foreground",
				)}
			>
				{on ? <Check className="size-3.5" /> : <Minus className="size-3.5" />}
			</span>
			<div className="min-w-0 flex-1 text-sm">
				<div className="font-medium">{text}</div>
				<div className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
					{detail}
				</div>
			</div>
			{aside ? <div className="shrink-0">{aside}</div> : null}
		</li>
	);
}

function Disclosure({
	title,
	hint,
	children,
}: {
	title: string;
	hint: string;
	children: React.ReactNode;
}) {
	return (
		<Collapsible className="border-b last:border-b-0">
			<CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 py-3.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
				<span className="font-medium">{title}</span>
				<span className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
					<span className="truncate">{hint}</span>
					<ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
				</span>
			</CollapsibleTrigger>
			<CollapsiblePanel>
				<div className="space-y-5 pb-6">{children}</div>
			</CollapsiblePanel>
		</Collapsible>
	);
}

function TechnicalDetails({
	action,
	policies,
	source,
}: {
	action: Action;
	policies: ReturnType<typeof policiesForAction>;
	source: AdoptedToolSource | null;
}) {
	if (source) {
		return (
			<>
				<div className="grid grid-cols-2 gap-4">
					<DetailField label="Tool">
						<span className="font-mono text-xs" translate="no">
							{source.tool}
						</span>
					</DetailField>
					<DetailField label="Action ID">
						<span className="font-mono text-xs">{action.id}</span>
					</DetailField>
				</div>
				<DetailField label="Server endpoint">
					<DetailCode>{source.url}</DetailCode>
				</DetailField>
				{source.toolHash ? (
					<DetailField label="Pinned definition">
						<DetailCode>{source.toolHash}</DetailCode>
					</DetailField>
				) : null}
				<DetailField label="Input schema, from the server">
					<DetailCode>{JSON.stringify(action.inputSchema, null, 2)}</DetailCode>
				</DetailField>
				<PolicyOrder policies={policies} />
			</>
		);
	}
	return (
		<>
			<div className="grid grid-cols-2 gap-4">
				<DetailField label="Method">
					<span className="font-mono text-xs">{action.method}</span>
				</DetailField>
				<DetailField label="Action ID">
					<span className="font-mono text-xs">{action.id}</span>
				</DetailField>
			</div>
			<DetailField label="URL template">
				<DetailCode>{action.urlTemplate}</DetailCode>
			</DetailField>
			<DetailField label="Headers">
				<DetailCode>{JSON.stringify(action.headers, null, 2)}</DetailCode>
			</DetailField>
			{action.bodyTemplate ? (
				<DetailField label="Body template">
					<DetailCode>
						{JSON.stringify(action.bodyTemplate, null, 2)}
					</DetailCode>
				</DetailField>
			) : null}
			<DetailField label="Input schema">
				<DetailCode>{JSON.stringify(action.inputSchema, null, 2)}</DetailCode>
			</DetailField>
			<PolicyOrder policies={policies} />
		</>
	);
}

function PolicyOrder({
	policies,
}: {
	policies: ReturnType<typeof policiesForAction>;
}) {
	return (
		<DetailField label="Policies in the order they are checked">
			{policies.length === 0 ? (
				<span className="text-muted-foreground">None.</span>
			) : (
				<ol className="space-y-1">
					{policies.map((policy) => (
						<li className="flex flex-wrap items-center gap-2" key={policy.id}>
							<span className="font-mono text-muted-foreground text-xs tabular-nums">
								{policy.priority}
							</span>
							<span>{policy.name}</span>
							<span className="text-muted-foreground text-xs">
								{SCOPE_LABEL[scopeOf(policy)]}
								{policy.enabled ? "" : " · off"}
							</span>
						</li>
					))}
				</ol>
			)}
		</DetailField>
	);
}

function DeleteAction({
	action,
	workspaceId,
	onDeleted,
}: {
	action: Action;
	workspaceId?: string;
	onDeleted: () => void;
}) {
	const deleteAction = useDeleteAction();
	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={
					<Button
						className="text-destructive-foreground"
						disabled={!workspaceId || deleteAction.isPending}
						size="sm"
						variant="ghost"
					>
						<Trash2 aria-hidden="true" className="size-4" />
						Delete action
					</Button>
				}
			/>
			<AlertDialogPopup>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete action?</AlertDialogTitle>
					<AlertDialogDescription>
						Agents will no longer be able to call “{action.name}”. Its versions
						and call history are kept. The name becomes free to reuse. To stop
						calls for now, turn it off instead.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogClose
						render={<Button variant="outline">Cancel</Button>}
					/>
					<AlertDialogClose
						render={
							<Button
								onClick={() => {
									if (!workspaceId) return;
									deleteAction.mutate(
										{ ref: action.name, workspaceId },
										{ onSuccess: onDeleted },
									);
								}}
								variant="destructive"
							>
								Delete
							</Button>
						}
					/>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}
