"use client";

import { isFeatureEnabled } from "@anlyon/feature-flags";
import {
	type ConnectWayKind,
	DEPTH_LABEL,
	WAY_LABEL,
} from "@anlyon/known-vendors/services";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	Bot,
	ChevronLeft,
	ChevronRight,
	FileCode2,
	Link2,
	ListChecks,
	RefreshCw,
	Server,
	ShieldCheck,
	Unplug,
} from "lucide-react";
import { type ReactElement, useId, useMemo, useRef, useState } from "react";
import { EmptyRow } from "@/components/actions/empty-row";
import { IntegrationLogo } from "@/components/actions/integration-logo";
import { ListSearch } from "@/components/actions/list-search";
import {
	OperationsFlow,
	type OperationsFlowStep,
} from "@/components/actions/operations-flow";
import { ConnectionBrokenHint } from "@/components/defaults/defaults-hint";
import { IntegrationRouteHint } from "@/components/integrations/integration-route-hint";
import {
	SIGN_IN_APP_LABEL,
	SignInAppBadge,
	SignInPanel,
} from "@/components/integrations/sign-in-app";
import { UsersPanel } from "@/components/integrations/users-panel";
import {
	DetailLayout,
	ListFrame,
	Page,
	PageHeader,
	PageSection,
	type PageTab,
	PageTabsView,
	PageToolbar,
	PropertyList,
} from "@/components/layout/page";
import { ServerTable } from "@/components/mcp-servers/server-list";
import { ActingFor } from "@/components/shared/acting-for";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Checkbox } from "@/components/ui/checkbox";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspace } from "@/contexts/workspace-context";
import { useDeleteSecret } from "@/hooks/api/use-actions";
import {
	useCheckConnection,
	useCompleteConnectSession,
	useConnections,
	useConnectionsOverview,
	useConnectWithApiKey,
	useCreateConnectSession,
	useReconnectConnection,
} from "@/hooks/api/use-connections";
import { useEnvironments } from "@/hooks/api/use-environments";
import {
	type McpUpstream,
	useMcpUpstreams,
} from "@/hooks/api/use-mcp-upstreams";
import { useCan } from "@/hooks/api/use-permissions";
import { ApiError } from "@/lib/api-client";
import {
	type ConsentClientFactory,
	ConsentError,
	defaultConsentClient,
	runConsent,
} from "@/lib/consent";
import { knownVendors } from "@/lib/extensions";
import { requireFeature } from "@/lib/feature-flags";
import {
	byIntegrationOrder,
	integrationPresentation,
	secretIntegrationId,
} from "@/lib/integration-catalog";
import { installedActionName } from "@/lib/operations";
import { cataloguePack, type OperationsApi } from "@/lib/packs";
import {
	matchesServiceRow,
	type ServiceRow,
	serviceRows,
	wayKinds,
} from "@/lib/services";
import type {
	ConnectionField,
	ConnectionIntegration,
	ConnectSession,
	Environment,
	IntegrationOverview,
	Secret,
	SecretHealthReason,
} from "@/lib/types";
import { connectionKeyAuth } from "@/lib/types";
import { cn } from "@/lib/utils";

type IntegrationTab = "account" | "users" | "sign-in" | "actions";
const TABS: readonly IntegrationTab[] = [
	"account",
	"users",
	"sign-in",
	"actions",
];

type ConnectionsSearch = {
	integration?: string;
	tab?: IntegrationTab;
};

export const Route = createFileRoute("/_protected/integrations/")({
	beforeLoad: () => requireFeature("connected-accounts"),
	validateSearch: (search: Record<string, unknown>): ConnectionsSearch => ({
		...(typeof search.integration === "string" && search.integration
			? { integration: search.integration }
			: {}),
		...(TABS.includes(search.tab as IntegrationTab) && search.tab !== "account"
			? { tab: search.tab as IntegrationTab }
			: {}),
	}),
	component: ConnectionsRoute,
});

function ConnectionsRoute() {
	const { integration, tab } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<ConnectionsPage
			onSelect={(id, nextTab) =>
				navigate({
					search: () => ({
						...(id ? { integration: id } : {}),
						...(id && nextTab && nextTab !== "account" ? { tab: nextTab } : {}),
					}),
				})
			}
			selectedId={integration ?? null}
			tab={tab ?? "account"}
		/>
	);
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

const SECRET_NAME = /^[A-Z0-9_]+$/;

function healthStatus(secret: Secret): "active" | "needs_reauth" {
	const status = secret.health?.status ?? secret.connection?.status ?? "active";
	return status === "needs_reauth" ? "needs_reauth" : "active";
}

function reasonText(reason: SecretHealthReason | null | undefined): string {
	switch (reason) {
		case "key_rejected":
			return "The provider refused the stored key.";
		case "access_revoked":
			return "The provider no longer honours its access.";
		case "refresh_failed":
			return "Its token could not be renewed.";
		default:
			return "It no longer works.";
	}
}

function useConsoleEnvironment(workspaceId?: string): Environment | undefined {
	const environments = useEnvironments(workspaceId).data ?? [];
	return environments.find((env) => env.isDefault);
}

interface RegistryEntry {
	id: string;
	name: string;
	integration: IntegrationOverview | null;
	accounts: Secret[];
}

function buildRegistry(
	integrations: IntegrationOverview[],
	connections: Secret[],
): RegistryEntry[] {
	const entries = new Map<string, RegistryEntry>();
	for (const integration of integrations) {
		entries.set(integration.id, {
			id: integration.id,
			name: integration.name,
			integration,
			accounts: [],
		});
	}
	for (const secret of connections) {
		const id = secretIntegrationId(secret) ?? "other";
		const entry = entries.get(id) ?? {
			id,
			name: id,
			integration: null,
			accounts: [],
		};
		entry.accounts.push(secret);
		entries.set(id, entry);
	}
	return [...entries.values()].sort(byIntegrationOrder);
}

const inUse = (entry: RegistryEntry) =>
	entry.accounts.length > 0 || (entry.integration?.endUsers.connected ?? 0) > 0;

type ListFilter = "all" | "in-use";

