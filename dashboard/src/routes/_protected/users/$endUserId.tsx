"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { StatusDot } from "@/components/actions/detail-sheet";
import { IntegrationLogo } from "@/components/actions/integration-logo";
import {
	Available,
	periodLabel,
	UsageBar,
} from "@/components/governance/limit-usage";
import { ListEmpty, ListLoading } from "@/components/governance/list-empty";
import {
	DetailLayout,
	ListFrame,
	Page,
	PageHeader,
	PageSection,
	PropertyList,
} from "@/components/layout/page";
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
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { useInvocations } from "@/hooks/api/use-actions";
import { useApprovals } from "@/hooks/api/use-approvals";
import {
	useEndUserConnections,
	useEndUserLimits,
	useEraseEndUser,
	useRevokeEndUserConnection,
} from "@/hooks/api/use-end-users";
import { useEnvironments } from "@/hooks/api/use-environments";
import { useCan } from "@/hooks/api/use-permissions";
import { CONNECTION_STATUS_LABEL, integrationName } from "@/lib/end-users";
import { requireFeature } from "@/lib/feature-flags";
import type {
	EndUserConnection,
	EndUserConnectionStatus,
	InvocationStatus,
} from "@/lib/types";

type UserSearch = { environmentId?: string };

export const Route = createFileRoute("/_protected/users/$endUserId")({
	beforeLoad: () => requireFeature("connected-accounts"),
	validateSearch: (search: Record<string, unknown>): UserSearch => ({
		environmentId:
			typeof search.environmentId === "string"
				? search.environmentId
				: undefined,
	}),
	component: UserRoute,
});

function UserRoute() {
	const { endUserId } = Route.useParams();
	const { environmentId } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<UserPage
			endUserId={endUserId}
			environmentId={environmentId}
			onErased={() => navigate({ to: "/users", search: { environmentId } })}
		/>
	);
}

const STATUS_DOT: Record<EndUserConnectionStatus, string> = {
	active: "bg-success",
	needs_reconnect: "bg-warning",
	revoked: "bg-muted-foreground/60",
};

const INVOCATION_DOT: Partial<Record<InvocationStatus, string>> = {
	succeeded: "bg-success",
	failed: "bg-destructive",
	denied: "bg-destructive",
	unknown: "bg-warning",
	pending_approval: "bg-warning",
	running: "bg-info",
};

const INVOCATION_LABEL: Record<InvocationStatus, string> = {
	succeeded: "Succeeded",
	failed: "Failed",
	denied: "Denied",
	unknown: "Unknown",
	pending_approval: "Pending approval",
	running: "Running",
	expired: "Expired",
};

