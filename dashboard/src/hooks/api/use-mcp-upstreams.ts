import { isFeatureEnabled } from "@anlyon/feature-flags";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { ApiError, apiClient } from "@/lib/api-client";

export type McpRiskClass = "read" | "write" | "irreversible" | "destructive";

export type McpSchemaCheck = "full" | "loose";

export interface McpToolSnapshot {
	name: string;
	hash: string;
	definition: {
		name: string;
		title?: string;
		description?: string;
		inputSchema?: unknown;
		annotations?: Record<string, unknown>;
	};
	suggestedClass: McpRiskClass;
	reasons: string[];
	schemaCheck?: McpSchemaCheck;
	schemaCheckReason?: string | null;
}

export interface McpAdoptedTool {
	tool: string;
	action: string;
	actionId: string;
	enabled: boolean;
	state: "current" | "changed" | "missing";
	toolHash?: string;
	schemaCheck?: McpSchemaCheck;
	schemaCheckReason?: string | null;
}

export interface AdoptedToolSource {
	server: string;
	url: string;
	tool: string;
	toolHash: string | null;
	state: McpAdoptedTool["state"];
	schemaCheck: McpSchemaCheck;
}

export function useAdoptedToolSource(
	workspaceId: string | undefined,
	actionId: string | undefined,
): AdoptedToolSource | null {
	const servers = useQuery({
		queryKey: mcpUpstreamKeys.list(workspaceId),
		queryFn: () =>
			apiClient.get<McpUpstream[]>("/mcp-upstreams", { workspaceId }),
		enabled: !!workspaceId && !!actionId && isFeatureEnabled("mcp-upstreams"),
		retry: false,
	}).data;
	if (!actionId) return null;
	for (const server of servers ?? []) {
		const adopted = server.adopted.find((a) => a.actionId === actionId);
		if (adopted) {
			return {
				server: server.name,
				url: server.url,
				tool: adopted.tool,
				toolHash: adopted.toolHash ?? null,
				state: adopted.state,
				schemaCheck: adopted.schemaCheck ?? "full",
			};
		}
	}
	return null;
}

export interface McpToolChange {
	tool: string;
	kind: "changed" | "removed" | "added";
	action: string | null;
	actionId: string | null;
	pinnedHash: string | null;
	currentHash: string | null;
	suggestedClass: McpRiskClass | null;
	before: Record<string, unknown> | null;
	detectedAt: string;
}

export interface McpUpstreamCheck {
	status: "ok" | "failed" | "needs_sign_in" | "pending";
	checkedAt: string | null;
	nextCheckAt: string | null;
	failures: number;
}

export interface McpUpstream {
	id: string;
	name: string;
	url: string;
	headers: Record<string, string>;
	registryName: string | null;
	protocolVersion: string | null;
	transport?: "streamable-http" | "sse" | null;
	serverInfo: { name?: string; title?: string; version?: string } | null;
	tools: McpToolSnapshot[];
	toolsHash: string | null;
	listedAt: string | null;
	lastError: { code: string; message: string; at: string } | null;
	listedWith: "anonymous" | "headers" | "operator" | null;
	check?: McpUpstreamCheck;
	changes?: McpToolChange[];
	oauth: {
		resource: string;
		issuer: string;
		authorizationServers: string[];
		authorizationEndpoint: string;
		tokenEndpoint: string;
		scopesSupported: string[];
		scopes: string[];
		clientId: string;
		clientRegistration:
			| "pre_registered"
			| "client_metadata_document"
			| "dynamic";
		advertised: {
			dynamicRegistration: boolean;
			clientIdMetadataDocuments: boolean;
			pkceS256: boolean;
		};
		publicClient: boolean;
		redirectUri: string;
		operatorConnected: boolean;
	} | null;
	adopted: McpAdoptedTool[];
	archivedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface McpAdoptChoice {
	requiresApproval?: boolean;
	description?: string;
	toolHash?: string;
}

export interface McpAdoptResult {
	adopted: Array<{
		tool: string;
		readopted: boolean;
		action: { name: string };
	}>;
	skipped: Array<{ tool: string; reason: string }>;
}

export interface McpRegistration {
	name: string;
	url: string;
	headers?: Record<string, string>;
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		scopes?: string[];
		authorizationServer?: string;
	};
}

export interface McpSignIn {
	issuer: string;
	authorizationHost: string;
	tokenHost: string;
	scopesSupported: string[];
	advertised: {
		dynamicRegistration: boolean;
		clientIdMetadataDocuments: boolean;
		pkceS256: boolean;
	};
	redirectUri: string | null;
}

