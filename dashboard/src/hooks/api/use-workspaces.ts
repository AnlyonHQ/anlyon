import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type {
	AddMemberRequest,
	ApiKey,
	ApiKeyHistoryEntryRaw,
	ApiKeyHistoryResponse,
	AssignableRole,
	CreateApiKeyRequest,
	CreateApiKeyResponse,
	CreateDeliverySecretResponse,
	CreateWorkspaceRequest,
	DeliverySecret,
	RegenerateApiKeyResponse,
	RollbackApiKeyResponse,
	SetEmergencyAccessRequest,
	UpdateMemberRequest,
	UpdateWorkspaceRequest,
	Workspace,
	WorkspaceMember,
	WorkspaceWithCredentials,
	WorkspaceWithMembership,
} from "@/lib/types";

export const workspaceKeys = {
	all: ["workspaces"] as const,
	lists: () => [...workspaceKeys.all, "list"] as const,
	list: () => [...workspaceKeys.lists()] as const,
	details: () => [...workspaceKeys.all, "detail"] as const,
	detail: (id: string) => [...workspaceKeys.details(), id] as const,
	members: (id: string) => [...workspaceKeys.all, "members", id] as const,
	member: (workspaceId: string, userId: string) =>
		[...workspaceKeys.all, "member", workspaceId, userId] as const,
	invitations: (id: string) =>
		[...workspaceKeys.all, "invitations", id] as const,
	pendingInvitations: () =>
		[...workspaceKeys.all, "pendingInvitations"] as const,
	apiKeys: (id: string) => [...workspaceKeys.all, "apiKeys", id] as const,
	apiKeyHistory: (workspaceId: string, keyId: string) =>
		[...workspaceKeys.all, "apiKeyHistory", workspaceId, keyId] as const,
	deliverySecret: (id: string) =>
		[...workspaceKeys.all, "deliverySecret", id] as const,
};

export interface WorkspaceInvitation {
	id: string;
	email: string;
	role: string;
	status: "pending" | "accepted" | "declined" | "expired" | "cancelled";
	invitedBy: {
		id: string;
		name: string | null;
		email: string;
	} | null;
	workspace: {
		id: string;
		name: string;
		slug: string;
	};
	createdAt: string;
	expiresAt: string;
	acceptedAt: string | null;
	inviteUrl?: string;
}

export interface CreateInvitationRequest {
	email: string;
	role?: AssignableRole;
}

export function useWorkspaces() {
	return useQuery({
		queryKey: workspaceKeys.list(),
		queryFn: async () => {
			const response =
				await apiClient.get<WorkspaceWithMembership[]>("/workspaces");
			return response.map((item) => item.workspace);
		},
	});
}

export function useWorkspace(workspaceId: string) {
	return useQuery({
		queryKey: workspaceKeys.detail(workspaceId),
		queryFn: () => apiClient.get<Workspace>(`/workspaces/${workspaceId}`),
		enabled: !!workspaceId,
	});
}

export function useWorkspaceRole(workspaceId?: string) {
	return useQuery({
		queryKey: [...workspaceKeys.all, "role", workspaceId] as const,
		queryFn: async () => {
			const response = await apiClient.get<WorkspaceWithMembership>(
				`/workspaces/${workspaceId}`,
			);
			return response.role;
		},
		enabled: !!workspaceId,
		staleTime: 60_000,
	});
}

export function useCreateWorkspace() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: CreateWorkspaceRequest) =>
			apiClient.post<WorkspaceWithCredentials>("/workspaces", data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: workspaceKeys.lists() });
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to create workspace");
		},
	});
}

export function useUpdateWorkspace() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			data,
		}: {
			workspaceId: string;
			data: UpdateWorkspaceRequest;
		}) => apiClient.patch<Workspace>(`/workspaces/${workspaceId}`, data),
		onSuccess: (_, { workspaceId }) => {
			queryClient.invalidateQueries({ queryKey: workspaceKeys.lists() });
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.detail(workspaceId),
			});
			toast.success("Workspace updated.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to update workspace");
		},
	});
}

export function useDeleteWorkspace() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (workspaceId: string) =>
			apiClient.delete<void>(`/workspaces/${workspaceId}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: workspaceKeys.lists() });
			toast.success("Workspace deleted.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to delete workspace");
		},
	});
}

export function useWorkspaceMembers(workspaceId: string) {
	return useQuery({
		queryKey: workspaceKeys.members(workspaceId),
		queryFn: () =>
			apiClient.get<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`),
		enabled: !!workspaceId,
	});
}

export function useWorkspaceMember(workspaceId: string, userId: string) {
	return useQuery({
		queryKey: workspaceKeys.member(workspaceId, userId),
		queryFn: () =>
			apiClient.get<WorkspaceMember>(
				`/workspaces/${workspaceId}/members/${userId}`,
			),
		enabled: !!workspaceId && !!userId,
	});
}

