import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type { Agent, AgentVersion } from "@/lib/types";

export const agentKeys = {
	all: ["agents"] as const,
	list: (workspaceId?: string, environmentId?: string) =>
		[...agentKeys.all, workspaceId, environmentId] as const,
	versions: (workspaceId?: string, agentId?: string) =>
		[...agentKeys.all, "versions", workspaceId, agentId] as const,
};

export function useAgents(workspaceId?: string, environmentId?: string) {
	return useQuery({
		queryKey: agentKeys.list(workspaceId, environmentId),
		queryFn: () =>
			apiClient.get<Agent[]>(`/workspaces/${workspaceId}/agents`, {
				params: environmentId ? { environmentId } : undefined,
			}),
		enabled: !!workspaceId,
	});
}

export function useAgentVersions(workspaceId?: string, agentId?: string) {
	return useQuery({
		queryKey: agentKeys.versions(workspaceId, agentId),
		queryFn: () =>
			apiClient.get<AgentVersion[]>(
				`/workspaces/${workspaceId}/agents/${agentId}/versions`,
			),
		enabled: !!workspaceId && !!agentId,
	});
}

export function usePromoteAgent(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			agentId: string;
			targetEnvironmentId: string;
			confirmProtected?: boolean;
		}) =>
			apiClient.post<{ agent: Agent; version: AgentVersion }>(
				`/workspaces/${workspaceId}/agents/${input.agentId}/promote`,
				{
					targetEnvironmentId: input.targetEnvironmentId,
					...(input.confirmProtected ? { confirmProtected: true } : {}),
				},
			),
		onSuccess: (res) => {
			queryClient.invalidateQueries({ queryKey: agentKeys.all });
			toast.success(
				`Promoted "${res.agent.name}"  v${res.version.version} is now published`,
			);
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useCreateAgent(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			name: string;
			description?: string;
			environmentId: string;
			config?: Record<string, unknown>;
		}) =>
			apiClient.post<{ agent: Agent; version: AgentVersion }>(
				`/workspaces/${workspaceId}/agents`,
				input,
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: agentKeys.all });
			toast.success("Agent created");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}