export function UserPage({
	endUserId,
	environmentId,
	onErased,
}: {
	endUserId: string;
	environmentId: string | undefined;
	onErased: () => void;
}) {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const environments = useEnvironments(workspaceId).data ?? [];
	const environment =
		environments.find((env) => env.id === environmentId) ??
		environments.find((env) => env.isDefault);
	const can = useCan(workspaceId);
	const canManage = can("connections.manage", environmentId);
	const canManageLimits = can("limits.manage", environmentId);
	const connections = useEndUserConnections(
		workspaceId,
		environmentId,
		endUserId,
	);
	const limits = useEndUserLimits(workspaceId, environmentId, endUserId);
	const invocations = useInvocations(workspaceId, {
		endUserId,
		environmentId,
		limit: 10,
	});
	const teamApprovals = useApprovals(workspaceId, {
		endUserId,
		environmentId,
		status: "pending",
		limit: 20,
	});
	const userApprovals = useApprovals(workspaceId, {
		endUserId,
		environmentId,
		status: "pending",
		decider: "end_user",
		limit: 20,
	});
	const approvals = {
		isLoading: teamApprovals.isLoading || userApprovals.isLoading,
		isError: teamApprovals.isError || userApprovals.isError,
	};
	const rows = connections.data ?? [];
	const userLimits = limits.data ?? [];
	const calls = invocations.data?.data ?? [];
	const pending = [
		...(userApprovals.data?.data ?? []),
		...(teamApprovals.data?.data ?? []),
	].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const pendingTotal =
		(teamApprovals.data?.pagination?.total ?? 0) +
		(userApprovals.data?.pagination?.total ?? 0);
	const activeConnections = rows.filter((row) => row.status === "active");

	const rail = (
		<>
			<PropertyList
				items={[
					{
						label: "User id",
						value: (
							<span className="break-all font-mono text-[13px]" translate="no">
								{endUserId}
							</span>
						),
					},
					{
						label: "Environment",
						value: environment?.name ?? "Default",
					},
					{
						label: "Connected accounts",
						value: connections.isLoading ? (
							"…"
						) : (
							<span className="tabular-nums">
								{activeConnections.length} active
								{rows.length > activeConnections.length ? (
									<span className="text-muted-foreground">
										{" "}
										of {rows.length}
									</span>
								) : null}
							</span>
						),
					},
					{
						label: "Waiting on a decision",
						value: approvals.isLoading ? (
							"…"
						) : (
							<span className="tabular-nums">{pendingTotal}</span>
						),
					},
					{
						label: "Last call",
						value: invocations.isLoading ? (
							"…"
						) : calls[0] ? (
							<RelativeTime value={calls[0].createdAt} />
						) : (
							<span className="text-muted-foreground">None yet</span>
						),
					},
				]}
				title="Details"
			/>
			{canManage ? (
				<div className="flex flex-col items-start gap-3 border-t pt-6">
					<div>
						<p className="font-medium text-sm">Erase this user</p>
						<p className="mt-1 text-pretty text-muted-foreground text-xs leading-relaxed">
							Deletes their connections, limit counters and pending approvals.
							Receipts stay, with the id hashed.
						</p>
					</div>
					<EraseUser
						endUserId={endUserId}
						environmentId={environmentId}
						onErased={onErased}
						workspaceId={workspaceId}
					/>
				</div>
			) : null}
		</>
	);

	return (
		<Page>
			<PageHeader
				description={environment ? `In ${environment.name}` : undefined}
				eyebrow="User"
				mono
				title={<span translate="no">{endUserId}</span>}
			/>

			<DetailLayout rail={rail}>
				<PageSection
					description="Accounts this user connected. Your agent acts in them for this user and no one else."
					title="Connections"
				>
					<ListFrame>
						{connections.isError ? (
							<p className="p-5 text-destructive text-sm" role="alert">
								Connections could not be loaded:{" "}
								{(connections.error as Error).message}
							</p>
						) : connections.isLoading ? (
							<ListLoading rowClassName="h-8" rows={2} />
						) : rows.length === 0 ? (
							<ListEmpty
								description={
									<>
										When your agent needs one, the call answers{" "}
										<code className="font-mono text-xs" translate="no">
											END_USER_NOT_CONNECTED
										</code>{" "}
										with a link your app shows this user.
									</>
								}
								title="No connections yet"
							/>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Integration</TableHead>
										<TableHead className="hidden lg:table-cell">
											Scopes
										</TableHead>
										<TableHead className="hidden w-32 sm:table-cell">
											Connected
										</TableHead>
										{canManage ? (
											<TableHead className="w-24">
												<span className="sr-only">Manage</span>
											</TableHead>
										) : null}
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((connection) => (
										<ConnectionRow
											canManage={canManage}
											connection={connection}
											endUserId={endUserId}
											environmentId={environmentId}
											key={connection.integration}
											workspaceId={workspaceId}
										/>
									))}
								</TableBody>
							</Table>
						)}
					</ListFrame>
				</PageSection>

				{/* biome-ignore lint/correctness/useUniqueElementIds: one per page, the target of a #approvals link */}
				<PageSection
					actions={
						<Button
							render={
								<Link
									search={{ endUser: endUserId, tab: "users" }}
									to="/approvals"
								/>
							}
							size="xs"
							variant="ghost"
						>
							Open in Approvals
						</Button>
					}
					description="Calls held for a decision. This user decides some in your app; your team decides the rest in Approvals."
					id="approvals"
					title="Pending approvals"
				>
					<ListFrame>
						{approvals.isLoading ? (
							<ListLoading rows={1} />
						) : approvals.isError ? (
							<p className="p-5 text-destructive text-sm" role="alert">
								Approvals could not be loaded.
							</p>
						) : pending.length === 0 ? (
							<ListEmpty title="No calls for this user are waiting on a decision." />
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Request</TableHead>
										<TableHead className="w-36">Decided by</TableHead>
										<TableHead className="hidden w-32 text-right sm:table-cell">
											Expires
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{pending.map((approval) => (
										<TableRow key={approval.id}>
											<TableCell className="max-w-0 py-3">
												<Link
													className="block truncate font-medium underline-offset-2 hover:underline"
													search={
														approval.decider === "end_user"
															? {
																	id: approval.id,
																	endUser: endUserId,
																	tab: "users",
																}
															: { id: approval.id }
													}
													to="/approvals"
												>
													{approval.title}
												</Link>
											</TableCell>
											<TableCell className="py-3 text-muted-foreground">
												{approval.decider === "end_user"
													? "The user"
													: "Your team"}
											</TableCell>
											<TableCell className="hidden py-3 text-right text-muted-foreground sm:table-cell">
												<RelativeTime value={approval.expiresAt} />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</ListFrame>
				</PageSection>

				<PageSection
					actions={
						<Button
							render={
								<Link
									search={{ environmentId: environment?.id ?? environmentId }}
									to="/actions/limits"
								/>
							}
							size="xs"
							variant="ghost"
						>
							Limits
						</Button>
					}
					description="Limits each user gets on their own, with this user's usage in the current period."
					title="Usage against limits"
				>
					<ListFrame>
						{limits.isError ? (
							<p className="p-5 text-destructive text-sm" role="alert">
								Limits could not be loaded: {(limits.error as Error).message}
							</p>
						) : limits.isLoading ? (
							<ListLoading rows={1} />
						) : userLimits.length === 0 ? (
							<ListEmpty
								action={
									canManageLimits ? (
										<Button
											render={
												<Link
													search={{
														environmentId: environment?.id ?? environmentId,
													}}
													to="/actions/limits"
												/>
											}
											size="sm"
											variant="outline"
										>
											Add a per-user limit
										</Button>
									) : undefined
								}
								description="A limit scoped to each user caps what your agent does for any one user, such as refunds a day."
								title="No per-user limits"
							/>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Limit</TableHead>
										<TableHead className="hidden w-56 sm:table-cell">
											Usage
										</TableHead>
										<TableHead className="w-32 text-right">Available</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{userLimits.map((limit) => (
										<TableRow key={limit.id}>
											<TableCell className="max-w-0 py-3">
												<p className="truncate font-medium">{limit.name}</p>
												<p className="truncate text-muted-foreground text-xs">
													{periodLabel(limit)}
													{limit.scope.actionName ? (
														<>
															{" · "}
															<span className="font-mono" translate="no">
																{limit.scope.actionName}
															</span>
														</>
													) : null}
												</p>
											</TableCell>
											<TableCell className="hidden py-3 sm:table-cell">
												<UsageBar limit={limit} />
											</TableCell>
											<TableCell className="py-3 text-right">
												<Available limit={limit} />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</ListFrame>
				</PageSection>

				<PageSection
					actions={
						<Button
							render={
								<Link
									search={{
										effect: undefined,
										environmentId,
										action: undefined,
										outcome: undefined,
										grade: undefined,
										unresolved: undefined,
										offset: undefined,
										endUser: endUserId,
									}}
									to="/actions/effects"
								/>
							}
							size="xs"
							variant="ghost"
						>
							Receipts
						</Button>
					}
					description="The latest calls your agent made for this user."
					title="Activity"
				>
					<ListFrame
						footer={
							calls.length > 0 ? (
								<>
									<span className="tabular-nums">
										Latest {calls.length}{" "}
										{calls.length === 1 ? "call" : "calls"}
									</span>
									<Link
										className="text-foreground underline underline-offset-2 hover:no-underline"
										search={{
											invocation: undefined,
											status: undefined,
											endUser: endUserId,
											environmentId,
										}}
										to="/actions/invocations"
									>
										View all invocations for {endUserId}
									</Link>
								</>
							) : undefined
						}
					>
						{invocations.isLoading ? (
							<ListLoading rows={2} />
						) : calls.length === 0 ? (
							<ListEmpty title="No invocations yet." />
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Action</TableHead>
										<TableHead className="w-44">Status</TableHead>
										<TableHead className="hidden w-32 text-right sm:table-cell">
											When
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{calls.map((invocation) => (
										<TableRow key={invocation.id}>
											<TableCell className="max-w-0 py-3">
												<Link
													className="block truncate font-medium font-mono text-[13px] underline-offset-2 hover:underline"
													search={{
														invocation: invocation.id,
														status: undefined,
														endUser: endUserId,
														environmentId,
													}}
													to="/actions/invocations"
													translate="no"
												>
													{invocation.actionName}
												</Link>
											</TableCell>
											<TableCell className="py-3">
												<span className="inline-flex items-center gap-2">
													<StatusDot
														className={
															INVOCATION_DOT[invocation.status] ??
															"bg-muted-foreground/60"
														}
													/>
													{INVOCATION_LABEL[invocation.status] ??
														invocation.status}
												</span>
											</TableCell>
											<TableCell className="hidden py-3 text-right text-muted-foreground sm:table-cell">
												<RelativeTime value={invocation.createdAt} />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</ListFrame>
				</PageSection>
			</DetailLayout>
		</Page>
	);
}

function ConnectionRow({
	connection,
	endUserId,
	environmentId,
	workspaceId,
	canManage,
}: {
	connection: EndUserConnection;
	endUserId: string;
	environmentId?: string;
	workspaceId?: string;
	canManage: boolean;
}) {
	const name = integrationName(connection.integration);
	const revoke = useRevokeEndUserConnection(workspaceId, environmentId);
	return (
		<TableRow>
			<TableCell className="max-w-0 py-3">
				<span className="flex min-w-0 items-center gap-3">
					<IntegrationLogo
						className="size-8 shrink-0"
						id={connection.integration}
						name={name}
					/>
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="truncate font-medium" translate="no">
							{name}
						</span>
						<span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
							<StatusDot className={STATUS_DOT[connection.status]} />
							{CONNECTION_STATUS_LABEL[connection.status] ?? connection.status}
						</span>
					</span>
				</span>
			</TableCell>
			<TableCell className="hidden max-w-0 py-3 lg:table-cell">
				<span
					className="block truncate font-mono text-muted-foreground text-xs"
					title={connection.scopes.join(" ")}
					translate="no"
				>
					{connection.scopes.length > 0 ? connection.scopes.join(", ") : "—"}
				</span>
			</TableCell>
			<TableCell className="hidden py-3 text-muted-foreground sm:table-cell">
				<RelativeTime value={connection.connectedAt} />
			</TableCell>
			{canManage ? (
				<TableCell className="py-2 text-right">
					{connection.status !== "revoked" ? (
						<AlertDialog>
							<AlertDialogTrigger
								render={
									<Button
										aria-label={`Revoke ${name} for ${endUserId}`}
										disabled={revoke.isPending}
										size="xs"
										variant="ghost"
									>
										Revoke
									</Button>
								}
							/>
							<AlertDialogPopup>
								<AlertDialogHeader>
									<AlertDialogTitle>
										Revoke {name} for {endUserId}?
									</AlertDialogTitle>
									<AlertDialogDescription>
										Anlyon revokes its access at {name} where {name} supports
										it, then deletes the connection. Your agent cannot act in
										this account until {endUserId} connects again.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogClose
										render={<Button variant="outline">Cancel</Button>}
									/>
									<AlertDialogClose
										render={
											<Button
												onClick={() =>
													revoke.mutate({
														endUserId,
														integration: connection.integration,
													})
												}
												variant="destructive"
											>
												Revoke {name}
											</Button>
										}
									/>
								</AlertDialogFooter>
							</AlertDialogPopup>
						</AlertDialog>
					) : null}
				</TableCell>
			) : null}
		</TableRow>
	);
}

function EraseUser({
	endUserId,
	environmentId,
	workspaceId,
	onErased,
}: {
	endUserId: string;
	environmentId?: string;
	workspaceId?: string;
	onErased: () => void;
}) {
	const confirmId = useId();
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const erase = useEraseEndUser(workspaceId, environmentId);
	const matches = typed.trim() === endUserId;

	return (
		<AlertDialog
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setTyped("");
			}}
			open={open}
		>
			<AlertDialogTrigger
				render={
					<Button size="sm" variant="destructive-outline">
						Erase user
					</Button>
				}
			/>
			<AlertDialogPopup>
				<AlertDialogHeader>
					<AlertDialogTitle>Erase {endUserId}?</AlertDialogTitle>
					<AlertDialogDescription>
						This deletes every connection {endUserId} has, resets their limit
						counters and cancels their pending approvals. Their receipts are
						kept for the audit trail, with the id replaced by a one-way hash.
						This cannot be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<div className="px-6 pb-2">
					<Field>
						<FieldLabel htmlFor={confirmId}>
							Type <span className="font-mono">{endUserId}</span> to confirm
						</FieldLabel>
						<Input
							autoComplete="off"
							className="font-mono"
							id={confirmId}
							onChange={(event) => setTyped(event.target.value)}
							spellCheck={false}
							translate="no"
							value={typed}
						/>
					</Field>
				</div>
				<AlertDialogFooter>
					<AlertDialogClose
						render={<Button variant="outline">Cancel</Button>}
					/>
					<Button
						disabled={!matches}
						loading={erase.isPending}
						onClick={() =>
							erase.mutate(
								{ endUserId },
								{
									onSuccess: () => {
										setOpen(false);
										onErased();
									},
								},
							)
						}
						variant="destructive"
					>
						Erase {endUserId}
					</Button>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}
