import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { ApiError, apiClient } from "@/lib/api-client";
import type { ImportRequest, ImportResult } from "@/lib/openapi-import";
import type {
	Action,
	ActionImpactDeclaration,
	ActionMethod,
	ActionVerifyDeclaration,
	Invocation,
	InvocationStatus,
	PaginatedResponse,
	Secret,
	SecretPlacement,
	SecretStore,
	SecretStoreSettings,
	SecretStoreType,
} from "@/lib/types";

export const actionKeys = {
	all: ["actions"] as const,
	lists: () => [...actionKeys.all, "list"] as const,
	list: (workspaceId?: string) => [...actionKeys.lists(), workspaceId] as const,
	invocations: (
		workspaceId?: string,
		action?: string,
		offset?: number,
		status?: string,
		endUserId?: string,
		limit?: number,
	) =>
		[
			...actionKeys.all,
			"invocations",
			workspaceId,
			action,
			offset,
			status,
			endUserId,
			limit,
		] as const,
	invocation: (workspaceId?: string, id?: string) =>
		[...actionKeys.all, "invocation", workspaceId, id] as const,
};

export const secretKeys = {
	all: ["secrets"] as const,
	list: (workspaceId?: string) =>
		[...secretKeys.all, "list", workspaceId] as const,
};

export interface ActionDeclarationsInput {
	impact?: ActionImpactDeclaration | null;
	verify?: ActionVerifyDeclaration | null;
	governed?: boolean;
}

export interface ActionInput extends ActionDeclarationsInput {
	name: string;
	description?: string;
	method?: ActionMethod;
	urlTemplate: string;
	headers?: Record<string, string>;
	bodyTemplate?: Record<string, unknown>;
	inputSchema?: Record<string, unknown>;
	requiresApproval?: boolean;
	enabled?: boolean;
}

export function useActions(workspaceId?: string) {
	return useQuery({
		queryKey: actionKeys.list(workspaceId),
		queryFn: () => apiClient.get<Action[]>("/actions", { workspaceId }),
		enabled: !!workspaceId,
	});
}

export function useEnvironmentActions(
	workspaceId?: string,
	environmentId?: string,
) {
	return useQuery({
		queryKey: [...actionKeys.list(workspaceId), "env", environmentId] as const,
		queryFn: () =>
			apiClient.get<Action[]>("/actions", {
				workspaceId,
				params: { environmentId },
			}),
		enabled: !!workspaceId && !!environmentId,
	});
}

export function useInvocations(
	workspaceId?: string,
	params?: {
		action?: string;
		limit?: number;
		offset?: number;
		status?: InvocationStatus;
		endUserId?: string;
		environmentId?: string;
		actingFor?: "workspace" | "end_users";
	},
) {
	return useQuery({
		queryKey: [
			...actionKeys.invocations(
				workspaceId,
				params?.action,
				params?.offset,
				params?.status,
				params?.endUserId,
				params?.limit,
			),
			params?.environmentId,
			params?.actingFor,
		],
		queryFn: () =>
			apiClient.get<PaginatedResponse<Invocation>>("/actions/invocations", {
				workspaceId,
				params: params as Record<string, string | number | boolean | undefined>,
			}),
		enabled: !!workspaceId,
	});
}

export function useInvocation(workspaceId?: string, invocationId?: string) {
	return useQuery({
		queryKey: actionKeys.invocation(workspaceId, invocationId),
		queryFn: () =>
			apiClient.get<Invocation>(`/actions/invocations/${invocationId}`, {
				workspaceId,
			}),
		enabled: !!workspaceId && !!invocationId,
	});
}

export interface ResolveInvocationInput {
	invocationId: string;
	outcome: "succeeded" | "failed";
	evidence: string;
	externalReference?: string;
}

export function useResolveInvocation(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ invocationId, ...body }: ResolveInvocationInput) =>
			apiClient.post<Invocation>(
				`/actions/invocations/${invocationId}/resolve`,
				body,
				{ workspaceId },
			),
		onSuccess: (invocation) => {
			queryClient.invalidateQueries({ queryKey: actionKeys.all });
			toast.success(
				invocation.status === "failed"
					? "Recorded as not completed. Its usage was released."
					: "Recorded as completed.",
			);
		},
	});
}

