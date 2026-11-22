import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type {
	AuditDeadLetter,
	AuditEvent,
	AuditSendResult,
	AuditSettings,
	AuditSink,
	sinkRequest,
} from "@/lib/audit";

export const auditKeys = {
	all: ["audit"] as const,
	settings: (workspaceId?: string) =>
		[...auditKeys.all, "settings", workspaceId] as const,
	sinks: (workspaceId?: string) =>
		[...auditKeys.all, "sinks", workspaceId] as const,
	deadLetters: (workspaceId?: string, sinkId?: string) =>
		[...auditKeys.all, "dead-letters", workspaceId, sinkId] as const,
	events: (workspaceId?: string) =>
		[...auditKeys.all, "events", workspaceId] as const,
};

const base = (workspaceId?: string) => `/workspaces/${workspaceId}/audit`;

export function useAuditSettings(workspaceId?: string) {
	return useQuery({
		queryKey: auditKeys.settings(workspaceId),
		queryFn: () =>
			apiClient.get<AuditSettings>(`${base(workspaceId)}/settings`),
		enabled: !!workspaceId,
		retry: false,
	});
}

export function useUpdateAuditSettings(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (patch: {
			retentionDays?: number | null;
			allowPrivateDestinations?: boolean;
		}) => apiClient.put<AuditSettings>(`${base(workspaceId)}/settings`, patch),
		onSuccess: (settings) => {
			queryClient.setQueryData(auditKeys.settings(workspaceId), settings);
			toast.success("Audit settings saved");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useAuditSinks(workspaceId?: string, enabled = true) {
	return useQuery({
		queryKey: auditKeys.sinks(workspaceId),
		queryFn: () => apiClient.get<AuditSink[]>(`${base(workspaceId)}/sinks`),
		enabled: !!workspaceId && enabled,
		retry: false,
		refetchInterval: 15_000,
	});
}

export function useCreateAuditSink(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: ReturnType<typeof sinkRequest>) =>
			apiClient.post<AuditSink>(`${base(workspaceId)}/sinks`, body),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: auditKeys.sinks(workspaceId) });
			toast.success("Sink added");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useUpdateAuditSink(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			sinkId,
			patch,
		}: {
			sinkId: string;
			patch: Record<string, unknown>;
		}) =>
			apiClient.patch<AuditSink>(`${base(workspaceId)}/sinks/${sinkId}`, patch),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: auditKeys.sinks(workspaceId) }),
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useDeleteAuditSink(workspaceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (sinkId: string) =>
			apiClient.delete<{ deleted: true }>(
				`${base(workspaceId)}/sinks/${sinkId}`,
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: auditKeys.sinks(workspaceId) });
			toast.success("Sink deleted");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useTestAuditSink(workspaceId?: string) {
	return useMutation({
		mutationFn: (sinkId: string) =>
			apiClient.post<AuditSendResult>(
				`${base(workspaceId)}/sinks/${sinkId}/test`,
				{},
			),
		onSuccess: (result) => {
			if (result.ok)
				toast.success(`Test event accepted (HTTP ${result.status ?? "OK"})`);
			else toast.error(`Test event refused: ${result.error ?? "no response"}`);
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useAuditDeadLetters(workspaceId?: string, sinkId?: string) {
	return useQuery({
		queryKey: auditKeys.deadLetters(workspaceId, sinkId),
		queryFn: () =>
			apiClient.get<AuditDeadLetter[]>(
				`${base(workspaceId)}/sinks/${sinkId}/dead-letters`,
			),
		enabled: !!workspaceId && !!sinkId,
	});
}

export function useRedeliverDeadLetter(workspaceId?: string, sinkId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (deadLetterId: string) =>
			apiClient.post<{ deadLetter: AuditDeadLetter; result: AuditSendResult }>(
				`${base(workspaceId)}/sinks/${sinkId}/dead-letters/${deadLetterId}/redeliver`,
				{},
			),
		onSuccess: ({ result }) => {
			queryClient.invalidateQueries({ queryKey: auditKeys.all });
			if (result.ok) toast.success("Redelivered");
			else toast.error(`Still refused: ${result.error ?? "no response"}`);
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useRecentAuditEvents(workspaceId?: string, enabled = true) {
	return useQuery({
		queryKey: auditKeys.events(workspaceId),
		queryFn: () =>
			apiClient.get<{ data: AuditEvent[] }>(`${base(workspaceId)}/events`, {
				params: { limit: 20 },
			}),
		enabled: !!workspaceId && enabled,
		retry: false,
	});
}