export function ConnectionsPage({
	consentClient = defaultConsentClient,
	operationsApi,
	selectedId: controlledId,
	tab: controlledTab,
	onSelect,
}: {
	consentClient?: ConsentClientFactory;
	operationsApi?: OperationsApi;
	selectedId?: string | null;
	tab?: IntegrationTab;
	onSelect?: (id: string | null, tab?: IntegrationTab) => void;
}) {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const environment = useConsoleEnvironment(workspaceId);
	const connectionsQuery = useConnections(workspaceId);
	const overviewQuery = useConnectionsOverview(workspaceId);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<ListFilter>("all");
	const [local, setLocal] = useState<{
		id: string | null;
		tab: IntegrationTab;
	}>({ id: null, tab: "account" });
	const selectedId = onSelect ? (controlledId ?? null) : local.id;
	const tab = onSelect ? (controlledTab ?? "account") : local.tab;
	const select =
		onSelect ??
		((id: string | null, next?: IntegrationTab) =>
			setLocal({ id, tab: next ?? "account" }));

	const registry = useMemo(
		() => buildRegistry(overviewQuery.data ?? [], connectionsQuery.data ?? []),
		[overviewQuery.data, connectionsQuery.data],
	);
	const isLoading = connectionsQuery.isLoading || overviewQuery.isLoading;
	const canManage = useCan(workspaceId)("connections.manage", environment?.id);
	const mcpOn = isFeatureEnabled("mcp-upstreams");
	const serversQuery = useMcpUpstreams(mcpOn ? workspaceId : undefined);
	const servers = serversQuery.data ?? [];
	const rows = useMemo(
		() =>
			serviceRows(registry, {
				vendors: knownVendors(),
				mcp: mcpOn,
				offers: offersWay,
			}),
		[registry, mcpOn],
	);
	const addedServers = useMemo(() => serversByVendor(servers), [servers]);

	if (selectedId !== null) {
		const row = rows.find((candidate) =>
			candidate.entries.some((entry) => entry.id === selectedId),
		);
		return (
			<IntegrationPage
				consentClient={consentClient}
				entry={registry.find((entry) => entry.id === selectedId) ?? null}
				environment={environment}
				isLoading={isLoading}
				otherWays={row ? otherWaysOf(row, selectedId, addedServers) : undefined}
				onBack={onSelect ? undefined : () => select(null)}
				onTab={(next) => select(selectedId, next)}
				operationsApi={operationsApi}
				tab={tab}
				workspaceId={workspaceId}
				workspaceName={currentWorkspace?.name}
			/>
		);
	}

	const rowInUse = (row: ServiceRow<RegistryEntry>) =>
		row.entries.some(inUse) ||
		(row.vendor !== null && addedServers.has(row.vendor));
	const searched = rows.filter((row) => matchesServiceRow(row, query));
	const visible = filter === "in-use" ? searched.filter(rowInUse) : searched;
	const usedCount = rows.filter(rowInUse).length;

	return (
		<Page>
			<PageHeader
				actions={
					<>
						<Button
							render={<Link to="/integrations/settings" />}
							size="sm"
							variant="outline"
						>
							Connect settings
						</Button>
						{canManage &&
						registry.some((entry) => entry.integration?.connectable) ? (
							<ConnectAccountDialog
								consentClient={consentClient}
								environment={environment}
								operationsApi={operationsApi}
								trigger={
									<Button disabled={!workspaceId} size="sm">
										<Link2 aria-hidden="true" className="size-4" />
										Connect an account
									</Button>
								}
								workspaceId={workspaceId}
								workspaceName={currentWorkspace?.name}
							/>
						) : null}
					</>
				}
				description="Every service your agent can act in, and every way to connect to it: signing in, an API key, or the vendor's own MCP server. Connect your own account, let each of your users connect theirs, or both. Every call runs under the same approvals, limits and receipts, and tokens and keys are never shown to you or to your agent."
				meta={
					environment ? (
						<Badge variant="outline">
							{environment.name}
							{environment.isProtected ? " · protected" : ""}
						</Badge>
					) : null
				}
				title="Integrations"
			/>

			<ConnectionBrokenHint
				show={registry.some((entry) =>
					entry.accounts.some(
						(secret) => healthStatus(secret) === "needs_reauth",
					),
				)}
				workspaceId={workspaceId}
			/>

			{rows.length > 0 || isLoading ? (
				<PageToolbar>
					<ListSearch
						label="Search integrations"
						onChange={setQuery}
						placeholder="Search by name or category…"
						value={query}
					/>
					<SegmentedControl
						label="Show"
						onChange={setFilter}
						options={[
							{ value: "all", label: "All" },
							{
								value: "in-use",
								label: `In use${usedCount ? ` · ${usedCount}` : ""}`,
							},
						]}
						value={filter}
					/>
				</PageToolbar>
			) : null}

			{isLoading ? (
				<ListFrame aria-busy="true" className="space-y-2" padded>
					{[0, 1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-10 w-full rounded-lg" />
					))}
				</ListFrame>
			) : overviewQuery.isError || connectionsQuery.isError ? (
				<Alert variant="error">
					<AlertTitle>Integrations could not be loaded</AlertTitle>
					<AlertDescription>
						{(() => {
							const error = overviewQuery.error ?? connectionsQuery.error;
							return error instanceof ApiError && error.code
								? `${error.message} (${error.code})`
								: "Try again shortly.";
						})()}
					</AlertDescription>
				</Alert>
			) : rows.length === 0 ? (
				<ListFrame padded>
					<EmptyRow
						action={
							<Button
								render={<Link to="/actions/secrets" />}
								size="sm"
								variant="outline"
							>
								Go to Secrets
							</Button>
						}
						title="No integrations yet"
					>
						They appear here when this workspace can connect them. Until then,
						store an app's API key as a secret and use it in an action.
					</EmptyRow>
				</ListFrame>
			) : visible.length === 0 ? (
				<div className="space-y-4">
					<div className="flex flex-wrap items-center gap-3">
						<output className="text-muted-foreground text-sm">
							{query.trim()
								? `No integration matches “${query.trim()}”.`
								: "Nothing is connected yet."}
						</output>
						<Button
							onClick={() => {
								setQuery("");
								setFilter("all");
							}}
							size="sm"
							variant="outline"
						>
							Show all
						</Button>
					</div>
					{searched.length === 0 && query.trim() ? (
						<IntegrationRouteHint name={query} workspaceId={workspaceId} />
					) : null}
				</div>
			) : (
				<ServicesTable
					addedServers={addedServers}
					onSelect={(id) => select(id)}
					rows={visible}
				/>
			)}

			{!isLoading ? (
				<ConnectAnything canManage={canManage} mcp={mcpOn} />
			) : null}

			{mcpOn && serversQuery.isError ? (
				<Alert variant="error">
					<AlertTitle>Your MCP servers could not be loaded</AlertTitle>
					<AlertDescription>
						{serversQuery.error instanceof ApiError && serversQuery.error.code
							? `${serversQuery.error.message} (${serversQuery.error.code})`
							: "Try again shortly."}
					</AlertDescription>
				</Alert>
			) : null}

			{mcpOn && servers.length > 0 ? (
				<PageSection
					description="Remote MCP servers added to this environment, each reaching only the tools you picked."
					title="Your MCP servers"
				>
					<ServerTable servers={servers} />
				</PageSection>
			) : null}

			{rows.length > 0 ? (
				<p className="text-muted-foreground text-sm">
					Need one that is not here? Search for it to see the best way there, or{" "}
					<a
						className="text-foreground underline underline-offset-2"
						href="mailto:support@anlyon.com?subject=Integration%20request"
					>
						ask for it
					</a>
					.
				</p>
			) : null}
		</Page>
	);
}

function AccountCount({
	connected,
	attention,
	noun,
}: {
	connected: number;
	attention: number;
	noun: [string, string];
}) {
	if (connected === 0) return <span className="text-muted-foreground">—</span>;
	return (
		<span className="inline-flex items-center gap-2 tabular-nums">
			<span
				aria-hidden="true"
				className={cn(
					"size-1.5 shrink-0 rounded-full",
					attention > 0 ? "bg-warning" : "bg-success",
				)}
			/>
			{connected} {connected === 1 ? noun[0] : noun[1]}
			{attention > 0 ? (
				<span className="text-warning-foreground text-xs">
					{attention} to reconnect
				</span>
			) : null}
		</span>
	);
}

