import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { ApiError, apiClient } from "@/lib/api-client";
import {
	SIGN_OFF_STATUS_LABEL,
	type SignOffRequest,
	type SignOffStatus,
} from "@/lib/sign-offs";

export const signOffKeys = {
	all: ["sign-offs"] as const,
	list: (workspaceId?: string, status?: SignOffStatus) =>
		[...signOffKeys.all, "list", workspaceId, status ?? "all"] as const,
	lookup: (signOffId?: string, workspaceIds?: readonly string[]) =>
		[...signOffKeys.all, "lookup", signOffId, workspaceIds] as const,
};

const base = (workspaceId: string) => `/workspaces/${workspaceId}/sign-offs`;

export function useSignOffs(
	workspaceId?: string,
	status?: SignOffStatus,
	options: { enabled?: boolean } = {},
) {
	return useQuery({
		queryKey: signOffKeys.list(workspaceId, status),
		queryFn: () =>
			apiClient.get<SignOffRequest[]>(base(workspaceId as string), {
				params: { status },
			}),
		enabled: !!workspaceId && options.enabled !== false,
		refetchInterval: 30_000,
		retry: false,
	});
}

export interface SignOffLookup {
	workspaceId: string;
	signOff: SignOffRequest;
}

export async function findSignOff(
	signOffId: string,
	workspaceIds: readonly string[],
): Promise<SignOffLookup | null> {
	let currentError: unknown = null;
	for (const [index, workspaceId] of workspaceIds.entries()) {
		try {
			const signOff = await apiClient.get<SignOffRequest>(
				`${base(workspaceId)}/${encodeURIComponent(signOffId)}`,
			);
			return { workspaceId, signOff };
		} catch (error) {
			if (index === 0 && !(error instanceof ApiError && error.status === 404))
				currentError = error;
		}
	}
	if (currentError) throw currentError;
	return null;
}

export function useSignOffLookup(
	signOffId: string | undefined,
	workspaceIds: readonly string[],
) {
	return useQuery({
		queryKey: signOffKeys.lookup(signOffId, workspaceIds),
		queryFn: () => findSignOff(signOffId as string, workspaceIds),
		enabled: !!signOffId && workspaceIds.length > 0,
		retry: false,
		refetchInterval: (query) =>
			query.state.data?.signOff.status === "pending" ? 15_000 : false,
	});
}

export type SignOffDecision = "approve" | "reject";

export function useDecideSignOff() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			workspaceId,
			signOffId,
			decision,
			note,
		}: {
			workspaceId: string;
			signOffId: string;
			decision: SignOffDecision;
			note?: string;
		}) =>
			apiClient.post<SignOffRequest>(
				`${base(workspaceId)}/${encodeURIComponent(signOffId)}/${decision}`,
				note ? { note } : {},
			),
		onSuccess: (signOff) => {
			queryClient.setQueriesData<SignOffLookup | null>(
				{ queryKey: [...signOffKeys.all, "lookup", signOff.id] },
				(previous) => (previous ? { ...previous, signOff } : previous),
			);
			queryClient.invalidateQueries({
				queryKey: [...signOffKeys.all, "list"],
			});
			if (signOff.status === "applied") toast.success("Applied.");
			else if (signOff.status === "rejected")
				toast.success("Rejected. Nothing changed.");
			else if (signOff.status === "failed")
				toast.error("Approved, but the change could not be applied.");
			else toast.success(SIGN_OFF_STATUS_LABEL[signOff.status]);
		},
		onError: (error: Error) => {
			if (error instanceof ApiError && error.status === 409) {
				queryClient.invalidateQueries({ queryKey: signOffKeys.all });
				toast.error("This request was already decided or has expired.");
			}
		},
	});
}
