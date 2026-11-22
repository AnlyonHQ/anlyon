import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "@/components/ui/toast";
import { useEnvironments } from "@/hooks/api/use-environments";
import { workspaceKeys } from "@/hooks/api/use-workspaces";
import { apiClient } from "@/lib/api-client";
import type {
	EnvironmentRole,
	EnvironmentRoleGrant,
	Role,
	WorkspacePermission,
	WorkspacePermissions,
} from "@/lib/types";

export const permissionKeys = {
	all: ["permissions"] as const,
	workspace: (workspaceId?: string) =>
		[...permissionKeys.all, workspaceId] as const,
};

export const ENVIRONMENT_SCOPED_PERMISSIONS: ReadonlySet<WorkspacePermission> =
	new Set<WorkspacePermission>([
		"environments.halt",
		"environments.resume",
		"policies.manage",
		"actions.manage",
		"actions.invoke",
		"actions.resolve",
		"connections.manage",
		"oauth-apps.manage",
		"limits.manage",
		"approvals.request",
		"approvals.decide",
		"resources.write",
	]);

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
	admin: "Everything, including billing, members and deleting the workspace.",
	member: "Runs actions, connects accounts, sets limits and decides approvals.",
	approver: "Views everything and decides approvals. Changes nothing else.",
	viewer: "Views everything. Changes nothing.",
};

export const ROLE_LABELS: Record<Role, string> = {
	admin: "Admin",
	member: "Member",
	approver: "Approver",
	viewer: "Viewer",
};

export const ASSIGNABLE_ROLE_ORDER: EnvironmentRole[] = [
	"member",
	"approver",
	"viewer",
	"admin",
];

export function useWorkspacePermissions(workspaceId?: string) {
	return useQuery({
		queryKey: permissionKeys.workspace(workspaceId),
		queryFn: () =>
			apiClient.get<WorkspacePermissions>(
				`/workspaces/${workspaceId}/permissions`,
			),
		enabled: !!workspaceId,
		staleTime: 60_000,
	});
}

export function canWith(
	data: WorkspacePermissions | undefined,
	permission: WorkspacePermission,
	environmentId?: string | null,
	defaultEnvironmentId?: string | null,
): boolean {
	if (!data) return true;
	if (ENVIRONMENT_SCOPED_PERMISSIONS.has(permission)) {
		const envId = environmentId ?? defaultEnvironmentId;
		const entry = envId
			? data.environments.find((env) => env.environmentId === envId)
			: undefined;
		if (entry) return entry.permissions.includes(permission);
	}
	return data.permissions.includes(permission);
}

export type Can = (
	permission: WorkspacePermission,
	environmentId?: string | null,
) => boolean;

export function useCan(workspaceId?: string): Can {
	const { data } = useWorkspacePermissions(workspaceId);
	const environments = useEnvironments(workspaceId).data;
	const defaultEnvironmentId = environments?.find((env) => env.isDefault)?.id;
	return useCallback<Can>(
		(permission, environmentId) =>
			canWith(data, permission, environmentId, defaultEnvironmentId),
		[data, defaultEnvironmentId],
	);
}

function invalidateRoles(
	queryClient: ReturnType<typeof useQueryClient>,
	workspaceId: string,
) {
	queryClient.invalidateQueries({
		queryKey: workspaceKeys.members(workspaceId),
	});
	queryClient.invalidateQueries({ queryKey: permissionKeys.all });
}

export function useSetEnvironmentRole() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			workspaceId,
			userId,
			environmentId,
			role,
		}: {
			workspaceId: string;
			userId: string;
			environmentId: string;
			role: EnvironmentRole;
		}) =>
			apiClient.put<EnvironmentRoleGrant>(
				`/workspaces/${workspaceId}/members/${userId}/environment-roles/${environmentId}`,
				{ role },
			),
		onSuccess: (_, { workspaceId }) => {
			invalidateRoles(queryClient, workspaceId);
			toast.success("Environment role updated.");
		},
		onError: (error: Error) =>
			toast.error(error.message || "Failed to update the environment role"),
	});
}

export function useRemoveEnvironmentRole() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			workspaceId,
			userId,
			environmentId,
		}: {
			workspaceId: string;
			userId: string;
			environmentId: string;
		}) =>
			apiClient.delete<{ removed: boolean }>(
				`/workspaces/${workspaceId}/members/${userId}/environment-roles/${environmentId}`,
			),
		onSuccess: (_, { workspaceId }) => {
			invalidateRoles(queryClient, workspaceId);
			toast.success("Environment role removed.");
		},
		onError: (error: Error) =>
			toast.error(error.message || "Failed to remove the environment role"),
	});
}
