import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";

export interface SlackApprovalsSettings {
	ready: boolean;
	requestUrl: string | null;
	installs: {
		integrationId: string;
		teamId: string | null;
		teamName: string | null;
		isActive: boolean;
	}[];
	routes: SlackApprovalRoute[];
	links: { slackTeamId: string; slackUserId: string; createdAt: string }[];
}

export interface SlackApprovalRoute {
	environmentId: string;
	integrationId: string;
	channelId: string;
	channelName: string;
	updatedAt: string;
}

export const slackApprovalKeys = {
	all: ["slack-approvals"] as const,
	settings: (workspaceId: string) =>
		[...slackApprovalKeys.all, workspaceId] as const,
};

export function useSlackApprovals(workspaceId?: string) {
	return useQuery({
		queryKey: slackApprovalKeys.settings(workspaceId ?? ""),
		queryFn: () =>
			apiClient.get<SlackApprovalsSettings>("/slack-approvals", {
				workspaceId,
			}),
		enabled: !!workspaceId,
	});
}

export function useSetSlackApprovalRoute(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			environmentId,
			...body
		}: {
			environmentId: string;
			integrationId: string;
			channelId: string;
			channelName: string;
		}) =>
			apiClient.put<{
				route: SlackApprovalRoute;
				autoJoined: boolean;
				isPrivate: boolean;
			}>(`/slack-approvals/routes/${environmentId}`, body, { workspaceId }),
		onSuccess: (result) => {
			queryClient.invalidateQueries({ queryKey: slackApprovalKeys.all });
			if (result.isPrivate && !result.autoJoined) {
				toast.warning(
					`Saved. #${result.route.channelName} is private: invite the bot there with /invite @Anlyon.`,
					{ duration: 10000 },
				);
			} else {
				toast.success(
					`Approval requests will be posted to #${result.route.channelName}.`,
				);
			}
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useRemoveSlackApprovalRoute(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (environmentId: string) =>
			apiClient.delete<{ removed: number }>(
				`/slack-approvals/routes/${environmentId}`,
				{ workspaceId },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: slackApprovalKeys.all });
			toast.success(
				"Approval requests in this environment are no longer posted to Slack.",
			);
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useStartSlackLink(workspaceId?: string) {
	return useMutation({
		mutationFn: () =>
			apiClient.post<{ authUrl: string }>(
				"/slack-approvals/identity/start",
				undefined,
				{ workspaceId },
			),
		onSuccess: (data) => {
			window.location.href = data.authUrl;
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useUnlinkSlack(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () =>
			apiClient.delete<{ removed: number }>("/slack-approvals/identity", {
				workspaceId,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: slackApprovalKeys.all });
			toast.success("Your Slack account is unlinked.");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}
