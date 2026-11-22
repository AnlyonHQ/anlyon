import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type {
	CreateDiscordIntegrationRequest,
	IntegrationConnection,
	IntegrationEventType,
	SlackChannel,
	SlackOAuthStartResponse,
	TestIntegrationResponse,
	UpdateSlackChannelResponse,
} from "@/lib/types";

export const integrationKeys = {
	all: ["integrations"] as const,
	lists: () => [...integrationKeys.all, "list"] as const,
	list: (workspaceId: string) =>
		[...integrationKeys.lists(), workspaceId] as const,
	details: () => [...integrationKeys.all, "detail"] as const,
	detail: (workspaceId: string, id: string) =>
		[...integrationKeys.details(), workspaceId, id] as const,
	slackChannels: (workspaceId: string, integrationId: string) =>
		[
			...integrationKeys.all,
			"slackChannels",
			workspaceId,
			integrationId,
		] as const,
};

export function useIntegrations(workspaceId?: string) {
	return useQuery({
		queryKey: integrationKeys.list(workspaceId || ""),
		queryFn: () =>
			apiClient.get<IntegrationConnection[]>(
				"/integrations",
				workspaceId ? { workspaceId } : {},
			),
		enabled: !!workspaceId,
	});
}

export function useStartSlackOAuth() {
	return useMutation({
		mutationFn: (workspaceId: string) =>
			apiClient.post<SlackOAuthStartResponse>(
				`/integrations/slack/oauth/start`,
				{
					workspaceId,
				},
			),
		onSuccess: (data) => {
			window.location.href = data.authUrl;
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to start Slack authorization");
		},
	});
}

export function useCreateDiscordIntegration() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			data,
		}: {
			workspaceId: string;
			data: CreateDiscordIntegrationRequest;
		}) => {
			if (!workspaceId) throw new Error("Workspace ID is required");
			return apiClient.post<IntegrationConnection>(
				"/integrations/discord",
				data,
				{ workspaceId },
			);
		},
		onSuccess: (_, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: integrationKeys.list(workspaceId),
			});
			toast.success("Discord integration created successfully");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to create Discord integration");
		},
	});
}

export function useUpdateIntegrationEvents() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			integrationId,
			enabledEventTypes,
			workspaceId,
		}: {
			workspaceId: string;
			integrationId: string;
			enabledEventTypes: IntegrationEventType[];
		}) => {
			if (!workspaceId) throw new Error("Workspace ID is required");
			return apiClient.patch<IntegrationConnection>(
				`/integrations/${integrationId}/events`,
				{ enabledEventTypes },
				{ workspaceId },
			);
		},
		onSuccess: (_, { workspaceId, integrationId }) => {
			queryClient.invalidateQueries({
				queryKey: integrationKeys.list(workspaceId),
			});
			queryClient.invalidateQueries({
				queryKey: integrationKeys.detail(workspaceId, integrationId),
			});
			toast.success("Event types updated successfully");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to update event types");
		},
	});
}

export function useUpdateSlackChannel() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			integrationId,
			channelId,
			channelName,
			workspaceId,
		}: {
			workspaceId: string;
			integrationId: string;
			channelId: string;
			channelName: string;
		}) => {
			if (!workspaceId) throw new Error("Workspace ID is required");
			return apiClient.patch<UpdateSlackChannelResponse>(
				`/integrations/slack/${integrationId}/channel`,
				{ channelId, channelName },
				{ workspaceId },
			);
		},
		onSuccess: (response, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: integrationKeys.list(workspaceId),
			});

			if (response.autoJoined) {
				toast.success(
					"Channel selected! Bot automatically joined. You can test now.",
					{
						duration: 5000,
					},
				);
			} else if (response.isPrivate) {
				toast.warning(
					`Channel selected! Please invite the bot: Go to #${response.channelName} in Slack and type /invite @Anlyon`,
					{ duration: 10000 },
				);
			} else if (response.joinError) {
				toast.warning(
					`Channel selected, but couldn't auto-join. Please invite the bot in Slack.`,
					{ duration: 8000 },
				);
			} else {
				toast.success("Slack channel updated successfully");
			}
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to update Slack channel");
		},
	});
}

export function useDeleteIntegration() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			integrationId,
			workspaceId,
		}: {
			workspaceId: string;
			integrationId: string;
		}) => {
			if (!workspaceId) throw new Error("Workspace ID is required");
			return apiClient.delete<void>(`/integrations/${integrationId}`, {
				workspaceId,
			});
		},
		onSuccess: (_, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: integrationKeys.list(workspaceId),
			});
			toast.success("Integration deleted successfully");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to delete integration");
		},
	});
}

export function useTestIntegration() {
	return useMutation({
		mutationFn: ({
			integrationId,
			type,
			workspaceId,
		}: {
			integrationId: string;
			type: "slack" | "discord";
			workspaceId: string;
		}) => {
			if (!workspaceId) throw new Error("Workspace ID is required");
			return apiClient.post<TestIntegrationResponse>(
				`/integrations/${type}/${integrationId}/test`,
				{},
				{ workspaceId },
			);
		},
		onSuccess: () => {
			toast.success(
				"Test notification sent successfully! Check your channel.",
				{
					duration: 5000,
				},
			);
		},
		onError: (error: Error) => {
			const message = error.message || "Failed to test integration";
			toast.error(message, {
				duration: 10000,
			});
		},
	});
}

export function useSlackChannels(workspaceId: string, integrationId: string) {
	return useQuery({
		queryKey: integrationKeys.slackChannels(workspaceId, integrationId),
		queryFn: () =>
			apiClient.get<SlackChannel[]>(
				`/integrations/slack/${integrationId}/channels`,
				workspaceId ? { workspaceId } : {},
			),
		enabled: !!workspaceId && !!integrationId,
	});
}

export function useToggleIntegration() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			integrationId,
			isActive,
			workspaceId,
		}: {
			workspaceId: string;
			integrationId: string;
			isActive: boolean;
		}) => {
			if (!workspaceId) throw new Error("Workspace ID is required");
			return apiClient.patch<IntegrationConnection>(
				`/integrations/${integrationId}/toggle`,
				{ isActive },
				{ workspaceId },
			);
		},
		onSuccess: (_, { workspaceId, isActive }) => {
			queryClient.invalidateQueries({
				queryKey: integrationKeys.list(workspaceId),
			});
			toast.success(isActive ? "Integration enabled" : "Integration disabled");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to update integration");
		},
	});
}
