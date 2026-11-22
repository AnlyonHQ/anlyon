import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	actionKeys,
	secretKeys,
	useActions,
	useSecrets,
} from "@/hooks/api/use-actions";
import { approvalKeys } from "@/hooks/api/use-approvals";
import { apiClient } from "@/lib/api-client";
import {
	DEMO_ACTION,
	DEMO_INPUT,
	DEMO_SECRET,
	demoAction,
	demoToken,
	firstRunState,
	sandboxHost,
} from "@/lib/first-run";
import type {
	Action,
	ApprovalDecision,
	Invocation,
	PaginatedResponse,
	Secret,
} from "@/lib/types";

export function useFirstRun(workspaceId?: string) {
	const secrets = useSecrets(workspaceId);
	const actions = useActions(workspaceId);
	const hasDemoAction = (actions.data ?? []).some(
		(a) => a.name === DEMO_ACTION,
	);
	const invocations = useQuery({
		queryKey: actionKeys.invocations(workspaceId, DEMO_ACTION, 0),
		queryFn: () =>
			apiClient.get<PaginatedResponse<Invocation>>("/actions/invocations", {
				workspaceId,
				params: { action: DEMO_ACTION, limit: 5 },
			}),
		enabled: !!workspaceId && hasDemoAction,
		retry: false,
	});

	const loading =
		secrets.isLoading ||
		actions.isLoading ||
		(hasDemoAction && invocations.isLoading);
	const state = firstRunState({
		secrets: secrets.data,
		actions: actions.data,
		invocations: invocations.data?.data,
	});

	return {
		...state,
		loading,
		error: secrets.error ?? actions.error ?? invocations.error,
	};
}

export function useSandboxToken(workspaceId?: string): {
	token: string | null;
} {
	const [fallback] = useState(() => demoToken());
	const minted = useQuery({
		queryKey: ["first-run", "sandbox-token", workspaceId],
		queryFn: () =>
			apiClient.post<{ token: string }>("/sandbox/token", undefined, {
				workspaceId,
			}),
		enabled: !!workspaceId,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	if (minted.data?.token) return { token: minted.data.token };
	return { token: minted.isError || !workspaceId ? fallback : null };
}

export function useFirstRunMutations(workspaceId?: string) {
	const queryClient = useQueryClient();
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: secretKeys.all }),
			queryClient.invalidateQueries({ queryKey: actionKeys.all }),
			queryClient.invalidateQueries({ queryKey: approvalKeys.all }),
		]);
	const ws = () => {
		if (!workspaceId) throw new Error("Choose a workspace first.");
		return workspaceId;
	};

	const storeSecret = useMutation({
		mutationFn: (value: string) =>
			apiClient.put<Secret>(
				`/secrets/${DEMO_SECRET}`,
				{
					value,
					description:
						"First-run tour token. It can only be sent to Anlyon's sandbox.",
					allowedHosts: [sandboxHost()],
					allowedPlacements: ["header"],
				},
				{ workspaceId: ws() },
			),
		onSuccess: refresh,
	});

	const defineAction = useMutation({
		mutationFn: () =>
			apiClient.post<Action>("/actions", demoAction(), { workspaceId: ws() }),
		onSuccess: refresh,
	});

	const callAsAgent = useMutation({
		mutationFn: () =>
			apiClient.post<Invocation & { pendingApproval: boolean }>(
				`/actions/${DEMO_ACTION}/invoke`,
				{ input: DEMO_INPUT },
				{ workspaceId: ws() },
			),
		onSuccess: refresh,
	});

	const decide = useMutation({
		mutationFn: ({
			approvalId,
			decision,
		}: {
			approvalId: string;
			decision: "approve" | "deny";
		}) =>
			apiClient.post<ApprovalDecision>(
				`/approvals/${approvalId}/${decision}`,
				{ note: "First-run tour" },
				{ workspaceId: ws() },
			),
		onSuccess: refresh,
	});

	const reset = useMutation({
		mutationFn: async () => {
			const workspace = ws();
			await apiClient
				.delete(`/actions/${DEMO_ACTION}`, { workspaceId: workspace })
				.catch(() => undefined);
			await apiClient
				.delete(`/secrets/${DEMO_SECRET}`, { workspaceId: workspace })
				.catch(() => undefined);
		},
		onSuccess: refresh,
	});

	return { storeSecret, defineAction, callAsAgent, decide, reset };
}
