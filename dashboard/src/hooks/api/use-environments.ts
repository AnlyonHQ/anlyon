import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type { Environment } from "@/lib/types";

export const environmentKeys = {
	all: ["environments"] as const,
	list: (workspaceId?: string) =>
		[...environmentKeys.all, workspaceId] as const,
};

export function useEnvironments(workspaceId?: string) {
	return useQuery({
		queryKey: environmentKeys.list(workspaceId),
		queryFn: () =>
			apiClient.get<Environment[]>(`/workspaces/${workspaceId}/environments`),
		enabled: !!workspaceId,
	});
}

export function useCreateEnvironment(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			name: string;
			slug: string;
			isProtected?: boolean;
			kind?: Environment["kind"];
		}) =>
			apiClient.post<Environment>(
				`/workspaces/${workspaceId}/environments`,
				input,
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: environmentKeys.all });
			toast.success("Environment created");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useUpdateEnvironment(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			environmentId,
			...input
		}: {
			environmentId: string;
			name?: string;
			isProtected?: boolean;
			confirmProtected?: boolean;
			kind?: Environment["kind"];
			isDefault?: true;
		}) =>
			apiClient.patch<Environment>(
				`/workspaces/${workspaceId}/environments/${environmentId}`,
				input,
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: environmentKeys.all });
			toast.success("Environment updated");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useDeleteEnvironment(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			environmentId,
			confirmSlug,
		}: {
			environmentId: string;
			confirmSlug: string;
		}) =>
			apiClient.delete<{ deleted: boolean }>(
				`/workspaces/${workspaceId}/environments/${environmentId}`,
				{
					body: JSON.stringify({ confirmSlug }),
				},
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: environmentKeys.all });
			toast.success("Empty environment deleted");
		},
	});
}

export function useHaltEnvironment(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			environmentId,
			reason,
		}: {
			environmentId: string;
			reason?: string;
		}) =>
			apiClient.post<Environment>(
				`/workspaces/${workspaceId}/environments/${environmentId}/halt`,
				reason ? { reason } : {},
			),
		onSuccess: (res) => {
			queryClient.invalidateQueries({ queryKey: environmentKeys.all });
			toast.warning(
				`Environment "${res.name}" halted  side effects are paused`,
			);
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useResumeEnvironment(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ environmentId }: { environmentId: string }) =>
			apiClient.post<Environment>(
				`/workspaces/${workspaceId}/environments/${environmentId}/resume`,
				{},
			),
		onSuccess: (res) => {
			queryClient.invalidateQueries({ queryKey: environmentKeys.all });
			toast.success(`Environment "${res.name}" resumed`);
		},
		onError: (error: Error) => toast.error(error.message),
	});
}