function offersWay(entry: RegistryEntry, kind: "sign_in" | "api_key"): boolean {
	const integration = entry.integration;
	if (!integration) return true;
	return kind === "sign_in"
		? integration.auth?.kind !== "api_key"
		: connectionKeyAuth(integration) !== null;
}

function serversByVendor(
	servers: readonly McpUpstream[],
): Map<string, McpUpstream> {
	const byRegistry = new Map<string, McpUpstream>();
	const byAddress = new Map<string, McpUpstream>();
	for (const server of servers) {
		if (server.archivedAt) continue;
		if (server.registryName) byRegistry.set(server.registryName, server);
		const address = serverAddress(server.url);
		if (address) byAddress.set(address, server);
	}
	const added = new Map<string, McpUpstream>();
	for (const vendor of knownVendors()) {
		const address = serverAddress(vendor.server.url);
		const server =
			byRegistry.get(vendor.server.registryName) ??
			(address ? byAddress.get(address) : undefined);
		if (server) added.set(vendor.slug, server);
	}
	return added;
}

export function serverAddress(url: string): string | null {
	try {
		const parsed = new URL(url);
		return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
	} catch {
		return null;
	}
}

export interface OtherWay {
	label: string;
	link:
		| { kind: "integration"; id: string }
		| { kind: "server"; name: string }
		| { kind: "add-server"; vendor: string };
}

function otherWaysOf(
	row: ServiceRow<RegistryEntry>,
	openId: string,
	added: ReadonlyMap<string, McpUpstream>,
): OtherWay[] {
	const ways: OtherWay[] = row.entries
		.filter((entry) => entry.id !== openId)
		.map((entry) => ({
			label: entry.name,
			link: { kind: "integration", id: entry.id },
		}));
	if (row.vendor) {
		const server = added.get(row.vendor);
		ways.push({
			label: `${row.name} MCP server`,
			link: server
				? { kind: "server", name: server.name }
				: { kind: "add-server", vendor: row.vendor },
		});
	}
	return ways;
}

function OtherWayLink({ way }: { way: OtherWay }) {
	const className =
		"text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring";
	if (way.link.kind === "integration")
		return (
			<Link
				className={className}
				search={{ integration: way.link.id }}
				to="/integrations"
			>
				{way.label}
			</Link>
		);
	if (way.link.kind === "server")
		return (
			<Link
				className={className}
				params={{ name: way.link.name }}
				to="/mcp-servers/$name"
			>
				{way.label}
			</Link>
		);
	return (
		<Link
			className={className}
			search={{ server: way.link.vendor }}
			to="/mcp-servers/new"
		>
			{way.label}
		</Link>
	);
}

