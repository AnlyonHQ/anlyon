"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import {
	ActionControls,
	ActionOverview,
} from "@/components/actions/action-overview";
import { IdValue, StatusDot } from "@/components/actions/detail-sheet";
import { EmptyRow } from "@/components/actions/empty-row";
import { ImportOpenApiDialog } from "@/components/actions/import-openapi-dialog";
import { InstallPackDialog } from "@/components/actions/install-pack-dialog";
import { ListSearch } from "@/components/actions/list-search";
import {
	DetailLayout,
	ListFrame,
	Page,
	PageHeader,
	PageToolbar,
	PropertyList,
} from "@/components/layout/page";
import { summaryOf } from "@/components/mcp-servers/server-description";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardFooterLink } from "@/components/ui/card";
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
import { useActions } from "@/hooks/api/use-actions";
import { useApprovalPolicies } from "@/hooks/api/use-approval-policies";
import { useAdoptedToolSource } from "@/hooks/api/use-mcp-upstreams";
import { useCan } from "@/hooks/api/use-permissions";
import {
	actionHost,
	GATE_LABEL,
	type GateSummary,
	gateSummary,
} from "@/lib/action-summary";
import type { Action, ApprovalPolicy } from "@/lib/types";

type ActionsSearch = {
	action: string | undefined;
	q?: string;
	import?: "openapi";
	vendor?: string;
};

export const Route = createFileRoute("/_protected/actions/")({
	validateSearch: (search: Record<string, unknown>): ActionsSearch => ({
		action: typeof search.action === "string" ? search.action : undefined,
		...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
		...(search.import === "openapi" ? { import: "openapi" as const } : {}),
		...(typeof search.vendor === "string" && search.vendor
			? { vendor: search.vendor.slice(0, 80) }
			: {}),
	}),
	component: ActionsPage,
});

