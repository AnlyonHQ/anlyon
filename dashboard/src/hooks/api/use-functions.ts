import { isFeatureEnabled } from "@anlyon/feature-flags";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { ApiError, apiClient } from "@/lib/api-client";
import { type PublishBody, runIsSettling } from "@/lib/functions";
import type {
	FunctionLanguage,
	FunctionRun,
	FunctionRunListItem,
	FunctionSourceFindings,
	FunctionVersion,
	FunctionVersionDetail,
	FunctionVersionListItem,
	HostedFunction,
} from "@/lib/types";

export const functionKeys = {
	all: ["functions"] as const,
	list: (workspaceId?: string) =>
		[...functionKeys.all, "list", workspaceId] as const,
	run: (workspaceId?: string, runId?: string) =>
		[...functionKeys.all, "run", workspaceId, runId] as const,
	versions: (workspaceId?: string, name?: string) =>
		[...functionKeys.all, "versions", workspaceId, name] as const,
	version: (
		workspaceId?: string,
		name?: string,
		version?: number | "current",
	) => [...functionKeys.all, "version", workspaceId, name, version] as const,
	runs: (workspaceId?: string, name?: string) =>
		[...functionKeys.all, "runs", workspaceId, name] as const,
};

const path = (name: string) => `/functions/${encodeURIComponent(name)}`;

export function useFunctionVersions(workspaceId?: string, name?: string) {
	return useQuery({
		queryKey: functionKeys.versions(workspaceId, name),
		queryFn: () =>
			apiClient.get<FunctionVersionListItem[]>(`${path(name ?? "")}/versions`, {
				workspaceId,
			}),
		enabled: !!workspaceId && !!name,
	});
}

export function useFunctionVersion(
	workspaceId: string | undefined,
	name: string | undefined,
	version: number | "current",
	enabled = true,
) {
	return useQuery({
		queryKey: functionKeys.version(workspaceId, name, version),
		queryFn: () =>
			apiClient.get<FunctionVersionDetail>(
				`${path(name ?? "")}/versions/${version}`,
				{ workspaceId },
			),
		enabled: enabled && !!workspaceId && !!name,
		staleTime: version === "current" ? 30_000 : Number.POSITIVE_INFINITY,
	});
}

export function useFunctionRuns(workspaceId?: string, name?: string) {
	return useQuery({
		queryKey: functionKeys.runs(workspaceId, name),
		queryFn: () =>
			apiClient.get<FunctionRunListItem[]>(`${path(name ?? "")}/runs`, {
				workspaceId,
			}),
		enabled: !!workspaceId && !!name,
		refetchInterval: (query) =>
			(query.state.data as FunctionRunListItem[] | undefined)?.some(
				(run) => run.status === "running" || run.status === "awaiting_approval",
			)
				? 10_000
				: false,
	});
}

export function useFunctions(workspaceId?: string) {
	return useQuery({
		queryKey: functionKeys.list(workspaceId),
		queryFn: () =>
			apiClient.get<HostedFunction[]>("/functions", { workspaceId }),
		enabled: !!workspaceId,
	});
}

export function useFunctionsAvailable(workspaceId?: string): boolean | null {
	const list = useQuery({
		queryKey: functionKeys.list(workspaceId),
		queryFn: () =>
			apiClient.get<HostedFunction[]>("/functions", { workspaceId }),
		enabled: !!workspaceId && isFeatureEnabled("functions"),
		retry: (count, error) =>
			!(error instanceof ApiError && error.status === 404) && count < 2,
	});
	if (!isFeatureEnabled("functions")) return false;
	if (list.isSuccess) return true;
	if (list.error instanceof ApiError && list.error.status === 404) return false;
	return null;
}

export function useCreateFunction(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { name: string; description?: string }) =>
			apiClient.post<HostedFunction>("/functions", input, { workspaceId }),
		onSuccess: (created) => {
			queryClient.invalidateQueries({ queryKey: functionKeys.all });
			toast.success(`Created "${created.name}". Publish a version to run it.`);
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useDeleteFunction(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (name: string) =>
			apiClient.delete<{ deleted: boolean; id: string; name: string }>(
				path(name),
				{ workspaceId },
			),
		onSuccess: (deleted) => {
			queryClient.invalidateQueries({ queryKey: functionKeys.all });
			toast.success(`Deleted "${deleted.name}".`);
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useAnalyzeFunctionSource(
	workspaceId?: string,
	options: { quiet?: boolean } = {},
) {
	return useMutation({
		mutationFn: (input: { language: FunctionLanguage; source: string }) =>
			apiClient.post<FunctionSourceFindings>("/functions/analysis", input, {
				workspaceId,
			}),
		onError: (error: Error) => {
			if (!options.quiet) toast.error(error.message);
		},
	});
}

export function usePublishFunctionVersion(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ name, body }: { name: string; body: PublishBody }) =>
			apiClient.post<{ function: HostedFunction; version: FunctionVersion }>(
				`/functions/${encodeURIComponent(name)}/versions`,
				body,
				{ workspaceId },
			),
		onSuccess: (res) => {
			queryClient.invalidateQueries({ queryKey: functionKeys.all });
			toast.success(
				`Published v${res.version.version} of "${res.function.name}".`,
			);
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useFunctionRun(workspaceId?: string, runId?: string) {
	return useQuery({
		queryKey: functionKeys.run(workspaceId, runId),
		queryFn: () =>
			apiClient.get<FunctionRun>(
				`/function-runs/${encodeURIComponent(runId ?? "")}`,
				{ workspaceId },
			),
		enabled: !!workspaceId && !!runId,
		refetchInterval: (query) =>
			runIsSettling(query.state.data as FunctionRun | undefined)
				? 5_000
				: false,
	});
}

export type StartFunctionRunInput =
	| { name: string; mode: "plan"; input: Record<string, unknown> }
	| { name: string; mode: "apply"; planRunId: string };

export function useStartFunctionRun(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (request: StartFunctionRunInput) =>
			apiClient.post<FunctionRun>(
				`/functions/${encodeURIComponent(request.name)}/runs`,
				request.mode === "plan"
					? { mode: "plan", input: request.input }
					: { mode: "apply", planRunId: request.planRunId },
				{ workspaceId },
			),
		onSuccess: (run, request) => {
			queryClient.setQueryData(functionKeys.run(workspaceId, run.id), run);
			if (request.mode === "apply") {
				queryClient.invalidateQueries({
					queryKey: functionKeys.run(workspaceId, request.planRunId),
				});
			}
			queryClient.invalidateQueries({ queryKey: ["approvals"] });
			queryClient.invalidateQueries({
				queryKey: functionKeys.runs(workspaceId, request.name),
			});
		},
		onError: (error: Error) => toast.error(error.message),
	});
}