export function useAddMember() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			data,
		}: {
			workspaceId: string;
			data: AddMemberRequest;
		}) =>
			apiClient.post<WorkspaceMember>(
				`/workspaces/${workspaceId}/members`,
				data,
			),
		onSuccess: (_, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.members(workspaceId),
			});
			toast.success("Member added.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to add member");
		},
	});
}

export function useUpdateMemberRole() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			userId,
			data,
		}: {
			workspaceId: string;
			userId: string;
			data: UpdateMemberRequest;
		}) =>
			apiClient.patch<WorkspaceMember>(
				`/workspaces/${workspaceId}/members/${userId}`,
				data,
			),
		onSuccess: (_, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.members(workspaceId),
			});
			queryClient.invalidateQueries({ queryKey: ["permissions"] });
			toast.success("Member role updated.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to update member role");
		},
	});
}

export function useRemoveMember() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			userId,
		}: {
			workspaceId: string;
			userId: string;
		}) =>
			apiClient.delete<void>(`/workspaces/${workspaceId}/members/${userId}`),
		onSuccess: (_, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.members(workspaceId),
			});
			toast.success("Member removed.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to remove member");
		},
	});
}

export function useLeaveWorkspace() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (workspaceId: string) =>
			apiClient.post<void>(`/workspaces/${workspaceId}/leave`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: workspaceKeys.lists() });
			toast.success("Left workspace.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to leave workspace");
		},
	});
}

export function useSetEmergencyAccess() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			userId,
			data,
		}: {
			workspaceId: string;
			userId: string;
			data: SetEmergencyAccessRequest;
		}) =>
			apiClient.put<WorkspaceMember>(
				`/workspaces/${workspaceId}/members/${userId}/emergency-access`,
				data,
			),
		onSuccess: (_, { workspaceId, data }) => {
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.members(workspaceId),
			});
			toast.success(
				data.enabled ? "Emergency access given." : "Emergency access removed.",
			);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to change emergency access");
		},
	});
}

export function useApiKeys(workspaceId: string) {
	return useQuery({
		queryKey: workspaceKeys.apiKeys(workspaceId),
		queryFn: () =>
			apiClient.get<ApiKey[]>(`/workspaces/${workspaceId}/api-keys`),
		enabled: !!workspaceId,
	});
}

export function useCreateApiKey() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			data,
		}: {
			workspaceId: string;
			data: CreateApiKeyRequest;
		}) =>
			apiClient.post<CreateApiKeyResponse>(
				`/workspaces/${workspaceId}/api-keys`,
				data,
			),
		onSuccess: (_, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.apiKeys(workspaceId),
			});
			toast.success("API key created.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to create API key");
		},
	});
}

export function useDeleteApiKey() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			keyId,
		}: {
			workspaceId: string;
			keyId: string;
		}) =>
			apiClient.delete<void>(`/workspaces/${workspaceId}/api-keys/${keyId}`),
		onSuccess: (_, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.apiKeys(workspaceId),
			});
			toast.success("API key deleted.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to delete API key");
		},
	});
}

function normalizeApiKeyHistory(
	raw: ApiKeyHistoryEntryRaw[] | ApiKeyHistoryResponse,
	keyId: string,
): ApiKeyHistoryResponse {
	if (Array.isArray(raw)) {
		const history = raw.map((e) => ({
			id: e.id,
			apiKeyId: keyId,
			version: e.version,
			keyPrefix: e.keyPrefix,
			createdAt: e.rotatedAt,
			expiredAt: undefined as string | undefined,
			rollbackAvailable: e.canRollback,
			rollbackExpiresAt: e.rollbackExpiresAt,
		}));
		const rollbackWindowMinutes =
			raw[0]?.rollbackExpiresAt && raw[0]?.rotatedAt
				? Math.round(
						(new Date(raw[0].rollbackExpiresAt).getTime() -
							new Date(raw[0].rotatedAt).getTime()) /
							60000,
					)
				: 1440;
		return { history, rollbackWindowMinutes };
	}
	return raw;
}

export function useApiKeyHistory(workspaceId: string, keyId: string) {
	return useQuery({
		queryKey: workspaceKeys.apiKeyHistory(workspaceId, keyId),
		queryFn: async () => {
			const raw = await apiClient.get<
				ApiKeyHistoryEntryRaw[] | ApiKeyHistoryResponse
			>(`/workspaces/${workspaceId}/api-keys/${keyId}/history`, {
				workspaceId,
			});
			return normalizeApiKeyHistory(raw, keyId);
		},
		enabled: !!workspaceId && !!keyId,
	});
}

