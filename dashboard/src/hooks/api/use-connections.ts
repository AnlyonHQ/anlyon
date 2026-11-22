import { isFeatureEnabled } from "@anlyon/feature-flags";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import type {
	ConnectionIntegration,
	ConnectionReconnect,
	ConnectSession,
	ConnectSessionCompletion,
	IntegrationOverview,
	IntegrationRouteResult,
	Secret,
} from "@/lib/types";
import { secretKeys } from "./use-actions";

export const connectionKeys = {
	all: ["connections"] as const,
	list: (workspaceId?: string) =>
		[...connectionKeys.all, "list", workspaceId] as const,
	integrations: (workspaceId?: string) =>
		[...connectionKeys.all, "integrations", workspaceId] as const,
	overview: (workspaceId?: string) =>
		[...connectionKeys.all, "overview", workspaceId] as const,
	route: (workspaceId: string | undefined, name: string) =>
		[...connectionKeys.all, "route", workspaceId, name] as const,
};

const enabled = (workspaceId?: string) =>
	!!workspaceId && isFeatureEnabled("connected-accounts");

export function useConnections(workspaceId?: string) {
	return useQuery({
		queryKey: connectionKeys.list(workspaceId),
		queryFn: () => apiClient.get<Secret[]>("/connections", { workspaceId }),
		enabled: enabled(workspaceId),
	});
}

export function useConnectionIntegrations(workspaceId?: string) {
	return useQuery({
		queryKey: connectionKeys.integrations(workspaceId),
		queryFn: () =>
			apiClient.get<ConnectionIntegration[]>("/connections/integrations", {
				workspaceId,
			}),
		enabled: enabled(workspaceId),
	});
}

export function useConnectionsOverview(workspaceId?: string) {
	return useQuery({
		queryKey: connectionKeys.overview(workspaceId),
		queryFn: () =>
			apiClient.get<IntegrationOverview[]>("/connections/overview", {
				workspaceId,
			}),
		enabled: enabled(workspaceId),
	});
}

export function useIntegrationRoute(
	workspaceId: string | undefined,
	name: string,
) {
	return useQuery({
		queryKey: connectionKeys.route(workspaceId, name),
		queryFn: () =>
			apiClient.get<IntegrationRouteResult>(
				`/connections/integrations/find?name=${encodeURIComponent(name)}`,
				{ workspaceId },
			),
		enabled: enabled(workspaceId) && name.length > 0,
		staleTime: 5 * 60_000,
		retry: false,
	});
}

export function useCreateConnectSession() {
	return useMutation({
		mutationFn: ({
			workspaceId,
			...body
		}: {
			workspaceId: string;
			integrationId: string;
			secretName: string;
			description?: string;
		}) =>
			apiClient.post<ConnectSession>("/connections/sessions", body, {
				workspaceId,
			}),
	});
}

export function useConnectWithApiKey() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			workspaceId,
			...body
		}: {
			workspaceId: string;
			integrationId: string;
			secretName: string;
			apiKey?: string;
			fields?: Record<string, string>;
			description?: string;
		}) => apiClient.post<Secret>("/connections/keys", body, { workspaceId }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: connectionKeys.all });
			queryClient.invalidateQueries({ queryKey: secretKeys.all });
		},
	});
}

export function useCompleteConnectSession() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			workspaceId,
			sessionId,
		}: {
			workspaceId: string;
			sessionId: string;
		}) =>
			apiClient.post<ConnectSessionCompletion>(
				`/connections/sessions/${encodeURIComponent(sessionId)}/complete`,
				{},
				{ workspaceId },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: connectionKeys.all });
			queryClient.invalidateQueries({ queryKey: secretKeys.all });
		},
	});
}

export function useCheckConnection() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			workspaceId,
			secretName,
		}: {
			workspaceId: string;
			secretName: string;
		}) =>
			apiClient.post<Secret>(
				`/connections/${encodeURIComponent(secretName)}/check`,
				{},
				{ workspaceId },
			),
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: connectionKeys.all });
			queryClient.invalidateQueries({ queryKey: secretKeys.all });
		},
	});
}

export function useReconnectConnection() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			workspaceId,
			secretName,
			apiKey,
			fields,
		}: {
			workspaceId: string;
			secretName: string;
			apiKey?: string;
			fields?: Record<string, string>;
		}) =>
			apiClient.post<ConnectionReconnect>(
				`/connections/${encodeURIComponent(secretName)}/reconnect`,
				fields ? { fields } : apiKey ? { apiKey } : {},
				{ workspaceId },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: connectionKeys.all });
			queryClient.invalidateQueries({ queryKey: secretKeys.all });
		},
	});
}
