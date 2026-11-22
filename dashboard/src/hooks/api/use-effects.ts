import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type {
	ActionPreview,
	Effect,
	EffectDetail,
	EffectGrade,
	EffectOutcome,
	ImpactLimit,
	ImpactLimitSubject,
	ImpactQuantity,
	PaginatedResponse,
	PartialEffect,
} from "@/lib/types";
import { actionKeys } from "./use-actions";

export const EFFECTS_PAGE_SIZE = 25;

export function withEnvironment(path: string, environmentId?: string): string {
	return environmentId
		? `${path}?environmentId=${encodeURIComponent(environmentId)}`
		: path;
}

export interface EffectFilters {
	action?: string;
	outcome?: EffectOutcome;
	grade?: EffectGrade;
	unresolved?: boolean;
	offset?: number;
	endUserId?: string;
	actingFor?: "workspace" | "end_users";
}

export function effectListParams(
	environmentId: string | undefined,
	filters: EffectFilters = {},
) {
	return {
		environmentId,
		action: filters.action || undefined,
		outcome: filters.outcome,
		grade: filters.grade,
		unresolved: filters.unresolved ? "true" : undefined,
		endUserId: filters.endUserId || undefined,
		actingFor: filters.actingFor,
		limit: EFFECTS_PAGE_SIZE,
		offset: filters.offset ?? 0,
	};
}

export const effectKeys = {
	scope: (workspaceId?: string, environmentId?: string) =>
		["effects", workspaceId, environmentId ?? "default"] as const,
	list: (
		workspaceId?: string,
		environmentId?: string,
		filters: EffectFilters = {},
	) =>
		[
			...effectKeys.scope(workspaceId, environmentId),
			"list",
			filters.action ?? null,
			filters.outcome ?? null,
			filters.grade ?? null,
			filters.unresolved ?? null,
			filters.offset ?? 0,
			filters.endUserId ?? null,
			filters.actingFor ?? null,
		] as const,
	detail: (workspaceId?: string, environmentId?: string, effectId?: string) =>
		[
			...effectKeys.scope(workspaceId, environmentId),
			"detail",
			effectId,
		] as const,
	preview: (workspaceId?: string, environmentId?: string, previewId?: string) =>
		[
			...effectKeys.scope(workspaceId, environmentId),
			"preview",
			previewId,
		] as const,
};

export const impactLimitKeys = {
	scope: (workspaceId?: string, environmentId?: string) =>
		["impact-limits", workspaceId, environmentId ?? "default"] as const,
	list: (
		workspaceId?: string,
		environmentId?: string,
		includeArchived = false,
	) =>
		[
			...impactLimitKeys.scope(workspaceId, environmentId),
			"list",
			includeArchived,
		] as const,
};

export function useEffects(
	workspaceId?: string,
	environmentId?: string,
	filters: EffectFilters = {},
) {
	return useQuery({
		queryKey: effectKeys.list(workspaceId, environmentId, filters),
		queryFn: () =>
			apiClient.get<PaginatedResponse<Effect>>("/actions/effects", {
				workspaceId,
				params: effectListParams(environmentId, filters),
			}),
		enabled: !!workspaceId,
		refetchInterval: filters.unresolved ? 15_000 : false,
		placeholderData: (previous) => previous,
	});
}

export function useEffectDetail(
	workspaceId?: string,
	environmentId?: string,
	effectId?: string,
) {
	return useQuery({
		queryKey: effectKeys.detail(workspaceId, environmentId, effectId),
		queryFn: () =>
			apiClient.get<EffectDetail>(`/actions/effects/${effectId}`, {
				workspaceId,
				params: { environmentId },
			}),
		enabled: !!workspaceId && !!effectId,
	});
}

export function usePreview(
	workspaceId?: string,
	environmentId?: string,
	previewId?: string,
) {
	return useQuery({
		queryKey: effectKeys.preview(workspaceId, environmentId, previewId),
		queryFn: () =>
			apiClient.get<ActionPreview>(`/actions/previews/${previewId}`, {
				workspaceId,
				params: { environmentId },
			}),
		enabled: !!workspaceId && !!previewId,
		staleTime: 60_000,
	});
}

function useEffectMutation<TInput>(
	workspaceId: string | undefined,
	environmentId: string | undefined,
	effectId: string,
	request: (input: TInput) => Promise<EffectDetail>,
	success: string,
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: request,
		onSuccess: (effect) => {
			queryClient.setQueryData(
				effectKeys.detail(workspaceId, environmentId, effectId),
				effect,
			);
			queryClient.invalidateQueries({
				queryKey: [...effectKeys.scope(workspaceId, environmentId), "list"],
			});
			queryClient.invalidateQueries({
				queryKey: impactLimitKeys.scope(workspaceId, environmentId),
			});
			queryClient.invalidateQueries({ queryKey: actionKeys.all });
			toast.success(success);
		},
	});
}