function ServicesTable({
	rows,
	onSelect,
	addedServers,
}: {
	rows: ServiceRow<RegistryEntry>[];
	onSelect: (id: string) => void;
	addedServers: ReadonlyMap<string, McpUpstream>;
}) {
	const navigate = useNavigate();
	const open = (row: ServiceRow<RegistryEntry>) => {
		const first = row.entries[0];
		if (first) {
			onSelect(first.id);
			return;
		}
		if (!row.vendor) return;
		const server = addedServers.get(row.vendor);
		if (server)
			navigate({ to: "/mcp-servers/$name", params: { name: server.name } });
		else navigate({ to: "/mcp-servers/new", search: { server: row.vendor } });
	};
	return (
		<ListFrame
			footer={
				<span className="tabular-nums">
					{rows.length} {rows.length === 1 ? "service" : "services"}
				</span>
			}
		>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Service</TableHead>
						<TableHead className="hidden w-48 lg:table-cell">
							Connects with
						</TableHead>
						<TableHead className="hidden w-40 md:table-cell">
							Your account
						</TableHead>
						<TableHead className="w-36">Your users</TableHead>
						<TableHead className="w-10">
							<span className="sr-only">Open</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => {
						const integrations = row.entries.flatMap((entry) =>
							entry.integration ? [entry.integration] : [],
						);
						const accounts = row.entries.flatMap((entry) => entry.accounts);
						const broken = accounts.filter(
							(secret) => healthStatus(secret) === "needs_reauth",
						).length;
						const signIn =
							integrations.find((integration) => integration.signIn)?.signIn ??
							null;
						const server = row.vendor
							? addedServers.get(row.vendor)
							: undefined;
						const kinds: ConnectWayKind[] = row.ways.length
							? wayKinds(row.ways)
							: integrations[0]
								? [
										integrations[0].auth?.kind === "api_key"
											? "api_key"
											: "sign_in",
									]
								: [];
						const logoId = row.entries[0]?.id ?? row.key;
						const category =
							row.category ?? integrationPresentation(logoId).category;
						return (
							<TableRow
								className="group/row relative cursor-pointer"
								key={row.key}
								onClick={() => open(row)}
							>
								<TableCell className="py-2.5">
									<div className="flex min-w-0 items-center gap-3">
										<IntegrationLogo
											className="size-7 rounded-md"
											id={logoId}
											name={row.name}
										/>
										<div className="min-w-0">
											<button
												className="block max-w-full truncate rounded-sm text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
												onClick={(event) => {
													event.stopPropagation();
													open(row);
												}}
												translate="no"
												type="button"
											>
												{row.name}
											</button>
											<span className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
												<span>{category}</span>
												<Badge
													variant={
														row.depth === "full_toolset"
															? "success"
															: "secondary"
													}
												>
													{DEPTH_LABEL[row.depth]}
												</Badge>
											</span>
										</div>
									</div>
								</TableCell>
								<TableCell className="hidden py-2.5 lg:table-cell">
									{kinds.length === 0 ? (
										<span className="text-muted-foreground">-</span>
									) : (
										<span className="flex flex-col items-start gap-1">
											<span>
												{kinds.map((kind) => WAY_LABEL[kind]).join(" · ")}
											</span>
											{signIn?.app === "own_required" ? (
												<SignInAppBadge app={signIn.app} />
											) : signIn ? (
												<span className="text-muted-foreground text-xs">
													{SIGN_IN_APP_LABEL[signIn.app]}
												</span>
											) : null}
										</span>
									)}
								</TableCell>
								<TableCell className="hidden py-2.5 md:table-cell">
									{server && row.entries.length === 0 ? (
										<span>Server added</span>
									) : (
										<AccountCount
											attention={broken}
											connected={accounts.length}
											noun={["account", "accounts"]}
										/>
									)}
								</TableCell>
								<TableCell className="py-2.5">
									<AccountCount
										attention={integrations.reduce(
											(sum, integration) =>
												sum + integration.endUsers.needsReconnect,
											0,
										)}
										connected={integrations.reduce(
											(sum, integration) =>
												sum + integration.endUsers.connected,
											0,
										)}
										noun={["user", "users"]}
									/>
								</TableCell>
								<TableCell className="py-2.5 text-right">
									<ChevronRight
										aria-hidden="true"
										className="ms-auto size-4 text-muted-foreground transition-transform duration-150 ease-out group-hover/row:translate-x-0.5"
									/>
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</ListFrame>
	);
}

function ConnectAnything({
	mcp,
	canManage,
}: {
	mcp: boolean;
	canManage: boolean;
}) {
	const actions = isFeatureEnabled("actions");
	if (!mcp && !actions) return null;
	return (
		<PageSection
			description="Calls through either run under the same approvals, limits and receipts."
			title="Not in the list"
		>
			<ListFrame>
				<Table>
					<TableBody>
						{mcp ? (
							<TableRow>
								<TableCell className="py-2.5">
									<div className="flex items-center gap-3">
										<Server
											aria-hidden="true"
											className="size-5 shrink-0 text-muted-foreground"
										/>
										<div className="min-w-0">
											<span className="block font-medium">
												Any remote MCP server
											</span>
											<span className="block text-muted-foreground text-xs">
												Add it by its address, and pick which of its tools your
												agent may call.
											</span>
										</div>
									</div>
								</TableCell>
								<TableCell className="w-36 py-2.5 text-right">
									{canManage ? (
										<Button
											render={<Link to="/mcp-servers/new" />}
											size="sm"
											variant="outline"
										>
											Add server
										</Button>
									) : null}
								</TableCell>
							</TableRow>
						) : null}
						{actions ? (
							<TableRow>
								<TableCell className="py-2.5">
									<div className="flex items-center gap-3">
										<FileCode2
											aria-hidden="true"
											className="size-5 shrink-0 text-muted-foreground"
										/>
										<div className="min-w-0">
											<span className="block font-medium">Any HTTP API</span>
											<span className="block text-muted-foreground text-xs">
												Import its OpenAPI spec as actions, with its key stored
												as a secret.
											</span>
										</div>
									</div>
								</TableCell>
								<TableCell className="w-36 py-2.5 text-right">
									{canManage ? (
										<Button
											render={
												<Link
													search={{ action: undefined, import: "openapi" }}
													to="/actions"
												/>
											}
											size="sm"
											variant="outline"
										>
											Import OpenAPI
										</Button>
									) : null}
								</TableCell>
							</TableRow>
						) : null}
					</TableBody>
				</Table>
			</ListFrame>
		</PageSection>
	);
}

function firstSentence(text: string): string {
	const end = text.indexOf(". ");
	return end === -1 ? text : text.slice(0, end + 1);
}

function IntegrationPage({
	entry,
	isLoading,
	onBack,
	tab,
	onTab,
	workspaceId,
	workspaceName,
	environment,
	consentClient,
	operationsApi,
	otherWays,
}: {
	entry: RegistryEntry | null;
	isLoading: boolean;
	onBack?: () => void;
	tab: IntegrationTab;
	onTab: (tab: IntegrationTab) => void;
	workspaceId?: string;
	workspaceName?: string;
	environment?: Environment;
	consentClient: ConsentClientFactory;
	operationsApi?: OperationsApi;
	otherWays?: OtherWay[];
}) {
	const integration = entry?.integration ?? null;
	const can = useCan(workspaceId);
	const canManage = can("connections.manage", environment?.id);
	const canManageSignIn = can("oauth-apps.manage", environment?.id);
	const back = (
		<Link
			className="-ms-1 inline-flex items-center gap-0.5 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			onClick={onBack}
			search={{}}
			to="/integrations"
		>
			<ChevronLeft aria-hidden="true" className="size-3.5" />
			Integrations
		</Link>
	);

	if (!entry) {
		return (
			<Page>
				<PageHeader
					eyebrow={back}
					title={
						isLoading ? (
							<Skeleton className="h-7 w-48" />
						) : (
							"Integration not found"
						)
					}
				/>
				{isLoading ? (
					<Skeleton className="h-40 w-full rounded-lg" />
				) : (
					<p className="text-muted-foreground text-sm">
						This workspace cannot connect it, and no account is connected to it.
					</p>
				)}
			</Page>
		);
	}

	const presentation = integrationPresentation(entry.id);
	const pack = integration?.operationsPack
		? cataloguePack(integration.operationsPack)
		: undefined;
	const usesKey = integration?.auth?.kind === "api_key";
	const signIn = integration?.signIn ?? null;
	const tabs: Array<PageTab & { tab: IntegrationTab }> = [
		{
			tab: "account",
			label: "Your account",
			to: "/integrations",
			search: { integration: entry.id },
			count: entry.accounts.length || undefined,
		},
		...(integration
			? [
					{
						tab: "users" as const,
						label: "Your users",
						to: "/integrations",
						search: { integration: entry.id, tab: "users" },
						count: integration.endUsers.connected || undefined,
					},
				]
			: []),
		...(signIn
			? [
					{
						tab: "sign-in" as const,
						label: "Sign-in",
						to: "/integrations",
						search: { integration: entry.id, tab: "sign-in" },
					},
				]
			: []),
		{
			tab: "actions",
			label: "Actions",
			to: "/integrations",
			search: { integration: entry.id, tab: "actions" },
			count: pack?.actions.length,
		},
	];
	const active = tabs.some((item) => item.tab === tab) ? tab : "account";
	const canConnect = Boolean(integration?.connectable);

	return (
		<Page>
			<PageHeader
				actions={
					integration && canManage && canConnect && active === "account" ? (
						<ConnectAccountDialog
							workspaceId={workspaceId}
							workspaceName={workspaceName}
							environment={environment}
							consentClient={consentClient}
							operationsApi={operationsApi}
							integrationId={integration.id}
							trigger={
								<Button disabled={!workspaceId} size="sm">
									<Link2 aria-hidden="true" className="size-4" />
									{entry.accounts.length > 0
										? "Connect another account"
										: `Connect ${integration.name}`}
								</Button>
							}
						/>
					) : undefined
				}
				description={presentation.summary}
				eyebrow={back}
				meta={
					<>
						<Badge variant="outline">{presentation.category}</Badge>
						{signIn ? <SignInAppBadge app={signIn.app} /> : null}
					</>
				}
				title={
					<span className="inline-flex min-w-0 items-center gap-3 align-middle">
						<IntegrationLogo
							className="size-8 rounded-md"
							id={entry.id}
							name={entry.name}
						/>
						<span className="truncate" translate="no">
							{entry.name}
						</span>
					</span>
				}
			>
				{integration ? null : (
					<p className="text-muted-foreground text-sm">
						New accounts cannot be connected to this integration from this
						workspace.
					</p>
				)}
				{otherWays && otherWays.length > 0 ? (
					<p className="text-muted-foreground text-sm">
						Also connects through{" "}
						{otherWays.map((way, index) => (
							<span key={way.label}>
								{index > 0
									? index === otherWays.length - 1
										? " or "
										: ", "
									: null}
								<OtherWayLink way={way} />
							</span>
						))}
						.
					</p>
				) : null}
			</PageHeader>

			<PageTabsView
				isActive={(item) => (item as (typeof tabs)[number]).tab === active}
				items={tabs}
				label={entry.name}
			/>

			<DetailLayout
				rail={
					<PropertyList
						items={[
							{
								label: "Connects with",
								value: integration
									? usesKey
										? "An API key"
										: `Signing in at ${integration.name}`
									: "—",
							},
							...(signIn
								? [
										{
											label: "Sign-in app",
											value: SIGN_IN_APP_LABEL[signIn.app],
										},
									]
								: []),
							...(integration
								? [
										{
											label: usesKey
												? "The key may be sent to"
												: "The token may be sent to",
											value: integration.hostsFromAccount ? (
												"The account's own API host"
											) : (
												<ul className="flex flex-col gap-0.5 font-mono text-xs">
													{(integration.hosts ?? []).map((host) => (
														<li key={host} translate="no">
															{host}
														</li>
													))}
												</ul>
											),
										},
									]
								: []),
							{
								label: "Environment",
								value: environment
									? `${environment.name}${environment.isProtected ? " (protected)" : ""}`
									: "—",
							},
						]}
					/>
				}
			>
				{active === "users" && integration ? (
					<UsersPanel
						canManage={canManage}
						environment={environment}
						integration={integration}
						onOpenSignIn={signIn ? () => onTab("sign-in") : undefined}
						workspaceId={workspaceId}
					/>
				) : active === "sign-in" && integration ? (
					<SignInPanel
						canManage={canManageSignIn}
						environmentId={environment?.id}
						integration={integration}
						workspaceId={workspaceId}
					/>
				) : active === "actions" ? (
					<PageSection
						description={
							pack
								? "Each one is off until you turn it on for a connected account."
								: undefined
						}
						title="What your agent can do"
					>
						{pack ? (
							<ListFrame
								footer={
									<span className="tabular-nums">
										{pack.actions.length}{" "}
										{pack.actions.length === 1 ? "operation" : "operations"}
									</span>
								}
							>
								<ul className="divide-y">
									{pack.actions.map((action) => (
										<li
											className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:gap-4"
											key={action.name}
										>
											<span
												className="shrink-0 font-mono text-[13px] sm:w-64 sm:truncate"
												translate="no"
											>
												{installedActionName(pack, action.name)}
											</span>
											<span className="min-w-0 text-muted-foreground text-sm">
												{firstSentence(action.description ?? "")}
											</span>
										</li>
									))}
								</ul>
							</ListFrame>
						) : (
							<p className="text-muted-foreground text-sm">
								No ready-made operations yet. A connected account is a secret
								you can reference from your own actions.
							</p>
						)}
					</PageSection>
				) : (
					<>
						<PageSection
							description="The workspace's own account, for your agent's work in your company's app. Your users' accounts are under Your users."
							title="Your account"
						>
							{entry.accounts.length === 0 ? (
								<p className="text-muted-foreground text-sm">
									<span className="text-foreground">
										No account is connected yet.
									</span>{" "}
									{integration
										? !canConnect && signIn?.app === "own_required"
											? `Add your own ${integration.name} app under Sign-in first.`
											: usesKey
												? "Connecting asks for a key from the provider; Anlyon checks it before saving it."
												: `Connecting opens ${integration.name}'s sign-in, where you approve the access.`
										: null}
								</p>
							) : (
								<ul className="divide-y overflow-hidden rounded-lg border bg-card">
									{entry.accounts.map((secret) => (
										<AccountRow
											canManage={canManage}
											consentClient={consentClient}
											environment={environment}
											integration={integration}
											key={secret.id}
											operationsApi={operationsApi}
											secret={secret}
											workspaceId={workspaceId}
											workspaceName={workspaceName}
										/>
									))}
								</ul>
							)}
						</PageSection>
						{integration?.auth?.kind === "api_key" ? (
							<PageSection title="How you connect">
								<KeyInstructions auth={integration.auth} />
							</PageSection>
						) : integration?.auth?.apiKey ? (
							<PageSection
								description="Signing in is the default. A token works too, for teams that prefer one."
								title="Connect with a token instead"
							>
								<KeyInstructions auth={integration.auth.apiKey} />
							</PageSection>
						) : null}
					</>
				)}
			</DetailLayout>
		</Page>
	);
}

function AccountRow({
	secret,
	integration,
	canManage,
	workspaceId,
	workspaceName,
	environment,
	consentClient,
	operationsApi,
}: {
	secret: Secret;
	integration: ConnectionIntegration | null;
	canManage: boolean;
	workspaceId?: string;
	workspaceName?: string;
	environment?: Environment;
	consentClient: ConsentClientFactory;
	operationsApi?: OperationsApi;
}) {
	const broken = healthStatus(secret) === "needs_reauth";
	return (
		<li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-4 py-3.5">
			<div className="min-w-0 flex-1 basis-64 space-y-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium font-mono text-sm" translate="no">
						{secret.name}
					</span>
					{broken ? (
						<Badge variant="warning">Needs reconnecting</Badge>
					) : (
						<Badge variant="success">Active</Badge>
					)}
				</div>
				{secret.description ? (
					<p className="text-muted-foreground text-sm">{secret.description}</p>
				) : null}
				<p className="text-muted-foreground text-xs tabular-nums">
					<ActingFor endUserId={null} />
					{" · "}
					Connected {dateFormat.format(new Date(secret.createdAt))}
					{" · "}
					{secret.lastUsedAt
						? `last used ${dateFormat.format(new Date(secret.lastUsedAt))}`
						: "never used"}
					{" · "}
					{secret.health?.checkedAt
						? `checked ${dateFormat.format(new Date(secret.health.checkedAt))}`
						: "not checked yet"}
				</p>
				{broken ? (
					<p className="text-warning-foreground text-xs">
						{reasonText(secret.health?.reason)} Actions that use it fail before
						anything is sent. Reconnect it to keep the same name.
					</p>
				) : null}
			</div>
			{canManage ? (
				<div className="flex flex-wrap items-center gap-1">
					{workspaceId && integration ? (
						<>
							<OperationsDialog
								step="operations"
								workspaceId={workspaceId}
								workspaceName={workspaceName}
								environment={environment}
								integration={integration}
								secretName={secret.name}
								api={operationsApi}
							/>
							<OperationsDialog
								step="agent"
								workspaceId={workspaceId}
								workspaceName={workspaceName}
								environment={environment}
								integration={integration}
								secretName={secret.name}
								api={operationsApi}
							/>
							<span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
							<CheckButton secret={secret} workspaceId={workspaceId} />
							<ConnectAccountDialog
								workspaceId={workspaceId}
								workspaceName={workspaceName}
								environment={environment}
								consentClient={consentClient}
								operationsApi={operationsApi}
								integrationId={integration.id}
								reconnect={secret}
								trigger={
									<Button
										aria-label={`Reconnect ${secret.name}`}
										size={broken ? "sm" : "icon-sm"}
										variant={broken ? "default" : "ghost"}
										title="Reconnect"
									>
										<RefreshCw className="size-4" />
										{broken ? "Reconnect" : null}
									</Button>
								}
							/>
						</>
					) : null}
					<DisconnectButton
						secret={secret}
						workspaceId={workspaceId}
						environment={environment}
					/>
				</div>
			) : null}
		</li>
	);
}

function OperationsDialog({
	step,
	workspaceId,
	workspaceName,
	environment,
	integration,
	secretName,
	api,
}: {
	step: OperationsFlowStep;
	workspaceId: string;
	workspaceName?: string;
	environment?: Environment;
	integration: ConnectionIntegration;
	secretName: string;
	api?: OperationsApi;
}) {
	const label = step === "operations" ? "Operations" : "Add to your agent";
	return (
		<Dialog>
			<DialogTrigger
				render={
					<Button
						aria-label={`${label} for ${secretName}`}
						size="sm"
						variant="outline"
					>
						{step === "operations" ? (
							<ListChecks aria-hidden="true" className="size-4" />
						) : (
							<Bot aria-hidden="true" className="size-4" />
						)}
						{label}
					</Button>
				}
			/>
			<DialogPopup className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{integration.name} as {secretName}
					</DialogTitle>
					<DialogDescription>
						Choose what your agent may do with this account, then add it to your
						agent.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="py-2">
					<OperationsFlow
						workspaceId={workspaceId}
						workspaceName={workspaceName ?? "this workspace"}
						environmentName={environment?.name ?? "the default environment"}
						environmentId={environment?.id}
						integration={integration}
						secretName={secretName}
						initialStep={step}
						api={api}
					/>
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="outline">Close</Button>} />
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function CheckButton({
	secret,
	workspaceId,
}: {
	secret: Secret;
	workspaceId: string;
}) {
	const check = useCheckConnection();
	const [note, setNote] = useState<string | null>(null);
	return (
		<>
			<Button
				aria-label={`Check ${secret.name}`}
				disabled={check.isPending}
				size="icon-sm"
				variant="ghost"
				title="Check that it still works"
				onClick={() => {
					setNote(null);
					check.mutate(
						{ workspaceId, secretName: secret.name },
						{
							onSuccess: (checked) =>
								setNote(
									healthStatus(checked) === "needs_reauth"
										? `${checked.name} no longer works. ${reasonText(checked.health?.reason)}`
										: `${checked.name} works. The provider accepted it just now.`,
								),
							onError: (error) =>
								setNote(
									error instanceof ApiError
										? `${error.message}${error.code ? ` (${error.code})` : ""}`
										: "The account could not be checked just now. Its status is unchanged.",
								),
						},
					);
				}}
			>
				{check.isPending ? (
					<Spinner className="size-4" />
				) : (
					<ShieldCheck className="size-4" />
				)}
			</Button>
			{note ? <output className="sr-only">{note}</output> : null}
		</>
	);
}

function DisconnectButton({
	secret,
	workspaceId,
	environment,
}: {
	secret: Secret;
	workspaceId?: string;
	environment?: Environment;
}) {
	const confirmId = useId();
	const [confirmed, setConfirmed] = useState(false);
	const deleteSecret = useDeleteSecret();
	const needsConfirm = Boolean(environment?.isProtected);

	return (
		<AlertDialog onOpenChange={() => setConfirmed(false)}>
			<AlertDialogTrigger
				render={
					<Button
						aria-label={`Disconnect ${secret.name}`}
						disabled={!workspaceId || deleteSecret.isPending}
						size="icon-sm"
						variant="ghost"
					>
						<Unplug className="size-4" />
					</Button>
				}
			/>
			<AlertDialogPopup>
				<AlertDialogHeader>
					<AlertDialogTitle>Disconnect {secret.name}?</AlertDialogTitle>
					<AlertDialogDescription>
						Anlyon revokes its access to this account, then deletes the secret.
						Any action referencing {secret.name} fails until you connect an
						account again. If revoking fails, the secret is kept and you are
						told.
					</AlertDialogDescription>
				</AlertDialogHeader>
				{needsConfirm ? (
					<div className="flex items-start gap-2 px-6 pb-2">
						<Checkbox
							id={confirmId}
							checked={confirmed}
							onCheckedChange={(checked) => setConfirmed(checked === true)}
						/>
						<Label htmlFor={confirmId}>
							Disconnect it in protected “{environment?.name}”
						</Label>
					</div>
				) : null}
				<AlertDialogFooter>
					<AlertDialogClose
						render={<Button variant="outline">Cancel</Button>}
					/>
					<AlertDialogClose
						render={
							<Button
								disabled={needsConfirm && !confirmed}
								onClick={() => {
									if (!workspaceId) return;
									deleteSecret.mutate({
										name: secret.name,
										workspaceId,
										confirmProtected: needsConfirm ? true : undefined,
									});
								}}
								variant="destructive"
							>
								Disconnect
							</Button>
						}
					/>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}

type DialogState =
	| { step: "form" }
	| { step: "connecting" }
	| { step: "popup_blocked"; session: ConnectSession }
	| { step: "expired" }
	| { step: "error"; code: string | null; message: string }
	| { step: "done"; secret: Secret };

function defaultSecretName(integrationId: string): string {
	return integrationId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function ConnectAccountDialog({
	workspaceId,
	workspaceName,
	environment,
	consentClient = defaultConsentClient,
	operationsApi,
	integrationId: presetIntegrationId,
	reconnect: reconnecting,
	trigger,
}: {
	workspaceId?: string;
	workspaceName?: string;
	environment?: Environment;
	consentClient?: ConsentClientFactory;
	operationsApi?: OperationsApi;
	integrationId?: string;
	reconnect?: Secret;
	trigger?: ReactElement;
}) {
	const integrationFieldId = useId();
	const nameId = useId();
	const descriptionId = useId();
	const integrationsQuery = useConnectionsOverview(workspaceId);
	const integrations = (integrationsQuery.data ?? []).filter(
		(entry) => entry.connectable || entry.id === presetIntegrationId,
	);
	const createSession = useCreateConnectSession();
	const completeSession = useCompleteConnectSession();
	const connectWithKey = useConnectWithApiKey();
	const reconnectAccount = useReconnectConnection();
	const keyId = useId();
	const [apiKey, setApiKey] = useState("");
	const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

	const [open, setOpen] = useState(false);
	const [integrationId, setIntegrationId] = useState(presetIntegrationId ?? "");
	const [name, setName] = useState("");
	const [nameTouched, setNameTouched] = useState(false);
	const [description, setDescription] = useState("");
	const [state, setState] = useState<DialogState>({ step: "form" });
	const [preferKey, setPreferKey] = useState(false);
	const waiting = useRef<AbortController | null>(null);

	const integration: ConnectionIntegration | undefined = integrations.find(
		(entry) => entry.id === integrationId,
	);
	const keyAuth = connectionKeyAuth(integration);
	const signInOffered = integration?.auth?.kind === "oauth";
	const usesKey =
		keyAuth !== null &&
		(!signInOffered ||
			(reconnecting ? reconnecting.kind === "static" : preferKey));
	const secretName = reconnecting
		? reconnecting.name
		: nameTouched
			? name
			: integrationId
				? defaultSecretName(integrationId)
				: "";
	const nameIsValid = SECRET_NAME.test(secretName);

	const reset = () => {
		waiting.current?.abort();
		waiting.current = null;
		setIntegrationId(presetIntegrationId ?? "");
		setName("");
		setNameTouched(false);
		setDescription("");
		setApiKey("");
		setFieldValues({});
		setPreferKey(false);
		setState({ step: "form" });
	};

	const fail = (error: unknown) => {
		if (
			error instanceof ApiError &&
			error.code === "CONNECTION_SESSION_EXPIRED"
		) {
			setState({ step: "expired" });
			return;
		}
		setState({
			step: "error",
			code: error instanceof ApiError ? (error.code ?? null) : null,
			message:
				error instanceof ApiError
					? error.message
					: "The account could not be connected.",
		});
	};

	const consent = async (session: ConnectSession) => {
		if (!workspaceId) return;
		waiting.current?.abort();
		const controller = new AbortController();
		waiting.current = controller;
		setState({ step: "connecting" });
		try {
			const { secret } = await runConsent(session, consentClient, {
				signal: controller.signal,
				poll: () =>
					completeSession.mutateAsync({
						workspaceId,
						sessionId: session.sessionId,
					}),
			});
			setState({ step: "done", secret });
		} catch (error) {
			if (error instanceof ConsentError) {
				if (error.kind === "popup_blocked")
					setState({ step: "popup_blocked", session });
				else if (error.kind === "expired") setState({ step: "expired" });
				return;
			}
			if (controller.signal.aborted) return;
			fail(error);
		} finally {
			if (waiting.current === controller) waiting.current = null;
		}
	};

	const keyFields = usesKey ? (keyAuth?.fields ?? null) : null;
	const fieldIsValid = (value: string | undefined) =>
		value !== undefined && /^[\x21-\x7e]{1,4096}$/.test(value);
	const keyIsValid = keyFields
		? keyFields.every((field) => fieldIsValid(fieldValues[field.name]))
		: /^[\x21-\x7e]{8,}$/.test(apiKey);
	const credential = keyFields
		? {
				fields: Object.fromEntries(
					keyFields.map((f) => [f.name, fieldValues[f.name] ?? ""]),
				),
			}
		: { apiKey };

	const start = async () => {
		if (!workspaceId || !integration || !nameIsValid) return;
		setState({ step: "connecting" });
		if (usesKey) {
			if (!keyIsValid) return;
			try {
				const secret = reconnecting
					? await reconnectAccount
							.mutateAsync({ workspaceId, secretName, ...credential })
							.then((result) => {
								if (result.status !== "completed")
									throw new Error("A key account was answered with a sign-in.");
								return result.secret;
							})
					: await connectWithKey.mutateAsync({
							workspaceId,
							integrationId: integration.id,
							secretName,
							...credential,
							description: description.trim() || undefined,
						});
				setApiKey("");
				setFieldValues({});
				setState({ step: "done", secret });
			} catch (error) {
				fail(error);
			}
			return;
		}
		let session: ConnectSession;
		try {
			if (reconnecting) {
				const result = await reconnectAccount.mutateAsync({
					workspaceId,
					secretName,
				});
				if (result.status === "completed") {
					setState({ step: "done", secret: result.secret });
					return;
				}
				session = result.session;
			} else {
				session = await createSession.mutateAsync({
					workspaceId,
					integrationId: integration.id,
					secretName,
					description: description.trim() || undefined,
				});
			}
		} catch (error) {
			fail(error);
			return;
		}
		await consent(session);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) reset();
			}}
		>
			<DialogTrigger
				render={
					trigger ?? (
						<Button size="sm" disabled={!workspaceId}>
							Connect an account
						</Button>
					)
				}
			/>
			<DialogPopup
				className={state.step === "done" ? "sm:max-w-2xl" : undefined}
			>
				<DialogHeader>
					<DialogTitle>
						{reconnecting
							? `Reconnect ${reconnecting.name}`
							: presetIntegrationId && integration
								? `Connect ${integration.name}`
								: "Connect an account"}
					</DialogTitle>
					<DialogDescription>
						{reconnecting
							? usesKey
								? "Create a new key at the provider and paste it here. Anlyon checks it the way it checked the first one, then replaces the stored value. The secret keeps its name, so the actions that use it do not change."
								: "Sign in at the provider again and approve Anlyon's access. The account keeps its secret name, so the actions that use it do not change."
							: usesKey
								? "You create a key at the provider and paste it here. Anlyon checks it with the provider, then stores it as a secret bound to the provider's API hosts. Nobody can read it back, including you."
								: "You sign in at the provider and approve Anlyon's access there. The account becomes a secret bound to the provider's API hosts."}
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="space-y-4 py-2">
					{state.step === "done" ? (
						<>
							<Alert variant="success" role="status">
								<AlertTitle>
									{reconnecting
										? `Reconnected ${state.secret.name}`
										: `Connected as ${state.secret.name}`}
								</AlertTitle>
								<AlertDescription>
									{reconnecting
										? "It works again, under the same name. Nothing that references it changed."
										: `Its token may only be sent to ${state.secret.allowedHosts?.join(", ") ?? "its provider"}.`}
								</AlertDescription>
							</Alert>
							{workspaceId && integration && !reconnecting ? (
								<OperationsFlow
									workspaceId={workspaceId}
									workspaceName={workspaceName ?? "this workspace"}
									environmentName={
										environment?.name ?? "the default environment"
									}
									environmentId={environment?.id}
									integration={integration}
									secretName={state.secret.name}
									api={operationsApi}
								/>
							) : null}
						</>
					) : (
						<>
							{integrationsQuery.isLoading ? (
								<Skeleton className="h-9 w-full rounded-lg" />
							) : integrations.length === 0 ? (
								<p className="text-muted-foreground text-sm">
									No integrations can be connected on this workspace yet.
								</p>
							) : presetIntegrationId && integration ? null : (
								<Field>
									<FieldLabel htmlFor={integrationFieldId}>
										Integration
									</FieldLabel>
									<NativeSelect
										id={integrationFieldId}
										value={integrationId}
										onChange={(e) => setIntegrationId(e.target.value)}
										disabled={state.step === "connecting"}
									>
										<NativeSelectOption value="">
											Choose an integration…
										</NativeSelectOption>
										{integrations.map((entry) => (
											<NativeSelectOption key={entry.id} value={entry.id}>
												{entry.name}
											</NativeSelectOption>
										))}
									</NativeSelect>
									<p className="text-muted-foreground text-xs">
										Not in the list? Close this and search Integrations for the
										app: it shows the best way there.
									</p>
								</Field>
							)}

							{integration && usesKey && keyAuth ? (
								<>
									<KeyInstructions auth={keyAuth} />
									{keyFields ? (
										keyFields.map((field) => (
											<KeyFieldInput
												key={field.name}
												field={field}
												value={fieldValues[field.name] ?? ""}
												hostTemplate={integration.hostTemplate}
												disabled={state.step === "connecting"}
												onChange={(value) =>
													setFieldValues((current) => ({
														...current,
														[field.name]: value,
													}))
												}
											/>
										))
									) : (
										<Field>
											<FieldLabel htmlFor={keyId}>API key</FieldLabel>
											<Input
												id={keyId}
												name="integration-api-key"
												type="password"
												value={apiKey}
												autoComplete="off"
												spellCheck={false}
												onChange={(e) => setApiKey(e.target.value.trim())}
												placeholder="Paste the key"
												className="font-mono"
												disabled={state.step === "connecting"}
												aria-invalid={apiKey !== "" && !keyIsValid}
											/>
											{apiKey !== "" && !keyIsValid ? (
												<p className="text-destructive text-xs" role="alert">
													That does not look like a whole key. Paste it again,
													with no spaces.
												</p>
											) : null}
										</Field>
									)}
									<p className="text-muted-foreground text-sm">
										The key may only be sent to:{" "}
										{integration.hostTemplate
											? `your account's own host, ${integration.hostTemplate}`
											: integration.hosts?.join(", ")}
									</p>
								</>
							) : integration ? (
								<div className="space-y-1 text-sm">
									<p className="text-muted-foreground">
										Access Anlyon asks for:{" "}
										{integration.scopes.length > 0
											? integration.scopes.join(", ")
											: "what you grant at the provider"}
									</p>
									<p className="text-muted-foreground">
										The token may only be sent to:{" "}
										{integration.hostsFromAccount
											? "your account's own API host"
											: integration.hosts?.join(", ")}
									</p>
								</div>
							) : null}

							{integration && signInOffered && keyAuth && !reconnecting ? (
								<Button
									className="h-auto p-0"
									disabled={state.step === "connecting"}
									onClick={() => setPreferKey((current) => !current)}
									size="sm"
									type="button"
									variant="link"
								>
									{usesKey
										? `Sign in at ${integration.name} instead`
										: "Use a token instead"}
								</Button>
							) : null}

							{reconnecting ? (
								<p className="text-muted-foreground text-sm">
									Secret name:{" "}
									<span className="font-mono text-foreground" translate="no">
										{reconnecting.name}
									</span>
									. Unchanged.
								</p>
							) : (
								<Field>
									<FieldLabel htmlFor={nameId}>Secret name</FieldLabel>
									<Input
										id={nameId}
										name="secret-name"
										value={secretName}
										autoComplete="off"
										spellCheck={false}
										onChange={(e) => {
											setNameTouched(true);
											setName(e.target.value.toUpperCase().trim());
										}}
										placeholder="HUBSPOT"
										className="font-mono"
										disabled={state.step === "connecting"}
										aria-invalid={secretName !== "" && !nameIsValid}
									/>
									{secretName && !nameIsValid ? (
										<p className="text-destructive text-xs" role="alert">
											Uppercase letters, digits and underscores only.
										</p>
									) : null}
								</Field>
							)}

							{reconnecting ? null : (
								<Field>
									<FieldLabel htmlFor={descriptionId}>
										Description (optional)
									</FieldLabel>
									<Textarea
										id={descriptionId}
										value={description}
										onChange={(e) => setDescription(e.target.value)}
										placeholder="Which account this is"
										className="min-h-16"
										disabled={state.step === "connecting"}
									/>
								</Field>
							)}

							<ConnectStatus state={state} usesKey={usesKey} />
						</>
					)}
				</DialogPanel>

				<DialogFooter>
					{state.step === "done" ? (
						<>
							{reconnecting ? null : (
								<Button variant="outline" onClick={reset}>
									Connect another
								</Button>
							)}
							<DialogClose render={<Button>Done</Button>} />
						</>
					) : (
						<>
							<DialogClose render={<Button variant="outline">Cancel</Button>} />
							{state.step === "popup_blocked" ? (
								<Button onClick={() => void consent(state.session)}>
									Open the sign-in window
								</Button>
							) : (
								<Button
									disabled={
										!integration ||
										!nameIsValid ||
										(usesKey && !keyIsValid) ||
										state.step === "connecting"
									}
									onClick={() => void start()}
								>
									{state.step === "connecting" ? (
										<Spinner className="size-4" aria-hidden="true" />
									) : (
										<Link2 className="size-4" aria-hidden="true" />
									)}
									{state.step === "expired" || state.step === "error"
										? "Try again"
										: reconnecting
											? "Reconnect"
											: "Connect"}
								</Button>
							)}
						</>
					)}
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function KeyInstructions({
	auth,
}: {
	auth: { instructions: string; instructionsUrl: string };
}) {
	return (
		<div className="space-y-1 text-sm">
			<p className="text-muted-foreground">{auth.instructions}</p>
			<a
				className="underline underline-offset-2"
				href={auth.instructionsUrl}
				rel="noreferrer noopener"
				target="_blank"
			>
				Open the provider's page for creating a key
			</a>
		</div>
	);
}

function KeyFieldInput({
	field,
	value,
	hostTemplate,
	disabled,
	onChange,
}: {
	field: ConnectionField;
	value: string;
	hostTemplate?: string;
	disabled: boolean;
	onChange: (value: string) => void;
}) {
	const id = useId();
	const invalid = value !== "" && !/^[\x21-\x7e]{1,4096}$/.test(value);
	const host =
		field.kind === "account" && hostTemplate && value
			? hostTemplate.replace(`{${field.name}}`, value.toLowerCase())
			: null;
	return (
		<Field>
			<FieldLabel htmlFor={id}>{field.label}</FieldLabel>
			<Input
				id={id}
				name={`integration-field-${field.name}`}
				type={field.secret ? "password" : "text"}
				value={value}
				autoComplete="off"
				spellCheck={false}
				onChange={(e) => onChange(e.target.value.trim())}
				className="font-mono"
				disabled={disabled}
				aria-invalid={invalid}
			/>
			{field.hint ? (
				<p className="text-muted-foreground text-xs">{field.hint}</p>
			) : null}
			{host ? (
				<p className="text-muted-foreground text-xs" translate="no">
					{host}
				</p>
			) : null}
			{invalid ? (
				<p className="text-destructive text-xs" role="alert">
					Paste it again, with no spaces.
				</p>
			) : null}
		</Field>
	);
}

function ConnectStatus({
	state,
	usesKey = false,
}: {
	state: DialogState;
	usesKey?: boolean;
}) {
	switch (state.step) {
		case "connecting":
			return (
				<p
					className="text-muted-foreground text-sm"
					role="status"
					aria-live="polite"
				>
					{usesKey
						? "Checking the key with the provider…"
						: "Waiting for you to approve access in the sign-in window. Cancel stops waiting; nothing is saved until you approve."}
				</p>
			);
		case "popup_blocked":
			return (
				<Alert variant="warning" role="alert">
					<AlertTitle>The sign-in window was blocked</AlertTitle>
					<AlertDescription>
						Your browser blocked the window. Open it with the button below.
					</AlertDescription>
				</Alert>
			);
		case "expired":
			return (
				<Alert variant="warning" role="alert">
					<AlertTitle>The session expired</AlertTitle>
					<AlertDescription>
						Connecting has to finish within 15 minutes. Start again.
					</AlertDescription>
				</Alert>
			);
		case "error":
			return (
				<Alert variant="error" role="alert">
					<AlertTitle>The account was not connected</AlertTitle>
					<AlertDescription>
						{state.message}
						{state.code ? ` (${state.code})` : ""}
					</AlertDescription>
				</Alert>
			);
		default:
			return null;
	}
}

export function ConnectedAccountLink() {
	return (
		<Link to="/integrations" className="text-xs underline underline-offset-2">
			Manage under Integrations
		</Link>
	);
}
