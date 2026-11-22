import { Link, useNavigate } from "@tanstack/react-router";
import {
	DetailLayout,
	Page,
	PageHeader,
	type PageTab,
	PageTabsView,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/ui/empty";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/contexts/workspace-context";
import {
	type McpUpstream,
	useArchiveMcpUpstream,
	useRefreshMcpUpstream,
} from "@/hooks/api/use-mcp-upstreams";
import { useCan } from "@/hooks/api/use-permissions";
import {
	credentialSecretName,
	hostOf,
	LISTED_WITH,
	serverStatus,
} from "@/lib/mcp-servers";
import { CopyInline } from "./copy-value";
import { NextStepStrip } from "./next-step-strip";
import { PeopleTab } from "./people-tab";
import { TONE_VARIANT } from "./server-list";
import { CheckLine, ToolChanges } from "./tool-changes";
import { ToolsTab } from "./tools-tab";
import { UseItTab } from "./use-it-tab";
import { useSignInFlow } from "./use-sign-in-flow";

export interface ServerSearch {
	tab?: "people" | "use";
	filter?: "adopted" | "review";
}

const mono = (value: string) => (
	<code className="break-all font-mono text-[12px]" translate="no">
		{value}
	</code>
);

function ArchiveServer({
	server,
	workspaceId,
	onArchived,
}: {
	server: McpUpstream;
	workspaceId?: string;
	onArchived: () => void;
}) {
	const archive = useArchiveMcpUpstream(workspaceId);
	const count = server.adopted.length;
	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={
					<Button size="sm" variant="destructive-outline">
						Archive server
					</Button>
				}
			/>
			<AlertDialogPopup>
				<AlertDialogHeader>
					<AlertDialogTitle>
						Archive <span translate="no">{server.name}</span>?
					</AlertDialogTitle>
					<AlertDialogDescription>
						{count > 0
							? `${count === 1 ? "The action" : `The ${count} actions`} adopted from it ${count === 1 ? "leaves" : "leave"} Actions, and your agent can no longer call ${count === 1 ? "it" : "them"}. Call history stays. `
							: "Your agent could not call anything on it yet, so nothing else changes. "}
						To use this server again, add it again.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogClose
						render={<Button variant="outline">Cancel</Button>}
					/>
					<Button
						loading={archive.isPending}
						onClick={() => archive.mutate(server.id, { onSuccess: onArchived })}
						variant="destructive"
					>
						Archive server
					</Button>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}

export function ServerRail({ server }: { server: McpUpstream }) {
	const { oauth } = server;
	const secret = credentialSecretName(server);
	return (
		<PropertyList
			items={[
				{
					label: "Endpoint",
					value: <CopyInline label="endpoint" value={server.url} />,
				},
				...(server.transport === "sse"
					? [{ label: "Transport", value: "SSE, the older MCP transport" }]
					: []),
				{
					label: "Sign-in",
					value: oauth
						? `OAuth, through ${hostOf(oauth.issuer)}`
						: secret
							? "Stored credential"
							: "None",
				},
				...(secret && !oauth
					? [{ label: "Credential", value: mono(secret) }]
					: []),
				...(oauth
					? [
							{
								label: "Client",
								value:
									oauth.clientRegistration === "client_metadata_document"
										? "Anlyon's client, by its metadata document"
										: oauth.clientRegistration === "dynamic"
											? "Registered with the sign-in server by Anlyon"
											: "Your OAuth app at the vendor",
							},
							{ label: "Client id", value: mono(oauth.clientId) },
							...(oauth.authorizationServers.length > 1
								? [
										{
											label: "Also offered by",
											value: oauth.authorizationServers
												.filter((server) => server !== oauth.issuer)
												.map(hostOf)
												.join(", "),
										},
									]
								: []),
							{
								label: "Client secret",
								value: oauth.publicClient
									? "None (public client)"
									: `Sent only to ${hostOf(oauth.tokenEndpoint)}`,
							},
							{
								label: "Scopes",
								value:
									oauth.scopes.length > 0 ? (
										<span className="flex flex-col gap-0.5">
											{oauth.scopes.map((scope) => (
												<span key={scope}>{mono(scope)}</span>
											))}
										</span>
									) : (
										"None"
									),
							},
							...(oauth.clientRegistration === "pre_registered"
								? [
										{
											label: "Callback URL",
											value: (
												<CopyInline
													label="callback URL"
													value={oauth.redirectUri}
												/>
											),
										},
									]
								: []),
						]
					: []),
				{
					label: "Last listed",
					value: server.listedAt ? (
						<RelativeTime value={server.listedAt} />
					) : (
						"Never"
					),
				},
				{
					label: "Last checked",
					value:
						server.check?.status === "needs_sign_in" ? (
							"Cannot be checked until someone connects"
						) : server.check?.checkedAt ? (
							<RelativeTime value={server.check.checkedAt} />
						) : (
							"Not yet"
						),
				},
				{
					label: "Listed with",
					value: server.listedWith ? LISTED_WITH[server.listedWith] : "Not yet",
				},
			]}
			title="Details"
		/>
	);
}

export function ServerPage({
	name,
	tab,
	filter,
}: {
	name: string;
	tab?: ServerSearch["tab"];
	filter?: ServerSearch["filter"];
}) {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const navigate = useNavigate();
	const canManage = useCan(workspaceId)("actions.manage");
	const { query, server, signIn } = useSignInFlow(workspaceId, name);
	const refresh = useRefreshMcpUpstream(workspaceId);

	if (query.isLoading) {
		return (
			<Page aria-busy="true">
				<Skeleton className="mt-2 h-8 w-64" />
				<Skeleton className="h-16 w-full rounded-lg" />
				<Skeleton className="h-96 w-full rounded-lg" />
			</Page>
		);
	}
	if (query.isError) {
		return (
			<p className="text-destructive text-sm" role="alert">
				MCP servers could not be loaded: {(query.error as Error).message}
			</p>
		);
	}
	if (!server) {
		return (
			<Empty className="py-16">
				<EmptyHeader>
					<EmptyTitle>No MCP server named “{name}”</EmptyTitle>
					<EmptyDescription>
						It is not in this environment, or it was archived. Pick one from the
						list.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						render={<Link to="/integrations" />}
						size="sm"
						variant="outline"
					>
						View integrations
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	const status = serverStatus(server);
	const params = { name: server.name };
	const shown = tab === "people" && !server.oauth ? undefined : tab;
	const tabs: Array<PageTab & { tab: ServerSearch["tab"] }> = [
		{
			tab: undefined,
			label: "Tools",
			to: "/mcp-servers/$name",
			params,
			search: {},
			count: server.tools.length,
		},
		...(server.oauth
			? [
					{
						tab: "people" as const,
						label: "People",
						to: "/mcp-servers/$name",
						params,
						search: { tab: "people" },
					},
				]
			: []),
		{
			tab: "use",
			label: "Use it",
			to: "/mcp-servers/$name",
			params,
			search: { tab: "use" },
		},
	];

	return (
		<Page>
			<PageHeader
				actions={
					canManage && server.listedAt ? (
						<Button
							loading={refresh.isPending}
							onClick={() => refresh.mutate(server.id)}
							size="sm"
							variant="outline"
						>
							List again
						</Button>
					) : null
				}
				description={
					(server.serverInfo?.title ?? server.serverInfo?.name)
						? `${hostOf(server.url)} calls itself ${server.serverInfo?.title ?? server.serverInfo?.name}.`
						: hostOf(server.url)
				}
				eyebrow="MCP server"
				meta={<Badge variant={TONE_VARIANT[status.tone]}>{status.label}</Badge>}
				mono
				title={<span translate="no">{server.name}</span>}
			/>
			<DetailLayout
				rail={
					<>
						<ServerRail server={server} />
						{canManage ? (
							<div className="border-t pt-4">
								<ArchiveServer
									onArchived={() => navigate({ to: "/integrations" })}
									server={server}
									workspaceId={workspaceId}
								/>
							</div>
						) : null}
					</>
				}
			>
				<NextStepStrip
					canManage={canManage}
					refresh={() => refresh.mutate(server.id)}
					refreshing={refresh.isPending}
					server={server}
					signIn={signIn}
				/>
				<CheckLine server={server} />
				<ToolChanges server={server} />
				<div className="flex min-w-0 flex-col gap-4">
					<PageTabsView
						isActive={(item) => (item as (typeof tabs)[number]).tab === shown}
						items={tabs}
						label="MCP server"
					/>
					{shown === "people" ? (
						<PeopleTab
							canManage={canManage}
							server={server}
							signIn={signIn}
							workspaceId={workspaceId}
						/>
					) : shown === "use" ? (
						<UseItTab server={server} workspaceId={workspaceId} />
					) : (
						<ToolsTab
							canManage={canManage}
							filter={filter ?? "all"}
							server={server}
							workspaceId={workspaceId}
						/>
					)}
				</div>
			</DetailLayout>
		</Page>
	);
}
