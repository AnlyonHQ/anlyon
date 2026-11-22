import { isFeatureEnabled } from "@anlyon/feature-flags";
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { integrationName } from "@/lib/end-users";
import type {
	ConnectConfirmation,
	EndUserConnection,
	EndUserConnectLink,
	EndUserPage,
	Environment,
	EnvironmentOAuthApp,
	ImpactLimit,
} from "@/lib/types";
import { connectionKeys } from "./use-connections";
import { impactLimitKeys, withEnvironment } from "./use-effects";
import { environmentKeys } from "./use-environments";

export const endUserKeys = {
	all: ["end-users"] as const,
	list: (
		workspaceId?: string,
		environmentId?: string,
		cursor?: string,
		prefix?: string,
		integration?: string,
	) =>
		[
			...endUserKeys.all,
			"list",
			workspaceId,
			environmentId,
			cursor,
			prefix,
			integration,
		] as const,
	connections: (
		workspaceId?: string,
		environmentId?: string,
		endUserId?: string,
	) =>
		[
			...endUserKeys.all,
			"connections",
			workspaceId,
			environmentId,
			endUserId,
		] as const,
	oauthApp: (
		workspaceId?: string,
		environmentId?: string,
		integration?: string,
	) =>
		[
			...endUserKeys.all,
			"oauth-app",
			workspaceId,
			environmentId,
			integration,
		] as const,
};

const enabled = (workspaceId?: string) =>
	!!workspaceId && isFeatureEnabled("connected-accounts");

const endUserPath = (endUserId: string) =>
	`/end-users/${encodeURIComponent(endUserId)}`;

export function useEndUsers(
	workspaceId?: string,
	environmentId?: string,
	cursor?: string,
	prefix?: string,
	integration?: string,
) {
	return useQuery({
		queryKey: endUserKeys.list(
			workspaceId,
			environmentId,
			cursor,
			prefix,
			integration,
		),
		queryFn: () =>
			apiClient.get<EndUserPage>("/end-users", {
				workspaceId,
				params: { environmentId, cursor, prefix, integration },
			}),
		enabled: enabled(workspaceId),
		placeholderData: keepPreviousData,
	});
}

export function useEndUserConnections(
	workspaceId?: string,
	environmentId?: string,
	endUserId?: string,
) {
	return useQuery({
		queryKey: endUserKeys.connections(workspaceId, environmentId, endUserId),
		queryFn: () =>
			apiClient.get<EndUserConnection[]>(
				`${endUserPath(endUserId ?? "")}/connections`,
				{ workspaceId, params: { environmentId } },
			),
		enabled: enabled(workspaceId) && !!endUserId,
	});
}

export function useEndUserLimits(
	workspaceId?: string,
	environmentId?: string,
	endUserId?: string,
) {
	return useQuery({
		queryKey: [
			...impactLimitKeys.scope(workspaceId, environmentId),
			"end-user",
			endUserId,
		],
		queryFn: () =>
			apiClient.get<ImpactLimit[]>("/impact-limits", {
				workspaceId,
				params: { environmentId, endUserId },
			}),
		select: (limits) =>
			limits.filter((limit) => limit.scope.kind === "end_user"),
		enabled: enabled(workspaceId) && !!endUserId,
	});
}

export function useRevokeEndUserConnection(
	workspaceId?: string,
	environmentId?: string,
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			endUserId,
			integration,
		}: {
			endUserId: string;
			integration: string;
		}) =>
			apiClient.delete<unknown>(
				withEnvironment(
					`${endUserPath(endUserId)}/connections/${encodeURIComponent(integration)}`,
					environmentId,
				),
				{ workspaceId },
			),
		onSuccess: (_, { integration }) => {
			queryClient.invalidateQueries({ queryKey: endUserKeys.all });
			queryClient.invalidateQueries({ queryKey: connectionKeys.all });
			toast.success(`${integrationName(integration)} revoked.`);
		},
		onError: (error: Error) =>
			toast.error(error.message || "The connection could not be revoked."),
	});
}