export function useRegenerateApiKey() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			keyId,
		}: {
			workspaceId: string;
			keyId: string;
		}) =>
			apiClient.post<RegenerateApiKeyResponse>(
				`/workspaces/${workspaceId}/api-keys/${keyId}/regenerate`,
				{},
			),
		onSuccess: (_, { workspaceId, keyId }) => {
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.apiKeys(workspaceId),
			});
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.apiKeyHistory(workspaceId, keyId),
			});
			toast.success("API key regenerated.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to regenerate API key");
		},
	});
}

export function useRollbackApiKey() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			keyId,
		}: {
			workspaceId: string;
			keyId: string;
		}) =>
			apiClient.post<RollbackApiKeyResponse>(
				`/workspaces/${workspaceId}/api-keys/${keyId}/rollback`,
				{},
			),
		onSuccess: (_, { workspaceId, keyId }) => {
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.apiKeys(workspaceId),
			});
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.apiKeyHistory(workspaceId, keyId),
			});
			toast.success("API key rolled back.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to rollback API key");
		},
	});
}

export function useDeliverySecret(workspaceId: string) {
	return useQuery({
		queryKey: workspaceKeys.deliverySecret(workspaceId),
		queryFn: () =>
			apiClient.get<DeliverySecret | null>(
				`/workspaces/${workspaceId}/delivery-secret`,
			),
		enabled: !!workspaceId,
	});
}

export function useCreateDeliverySecret() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (workspaceId: string) =>
			apiClient.post<CreateDeliverySecretResponse>(
				`/workspaces/${workspaceId}/delivery-secret`,
				{},
			),
		onSuccess: (_, workspaceId) => {
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.deliverySecret(workspaceId),
			});
			toast.success("Delivery secret created.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to create delivery secret");
		},
	});
}

export function useRegenerateDeliverySecret() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (workspaceId: string) =>
			apiClient.post<CreateDeliverySecretResponse>(
				`/workspaces/${workspaceId}/delivery-secret/regenerate`,
				{},
			),
		onSuccess: (_, workspaceId) => {
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.deliverySecret(workspaceId),
			});
			toast.success("Delivery secret regenerated successfully");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to regenerate delivery secret");
		},
	});
}

export function useWorkspaceInvitations(workspaceId: string) {
	return useQuery({
		queryKey: workspaceKeys.invitations(workspaceId),
		queryFn: () =>
			apiClient.get<WorkspaceInvitation[]>(
				`/workspaces/${workspaceId}/invitations`,
			),
		enabled: !!workspaceId,
	});
}

export function useCreateInvitation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			data,
		}: {
			workspaceId: string;
			data: CreateInvitationRequest;
		}) =>
			apiClient.post<WorkspaceInvitation>(
				`/workspaces/${workspaceId}/invitations`,
				data,
			),
		onSuccess: (invitation, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.invitations(workspaceId),
			});
			toast.success(
				invitation.inviteUrl
					? "Invitation created"
					: "Invitation sent successfully",
			);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to send invitation");
		},
	});
}

export function useResendInvitation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			invitationId,
		}: {
			workspaceId: string;
			invitationId: string;
		}) =>
			apiClient.post<WorkspaceInvitation>(
				`/workspaces/${workspaceId}/invitations/${invitationId}/resend`,
				{},
			),
		onSuccess: (invitation, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.invitations(workspaceId),
			});
			toast.success(
				invitation.inviteUrl
					? "New invitation link created"
					: "Invitation resent successfully",
			);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to resend invitation");
		},
	});
}

export function useCancelInvitation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			invitationId,
		}: {
			workspaceId: string;
			invitationId: string;
		}) =>
			apiClient.delete<void>(
				`/workspaces/${workspaceId}/invitations/${invitationId}`,
			),
		onSuccess: (_, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.invitations(workspaceId),
			});
			toast.success("Invitation cancelled");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to cancel invitation");
		},
	});
}

export function useInvitationByToken(token: string) {
	return useQuery({
		queryKey: ["invitation", token],
		queryFn: () => apiClient.get<WorkspaceInvitation>(`/invitations/${token}`),
		enabled: !!token,
		retry: false,
	});
}

export function useAcceptInvitation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (token: string) =>
			apiClient.post<{
				message: string;
				workspace: { id: string; name: string; slug: string };
			}>(`/invitations/${token}/accept`, {}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: workspaceKeys.lists() });
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.pendingInvitations(),
			});
			toast.success("Invitation accepted! Welcome to the workspace.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to accept invitation");
		},
	});
}

export function useDeclineInvitation() {
	return useMutation({
		mutationFn: (token: string) =>
			apiClient.post<void>(`/invitations/${token}/decline`, {}),
		onSuccess: () => {
			toast.success("Invitation declined");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to decline invitation");
		},
	});
}

export function usePendingInvitations() {
	return useQuery({
		queryKey: workspaceKeys.pendingInvitations(),
		queryFn: () => apiClient.get<WorkspaceInvitation[]>(`/invitations/pending`),
	});
}