export function useReconcileEffect(
	workspaceId: string | undefined,
	environmentId: string | undefined,
	effectId: string,
) {
	return useEffectMutation<void>(
		workspaceId,
		environmentId,
		effectId,
		() =>
			apiClient.post<EffectDetail>(
				withEnvironment(
					`/actions/effects/${effectId}/reconcile`,
					environmentId,
				),
				undefined,
				{
					workspaceId,
				},
			),
		"Asked the provider. The evidence below is current.",
	);
}

export function useAddEffectNote(
	workspaceId: string | undefined,
	environmentId: string | undefined,
	effectId: string,
) {
	return useEffectMutation<string>(
		workspaceId,
		environmentId,
		effectId,
		(note) =>
			apiClient.post<EffectDetail>(
				withEnvironment(`/actions/effects/${effectId}/notes`, environmentId),
				{ note },
				{
					workspaceId,
				},
			),
		"Note added to the evidence.",
	);
}

export interface ResolveEffectInput {
	outcome: "succeeded" | "failed";
	partialEffect?: PartialEffect;
	actualImpact?: ImpactQuantity[];
	reason: string;
	externalReference?: string;
}

export function useResolveEffect(
	workspaceId: string | undefined,
	environmentId: string | undefined,
	effectId: string,
) {
	return useEffectMutation<ResolveEffectInput>(
		workspaceId,
		environmentId,
		effectId,
		(input) =>
			apiClient.post<EffectDetail>(
				withEnvironment(`/actions/effects/${effectId}/resolve`, environmentId),
				input,
				{
					workspaceId,
				},
			),
		"Manual resolution recorded.",
	);
}

export function useReplayEffect(
	workspaceId: string | undefined,
	environmentId: string | undefined,
	effectId: string,
) {
	return useEffectMutation<void>(
		workspaceId,
		environmentId,
		effectId,
		() =>
			apiClient.post<EffectDetail>(
				withEnvironment(`/actions/effects/${effectId}/replay`, environmentId),
				undefined,
				{
					workspaceId,
				},
			),
		"Replayed under the same provider identity.",
	);
}

export function useImpactLimits(
	workspaceId?: string,
	environmentId?: string,
	includeArchived = false,
) {
	return useQuery({
		queryKey: impactLimitKeys.list(workspaceId, environmentId, includeArchived),
		queryFn: () =>
			apiClient.get<ImpactLimit[]>("/impact-limits", {
				workspaceId,
				params: {
					environmentId,
					includeArchived: includeArchived ? "true" : undefined,
				},
			}),
		enabled: !!workspaceId,
	});
}

export interface CreateImpactLimitInput {
	name: string;
	dimension: string;
	currency?: string;
	actionName?: string | null;
	resourcePrefix?: string | null;
	period: "day" | "month" | "total";
	amount: number;
	scope?: ImpactLimitSubject;
}

function useLimitMutation<TInput>(
	workspaceId: string | undefined,
	environmentId: string | undefined,
	request: (input: TInput) => Promise<ImpactLimit>,
	success: (limit: ImpactLimit) => string,
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: request,
		onSuccess: (limit) => {
			queryClient.invalidateQueries({
				queryKey: impactLimitKeys.scope(workspaceId, environmentId),
			});
			toast.success(success(limit));
		},
		onError: (error: Error) =>
			toast.error(error.message || "The impact limit could not be saved."),
	});
}

export function useCreateImpactLimit(
	workspaceId?: string,
	environmentId?: string,
) {
	return useLimitMutation<CreateImpactLimitInput>(
		workspaceId,
		environmentId,
		(input) =>
			apiClient.post<ImpactLimit>(
				withEnvironment("/impact-limits", environmentId),
				input,
				{
					workspaceId,
				},
			),
		(limit) => `Limit "${limit.name}" created.`,
	);
}

export function useUpdateImpactLimit(
	workspaceId?: string,
	environmentId?: string,
) {
	return useLimitMutation<{ id: string; name?: string; amount?: number }>(
		workspaceId,
		environmentId,
		({ id, ...body }) =>
			apiClient.patch<ImpactLimit>(
				withEnvironment(`/impact-limits/${id}`, environmentId),
				body,
				{
					workspaceId,
				},
			),
		(limit) => `Limit "${limit.name}" updated.`,
	);
}

export function useArchiveImpactLimit(
	workspaceId?: string,
	environmentId?: string,
) {
	return useLimitMutation<string>(
		workspaceId,
		environmentId,
		(id) =>
			apiClient.delete<ImpactLimit>(
				withEnvironment(`/impact-limits/${id}`, environmentId),
				{
					workspaceId,
				},
			),
		(limit) => `Limit "${limit.name}" archived. Its reservations still settle.`,
	);
}