export function useEraseEndUser(workspaceId?: string, environmentId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ endUserId }: { endUserId: string }) =>
			apiClient.delete<unknown>(
				withEnvironment(endUserPath(endUserId), environmentId),
				{ workspaceId },
			),
		onSuccess: (_, { endUserId }) => {
			queryClient.invalidateQueries({ queryKey: endUserKeys.all });
			queryClient.invalidateQueries({ queryKey: connectionKeys.all });
			queryClient.invalidateQueries({ queryKey: ["approvals"] });
			queryClient.invalidateQueries({ queryKey: ["impact-limits"] });
			toast.success(`${endUserId} erased.`);
		},
		onError: (error: Error) =>
			toast.error(error.message || "The end user could not be erased."),
	});
}

const oauthAppPath = (environmentId: string, integration: string) =>
	`/environments/${encodeURIComponent(environmentId)}/oauth-apps/${encodeURIComponent(integration)}`;

export function useEnvironmentOAuthApp(
	workspaceId?: string,
	environmentId?: string,
	integration?: string,
) {
	return useQuery({
		queryKey: endUserKeys.oauthApp(workspaceId, environmentId, integration),
		queryFn: () =>
			apiClient.get<EnvironmentOAuthApp>(
				oauthAppPath(environmentId ?? "", integration ?? ""),
				{ workspaceId },
			),
		enabled: enabled(workspaceId) && !!environmentId && !!integration,
	});
}

export function useSaveEnvironmentOAuthApp(
	workspaceId?: string,
	environmentId?: string,
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			integration,
			clientId,
			clientSecret,
		}: {
			integration: string;
			clientId: string;
			clientSecret: string;
		}) =>
			apiClient.put<EnvironmentOAuthApp>(
				oauthAppPath(environmentId ?? "", integration),
				{ clientId, clientSecret },
				{ workspaceId },
			),
		onSuccess: (_, { integration }) => {
			queryClient.invalidateQueries({
				queryKey: endUserKeys.oauthApp(workspaceId, environmentId, integration),
			});
			queryClient.invalidateQueries({ queryKey: connectionKeys.all });
			toast.success(`Your ${integrationName(integration)} app is saved.`);
		},
	});
}

export function useDeleteEnvironmentOAuthApp(
	workspaceId?: string,
	environmentId?: string,
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ integration }: { integration: string }) =>
			apiClient.delete<unknown>(
				oauthAppPath(environmentId ?? "", integration),
				{
					workspaceId,
				},
			),
		onSuccess: (_, { integration }) => {
			queryClient.invalidateQueries({
				queryKey: endUserKeys.oauthApp(workspaceId, environmentId, integration),
			});
			queryClient.invalidateQueries({ queryKey: connectionKeys.all });
			toast.success(`${integrationName(integration)} uses Anlyon's app again.`);
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useSaveConnectSettings(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			environmentId,
			...settings
		}: {
			environmentId: string;
			allowedRedirectUrls?: string[];
			defaultRedirectUrl?: string | null;
			connectConfirmation?: ConnectConfirmation;
		}) =>
			apiClient.patch<Environment>(
				`/workspaces/${workspaceId}/environments/${environmentId}`,
				settings,
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: environmentKeys.all });
			toast.success("Connect settings saved.");
		},
	});
}

export function useCreateEndUserConnectLink(
	workspaceId?: string,
	environmentId?: string,
) {
	return useMutation({
		mutationFn: ({
			endUserId,
			integration,
		}: {
			endUserId: string;
			integration: string;
		}) =>
			apiClient.post<EndUserConnectLink>(
				`${endUserPath(endUserId)}/connect-links`,
				{ integration },
				{ workspaceId, params: { environmentId } },
			),
	});
}
