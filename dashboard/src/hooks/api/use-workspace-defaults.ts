import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type {
	Environment,
	NotificationPreferences,
	UpdateNotificationPreferencesRequest,
	UpdateWorkspaceDefaultsRequest,
	WorkspaceDefaults,
	WorkspaceDefaultsSource,
} from "@/lib/types";
import { environmentKeys } from "./use-environments";
import { notificationKeys } from "./use-notifications";

export const workspaceDefaultsKeys = {
	all: ["workspace-defaults"] as const,
	detail: (workspaceId: string) =>
		[...workspaceDefaultsKeys.all, workspaceId] as const,
};

export function useWorkspaceDefaults(workspaceId?: string) {
	return useQuery({
		queryKey: workspaceDefaultsKeys.detail(workspaceId ?? ""),
		queryFn: () =>
			apiClient.get<WorkspaceDefaults>(`/workspaces/${workspaceId}/defaults`),
		enabled: !!workspaceId,
	});
}

export interface SaveDefaultsInput {
	defaults?: UpdateWorkspaceDefaultsRequest;
	preferences?: UpdateNotificationPreferencesRequest;
	redirect?: {
		environmentId: string;
		defaultRedirectUrl: string | null;
		allowedRedirectUrls?: string[];
	};
}

export function useSaveWorkspaceDefaults(
	workspaceId: string | undefined,
	{
		source,
		successMessage = "Defaults saved.",
	}: { source: WorkspaceDefaultsSource; successMessage?: string | null },
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (input: SaveDefaultsInput) => {
			if (!workspaceId) throw new Error("No workspace selected.");
			if (input.redirect) {
				const { environmentId, ...settings } = input.redirect;
				await apiClient.patch<Environment>(
					`/workspaces/${workspaceId}/environments/${environmentId}`,
					settings,
				);
			}
			if (input.preferences && Object.keys(input.preferences).length > 0) {
				await apiClient.patch<NotificationPreferences>(
					"/notifications/preferences",
					input.preferences,
					{ workspaceId },
				);
			}
			if (input.defaults && Object.keys(input.defaults).length > 0) {
				return apiClient.patch<WorkspaceDefaults>(
					`/workspaces/${workspaceId}/defaults`,
					{ ...input.defaults, source },
				);
			}
			return null;
		},
		onSuccess: (saved, input) => {
			if (!workspaceId) return;
			if (saved)
				queryClient.setQueryData(
					workspaceDefaultsKeys.detail(workspaceId),
					saved,
				);
			if (input.preferences)
				queryClient.invalidateQueries({
					queryKey: notificationKeys.preferences(workspaceId),
				});
			if (input.redirect)
				queryClient.invalidateQueries({ queryKey: environmentKeys.all });
			if (successMessage) toast.success(successMessage);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Your defaults could not be saved.");
		},
	});
}