const dateTime = new Intl.DateTimeFormat(undefined, {
	year: "numeric",
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

function matches(action: Action, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return [
		action.name,
		action.description ?? "",
		action.method,
		action.urlTemplate,
		...action.secrets,
	]
		.join(" ")
		.toLowerCase()
		.includes(needle);
}

function ActionsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const navigate = Route.useNavigate();
	const {
		action: selectedId,
		q: query = "",
		import: importKind,
		vendor,
	} = Route.useSearch();

	const actionsQuery = useActions(workspaceId);
	const policies = useApprovalPolicies(workspaceId).data ?? [];
	const actions = actionsQuery.data ?? [];
	const canInstall = useCan(workspaceId)("actions.manage");

	const select = (id: string | undefined) =>
		navigate({
			to: "/actions",
			search: (previous) => ({ ...previous, action: id }),
		});

	if (selectedId !== undefined) {
		const selected = actions.find((action) => action.id === selectedId);
		return (
			<ActionPage
				action={selected}
				isLoading={actionsQuery.isLoading}
				onDeleted={() => select(undefined)}
				policies={policies}
				workspaceId={workspaceId}
			/>
		);
	}

	const visible = actions.filter((action) => matches(action, query));
	const setQuery = (next: string) =>
		navigate({
			to: "/actions",
			replace: true,
			search: (previous) => ({ ...previous, q: next || undefined }),
		});

	return (
		<Page>
			<PageHeader
				actions={
					canInstall ? (
						<>
							<ImportOpenApiDialog
								vendor={importKind === "openapi" ? (vendor ?? "") : undefined}
								workspaceId={workspaceId}
							/>
							<InstallPackDialog workspaceId={workspaceId} />
						</>
					) : undefined
				}
				description="Calls your agent makes by name, such as sending an email or creating a deal. Anlyon adds the credential, so your agent never sees it."
				title="Actions"
			/>

			{actions.length > 0 ? (
				<PageToolbar>
					<ListSearch
						label="Search actions"
						onChange={setQuery}
						placeholder="Search by name, URL or secret…"
						value={query}
					/>
				</PageToolbar>
			) : null}

			{actionsQuery.isLoading ? (
				<ListFrame aria-busy="true" className="space-y-2" padded>
					{[0, 1, 2, 3].map((i) => (
						<Skeleton className="h-9 w-full rounded-lg" key={i} />
					))}
				</ListFrame>
			) : actions.length === 0 ? (
				<ListFrame padded>
					<EmptyRow
						action={
							<Button
								render={
									<a
										href="https://docs.anlyon.com/guides/packs"
										rel="noreferrer"
										target="_blank"
									/>
								}
								size="sm"
								variant="outline"
							>
								Read the packs guide
							</Button>
						}
						title="No actions yet"
					>
						Install a pack for an app such as Gmail or HubSpot, or import your
						own API's OpenAPI spec.
					</EmptyRow>
				</ListFrame>
			) : (
				<ListFrame
					footer={
						<>
							<span className="tabular-nums">
								{visible.length === actions.length
									? `${actions.length} ${actions.length === 1 ? "action" : "actions"}`
									: `${visible.length} of ${actions.length} actions`}
							</span>
							<CardFooterLink
								render={
									<Link
										search={{ invocation: undefined, status: undefined }}
										to="/actions/invocations"
									/>
								}
							>
								View invocations
							</CardFooterLink>
						</>
					}
				>
					{visible.length === 0 ? (
						<div className="flex flex-wrap items-center gap-3 p-5">
							<output className="text-muted-foreground text-sm">
								No action matches “{query.trim()}”.
							</output>
							<Button onClick={() => setQuery("")} size="sm" variant="outline">
								Clear search
							</Button>
						</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="md:w-[32%]">Name</TableHead>
									<TableHead className="w-24">Method</TableHead>
									<TableHead className="hidden md:table-cell">
										URL template
									</TableHead>
									<TableHead className="hidden w-52 lg:table-cell">
										Secrets used
									</TableHead>
									<TableHead className="hidden w-52 sm:table-cell">
										Approval
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{visible.map((action: Action) => (
									<TableRow
										className="cursor-pointer"
										key={action.id}
										onClick={() => select(action.id)}
									>
										<TableCell className="max-w-0 py-3">
											<div className="flex min-w-0 items-center gap-2">
												<Link
													aria-label={`View action ${action.name}`}
													className="truncate rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
													onClick={(event) => event.stopPropagation()}
													search={(previous) => ({
														...previous,
														action: action.id,
													})}
													to="/actions"
												>
													{action.name}
												</Link>
												{action.governed ? (
													<Badge size="sm" variant="soft">
														governed
													</Badge>
												) : null}
												{!action.enabled ? (
													<Badge size="sm" variant="outline">
														off
													</Badge>
												) : null}
											</div>
										</TableCell>
										<TableCell className="py-3">
											<Badge className="font-mono" variant="outline">
												{action.method}
											</Badge>
										</TableCell>
										<TableCell
											className="hidden max-w-0 truncate py-3 font-mono text-muted-foreground text-xs md:table-cell"
											title={action.urlTemplate}
										>
											{action.urlTemplate}
										</TableCell>
										<TableCell className="hidden py-3 lg:table-cell">
											<SecretBadges secrets={action.secrets} />
										</TableCell>
										<TableCell className="hidden py-3 sm:table-cell">
											<GateLabel gate={gateSummary(policies, action)} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</ListFrame>
			)}
		</Page>
	);
}

function ActionPage({
	action,
	isLoading,
	policies,
	workspaceId,
	onDeleted,
}: {
	action: Action | undefined;
	isLoading: boolean;
	policies: ApprovalPolicy[];
	workspaceId?: string;
	onDeleted: () => void;
}) {
	const source = useAdoptedToolSource(workspaceId, action?.id);
	const back = (
		<Link
			className="-ms-1 inline-flex items-center gap-0.5 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			search={(previous) => ({ ...previous, action: undefined })}
			to="/actions"
		>
			<ChevronLeft aria-hidden="true" className="size-3.5" />
			Actions
		</Link>
	);

	if (!action) {
		return (
			<Page>
				<PageHeader
					eyebrow={back}
					title={
						isLoading ? <Skeleton className="h-7 w-56" /> : "Action not found"
					}
				/>
				{isLoading ? (
					<Skeleton className="h-40 w-full rounded-lg" />
				) : (
					<p className="text-muted-foreground text-sm">
						It may have been deleted, or it belongs to another workspace.
					</p>
				)}
			</Page>
		);
	}

	const host = action.adapter ? null : actionHost(action.urlTemplate);
	const description = source
		? summaryOf(action.description, 200)
		: action.description;

	return (
		<Page>
			<PageHeader
				actions={
					<ActionControls
						action={action}
						onDeleted={onDeleted}
						workspaceId={workspaceId}
					/>
				}
				description={description || undefined}
				eyebrow={back}
				meta={
					<>
						{source ? (
							<Badge variant="outline">MCP tool</Badge>
						) : (
							<Badge className="font-mono" variant="outline">
								{action.method}
							</Badge>
						)}
						<Badge variant={action.enabled ? "success" : "outline"}>
							{action.enabled ? "On" : "Off"}
						</Badge>
						{action.governed ? <Badge variant="soft">governed</Badge> : null}
					</>
				}
				mono
				title={<span translate="no">{action.name}</span>}
			/>

			<DetailLayout
				rail={
					<PropertyList
						items={[
							{
								label: "Status",
								value: (
									<span className="flex flex-col gap-0.5">
										<span className="inline-flex items-center gap-2">
											<StatusDot
												className={
													action.enabled
														? "bg-success"
														: "bg-muted-foreground/60"
												}
											/>
											{action.enabled ? "On" : "Off"}
										</span>
										<span className="text-muted-foreground text-xs">
											{action.enabled
												? "Your agent can call this action."
												: "Your agent cannot call this action until you turn it on."}
										</span>
									</span>
								),
							},
							{
								label: "Approval",
								value: <GateLabel gate={gateSummary(policies, action)} />,
							},
							{
								label: source ? "Server" : action.adapter ? "Runs" : "Sends to",
								value: source ? (
									<Link
										className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
										params={{ name: source.server }}
										to="/mcp-servers/$name"
									>
										<span translate="no">{source.server}</span>
										<span className="block font-mono text-muted-foreground text-xs">
											{host ?? "-"}
										</span>
									</Link>
								) : action.adapter ? (
									<span className="font-mono text-xs">
										{action.adapter.type}
									</span>
								) : (
									<span className="font-mono text-xs" translate="no">
										{host ?? "—"}
									</span>
								),
							},
							{
								label: "Secrets used",
								value: <SecretBadges secrets={action.secrets} />,
							},
							{
								label: "Created",
								value: (
									<span className="tabular-nums">
										{dateTime.format(new Date(action.createdAt))}
									</span>
								),
							},
							{
								label: "Updated",
								value: (
									<span className="tabular-nums">
										{dateTime.format(new Date(action.updatedAt))}
									</span>
								),
							},
							{
								label: "ID",
								value: <IdValue label="action ID" value={action.id} />,
							},
						]}
					/>
				}
			>
				<ActionOverview
					action={action}
					source={source}
					workspaceId={workspaceId}
				/>
			</DetailLayout>
		</Page>
	);
}

function SecretBadges({ secrets }: { secrets: string[] }) {
	if (secrets.length === 0) {
		return <span className="text-muted-foreground">—</span>;
	}
	return (
		<div className="flex flex-wrap gap-1">
			{secrets.map((name) => (
				<Badge className="font-mono" key={name} size="sm" variant="soft">
					{name}
				</Badge>
			))}
		</div>
	);
}

function GateLabel({ gate }: { gate: GateSummary }) {
	return (
		<span className="inline-flex items-center gap-2">
			<StatusDot
				className={
					gate === "always"
						? "bg-warning"
						: gate === "sometimes"
							? "bg-warning/60"
							: "bg-success"
				}
			/>
			{GATE_LABEL[gate]}
		</span>
	);
}