export function useCreateAction() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			workspaceId,
			...input
		}: ActionInput & { workspaceId: string }) =>
			apiClient.post<Action, ActionInput>("/actions", input, { workspaceId }),
		onSuccess: (action) => {
			queryClient.invalidateQueries({ queryKey: actionKeys.all });
			toast.success(`Action "${action.name}" created.`);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to create action");
		},
	});
}

export function useUpdateAction() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			ref,
			workspaceId,
			...input
		}: Partial<ActionInput> & { ref: string; workspaceId: string }) =>
			apiClient.patch<Action, Partial<ActionInput>>(`/actions/${ref}`, input, {
				workspaceId,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: actionKeys.all });
			toast.success("Action updated.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to update action");
		},
	});
}

export function useImportOpenApi() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			workspaceId,
			...body
		}: ImportRequest & { workspaceId: string }) =>
			apiClient.post<ImportResult, ImportRequest>("/actions/import", body, {
				workspaceId,
			}),
		onSuccess: (result) => {
			if (!result.dryRun) {
				queryClient.invalidateQueries({ queryKey: actionKeys.all });
			}
		},
	});
}

export function useDeleteAction() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ ref, workspaceId }: { ref: string; workspaceId: string }) =>
			apiClient.delete<{ deleted: boolean }>(`/actions/${ref}`, {
				workspaceId,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: actionKeys.all });
			toast.success("Action deleted.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to delete action");
		},
	});
}

export function useInvokeAction() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			ref,
			input,
			workspaceId,
		}: {
			ref: string;
			input: Record<string, unknown>;
			workspaceId: string;
		}) =>
			apiClient.post<Invocation & { pendingApproval: boolean }>(
				`/actions/${ref}/invoke`,
				{ input },
				{ workspaceId },
			),
		onSuccess: (invocation) => {
			queryClient.invalidateQueries({ queryKey: actionKeys.all });
			queryClient.invalidateQueries({ queryKey: ["approvals"] });
			if (invocation.pendingApproval) {
				toast.success("Invocation is waiting for approval.");
			} else if (invocation.status === "succeeded") {
				toast.success(`Action succeeded (HTTP ${invocation.responseStatus}).`);
			} else {
				toast.error(invocation.error || "Action failed.");
			}
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to invoke action");
		},
	});
}

export function useSecrets(workspaceId?: string) {
	return useQuery({
		queryKey: secretKeys.list(workspaceId),
		queryFn: () => apiClient.get<Secret[]>("/secrets", { workspaceId }),
		enabled: !!workspaceId,
	});
}

export function usePutSecret() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			name,
			value,
			description,
			allowedHosts,
			allowedPlacements,
			workspaceId,
		}: {
			name: string;
			value: string;
			description?: string;
			allowedHosts?: string[] | null;
			allowedPlacements?: SecretPlacement[] | null;
			workspaceId: string;
		}) =>
			apiClient.put<Secret>(
				`/secrets/${name}`,
				{
					value,
					description,
					...(allowedHosts !== undefined ? { allowedHosts } : {}),
					...(allowedPlacements !== undefined ? { allowedPlacements } : {}),
				},
				{ workspaceId },
			),
		onSuccess: (secret) => {
			queryClient.invalidateQueries({ queryKey: secretKeys.all });
			toast.success(
				`Secret ${secret.name} saved. Its value can never be read back.`,
			);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to save secret");
		},
	});
}

export const secretStoreKeys = {
	all: ["secret-stores"] as const,
	list: (workspaceId?: string) =>
		[...secretStoreKeys.all, "list", workspaceId] as const,
};

export function useSecretStores(workspaceId?: string) {
	return useQuery({
		queryKey: secretStoreKeys.list(workspaceId),
		queryFn: async () => {
			try {
				return await apiClient.get<SecretStore[]>("/secret-stores", {
					workspaceId,
				});
			} catch (error) {
				if (error instanceof ApiError && error.status === 404) return null;
				throw error;
			}
		},
		enabled: !!workspaceId,
	});
}

export interface CreateSecretStoreInput {
	workspaceId: string;
	name: string;
	type: SecretStoreType;
	config: Record<string, unknown>;
	credential: Record<string, string>;
	description?: string;
	allowedPaths?: string[] | null;
	cacheTtlSeconds?: number;
}