export type McpInspection =
	| {
			kind: "open";
			host: string;
			toolCount: number;
			serverInfo: McpUpstream["serverInfo"];
			transport?: "streamable-http" | "sse";
			signIn: McpSignIn | null;
	  }
	| { kind: "oauth"; host: string; signIn: McpSignIn }
	| { kind: "credential"; host: string; status: number }
	| { kind: "refused"; host: string; reason: string; message: string }
	| { kind: "unreachable"; host: string; message: string };

export const mcpUpstreamKeys = {
	all: ["mcp-upstreams"] as const,
	list: (workspaceId?: string) =>
		[...mcpUpstreamKeys.all, "list", workspaceId] as const,
};

const errorMessage = (error: unknown) =>
	error instanceof ApiError ? error.message : "Something went wrong.";

export function useMcpUpstreams(workspaceId?: string, pollMs?: number) {
	return useQuery({
		queryKey: mcpUpstreamKeys.list(workspaceId),
		queryFn: () =>
			apiClient.get<McpUpstream[]>("/mcp-upstreams", { workspaceId }),
		enabled: !!workspaceId,
		refetchInterval: pollMs ?? false,
		refetchIntervalInBackground: pollMs !== undefined,
	});
}

export function useInspectMcpServer(workspaceId?: string) {
	return useMutation({
		mutationFn: (url: string) =>
			apiClient.post<McpInspection>(
				"/mcp-upstreams/inspect",
				{ url },
				{ workspaceId },
			),
	});
}

function useUpstreamMutation<V, R>(
	workspaceId: string | undefined,
	call: (variables: V) => Promise<R>,
	success: (result: R) => string | null,
	options: { quietErrors?: boolean } = {},
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: call,
		onSuccess: (result) => {
			queryClient.invalidateQueries({
				queryKey: mcpUpstreamKeys.list(workspaceId),
			});
			const message = success(result);
			if (message) toast.success(message);
		},
		onError: (error) => {
			if (!options.quietErrors) toast.error(errorMessage(error));
		},
	});
}

export function useRegisterMcpUpstream(workspaceId?: string) {
	return useUpstreamMutation(
		workspaceId,
		(body: McpRegistration) =>
			apiClient.post<McpUpstream>("/mcp-upstreams", body, { workspaceId }),
		(upstream) => `Added ${upstream.name}.`,
		{ quietErrors: true },
	);
}

export function useConnectMcpUpstream(workspaceId?: string) {
	return useUpstreamMutation(
		workspaceId,
		(id: string) =>
			apiClient.post<{ url: string; expiresAt: string; redirectUri: string }>(
				`/mcp-upstreams/${encodeURIComponent(id)}/connect`,
				undefined,
				{ workspaceId },
			),
		() => null,
	);
}

export function useMcpUpstreamConnectLink(workspaceId?: string) {
	return useUpstreamMutation(
		workspaceId,
		({ id, endUserId }: { id: string; endUserId: string }) =>
			apiClient.post<{ url: string; expiresAt: string }>(
				`/mcp-upstreams/${encodeURIComponent(id)}/connect-links`,
				{ endUserId },
				{ workspaceId },
			),
		() => "Connect link created.",
	);
}

export function useRefreshMcpUpstream(workspaceId?: string) {
	return useUpstreamMutation(
		workspaceId,
		(id: string) =>
			apiClient.post<McpUpstream>(
				`/mcp-upstreams/${encodeURIComponent(id)}/refresh`,
				undefined,
				{ workspaceId },
			),
		(upstream) =>
			upstream.lastError
				? "The listing failed. The page says why."
				: `Listed ${upstream.tools.length} ${upstream.tools.length === 1 ? "tool" : "tools"}.`,
	);
}

export function useAdoptMcpTools(workspaceId?: string) {
	return useUpstreamMutation(
		workspaceId,
		({ id, tools }: { id: string; tools: Record<string, McpAdoptChoice> }) =>
			apiClient.post<McpAdoptResult>(
				`/mcp-upstreams/${encodeURIComponent(id)}/adopt`,
				{ tools },
				{ workspaceId },
			),
		(result) =>
			result.adopted.length > 0
				? `Adopted ${result.adopted.length} ${result.adopted.length === 1 ? "tool" : "tools"}.`
				: null,
	);
}

export function useArchiveMcpUpstream(workspaceId?: string) {
	return useUpstreamMutation(
		workspaceId,
		(id: string) =>
			apiClient.post<McpUpstream & { archivedActions?: number }>(
				`/mcp-upstreams/${encodeURIComponent(id)}/archive`,
				undefined,
				{ workspaceId },
			),
		(upstream) => {
			const n = upstream.archivedActions ?? 0;
			return n === 0
				? `Archived ${upstream.name}.`
				: `Archived ${upstream.name} and removed its ${n === 1 ? "action" : `${n} actions`} from Actions. Their call history stays.`;
		},
	);
}