export function useCreateSecretStore() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ workspaceId, ...body }: CreateSecretStoreInput) =>
			apiClient.post<SecretStore>("/secret-stores", body, { workspaceId }),
		onSuccess: (store) => {
			queryClient.invalidateQueries({ queryKey: secretStoreKeys.all });
			toast.success(
				`Secret store ${store.name} added. Its credential can never be read back.`,
			);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to add the secret store");
		},
	});
}

export function useCheckSecretStore() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			name,
			workspaceId,
		}: {
			name: string;
			workspaceId: string;
		}) =>
			apiClient.post<SecretStore>(
				`/secret-stores/${name}/check`,
				{},
				{
					workspaceId,
				},
			),
		onSuccess: (store) => {
			queryClient.invalidateQueries({ queryKey: secretStoreKeys.all });
			if (store.health?.status === "active") {
				toast.success(`Anlyon can reach ${store.name}.`);
			} else {
				toast.error(`Anlyon could not reach ${store.name}.`);
			}
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to check the secret store");
		},
	});
}

export function useDeleteSecretStore() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			name,
			workspaceId,
		}: {
			name: string;
			workspaceId: string;
		}) =>
			apiClient.delete<{ deleted: boolean }>(`/secret-stores/${name}`, {
				workspaceId,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: secretStoreKeys.all });
			toast.success("Secret store deleted.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to delete the secret store");
		},
	});
}

export const secretStoreSettingsKeys = {
	all: ["secret-store-settings"] as const,
	get: (workspaceId?: string) =>
		[...secretStoreSettingsKeys.all, workspaceId] as const,
};

export function useSecretStoreSettings(workspaceId?: string) {
	return useQuery({
		queryKey: secretStoreSettingsKeys.get(workspaceId),
		queryFn: async () => {
			try {
				return await apiClient.get<SecretStoreSettings>(
					"/secret-store-settings",
					{ workspaceId },
				);
			} catch (error) {
				if (error instanceof ApiError && error.status === 404) return null;
				throw error;
			}
		},
		enabled: !!workspaceId,
	});
}

export function useUpdateSecretStoreSettings() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			workspaceId,
			allowPrivateNetwork,
		}: {
			workspaceId: string;
			allowPrivateNetwork: boolean;
		}) =>
			apiClient.put<SecretStoreSettings>(
				"/secret-store-settings",
				{ allowPrivateNetwork },
				{ workspaceId },
			),
		onSuccess: (settings) => {
			queryClient.invalidateQueries({ queryKey: secretStoreSettingsKeys.all });
			toast.success(
				settings.allowPrivateNetwork
					? "Secret stores may now be reached at private addresses."
					: "Secret stores must be reachable at public addresses.",
			);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to change the setting");
		},
	});
}

export interface PutExternalSecretInput {
	workspaceId: string;
	name: string;
	store: string;
	path: string;
	key?: string;
	version?: string;
	description?: string;
	allowedHosts?: string[] | null;
}

export function usePutExternalSecret() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			workspaceId,
			name,
			store,
			path,
			key,
			version,
			description,
			allowedHosts,
		}: PutExternalSecretInput) =>
			apiClient.put<Secret>(
				`/secrets/${name}`,
				{
					external: { store, path, key, version },
					description,
					...(allowedHosts !== undefined ? { allowedHosts } : {}),
				},
				{ workspaceId },
			),
		onSuccess: (secret) => {
			queryClient.invalidateQueries({ queryKey: secretKeys.all });
			if (secret.health?.status === "unreachable") {
				toast.warning(
					`Secret ${secret.name} saved, and ${secret.external?.store ?? "the store"} could not produce its value yet. Calls that use it will fail until it can.`,
				);
			} else {
				toast.success(
					`Secret ${secret.name} saved. Its value is read from ${secret.external?.store ?? "the store"} at each call.`,
				);
			}
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to save the secret");
		},
	});
}

export function useDeleteSecret() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			name,
			workspaceId,
			confirmProtected,
		}: {
			name: string;
			workspaceId: string;
			confirmProtected?: boolean;
		}) =>
			apiClient.delete<{ deleted: boolean }>(
				`/secrets/${name}${confirmProtected ? "?confirmProtected=true" : ""}`,
				{ workspaceId },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: secretKeys.all });
			toast.success("Secret deleted.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to delete secret");
		},
	});
}
