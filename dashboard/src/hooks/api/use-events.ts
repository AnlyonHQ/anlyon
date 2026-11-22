import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type {
	CreateSubscriptionRequest,
	CreateTopicRequest,
	EventRecord,
	EventSubscription,
	EventTopic,
	EventWithDeliveries,
	PaginatedResponse,
	RotateSubscriptionSecretResult,
	UpdateSubscriptionRequest,
} from "@/lib/types";

export const eventKeys = {
	all: ["events"] as const,
	topics: (workspaceId?: string) =>
		[...eventKeys.all, "topics", workspaceId] as const,
	subscriptions: (topicRef?: string, workspaceId?: string) =>
		[...eventKeys.all, "subscriptions", topicRef, workspaceId] as const,
	lists: () => [...eventKeys.all, "list"] as const,
	list: (
		workspaceId?: string,
		params?: { topic?: string; type?: string; offset?: number },
	) => [...eventKeys.lists(), workspaceId, params] as const,
	details: () => [...eventKeys.all, "detail"] as const,
	detail: (eventId: string) => [...eventKeys.details(), eventId] as const,
};

export function useEventTopics(workspaceId?: string) {
	return useQuery({
		queryKey: eventKeys.topics(workspaceId),
		queryFn: () =>
			apiClient.get<EventTopic[]>("/events/topics", { workspaceId }),
		enabled: !!workspaceId,
	});
}

export function useCreateTopic() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			data,
			workspaceId,
		}: {
			data: CreateTopicRequest;
			workspaceId: string;
		}) => apiClient.post<EventTopic>("/events/topics", data, { workspaceId }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: eventKeys.all });
			toast.success("Topic created.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to create topic");
		},
	});
}

export function useDeleteTopic() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			topicRef,
			workspaceId,
		}: {
			topicRef: string;
			workspaceId: string;
		}) =>
			apiClient.delete<{ deleted: boolean }>(
				`/events/topics/${encodeURIComponent(topicRef)}`,
				{
					workspaceId,
				},
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: eventKeys.all });
			toast.success("Topic deleted.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to delete topic");
		},
	});
}

export function useEventSubscriptions(topicRef?: string, workspaceId?: string) {
	return useQuery({
		queryKey: eventKeys.subscriptions(topicRef, workspaceId),
		queryFn: () => {
			if (!topicRef) {
				return Promise.reject(new Error("topicRef is required"));
			}
			return apiClient.get<EventSubscription[]>(
				`/events/topics/${encodeURIComponent(topicRef)}/subscriptions`,
				{ workspaceId },
			);
		},
		enabled: !!topicRef && !!workspaceId,
	});
}

export function useCreateSubscription() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			topicRef,
			data,
			workspaceId,
		}: {
			topicRef: string;
			data: CreateSubscriptionRequest;
			workspaceId: string;
		}) =>
			apiClient.post<EventSubscription>(
				`/events/topics/${encodeURIComponent(topicRef)}/subscriptions`,
				data,
				{ workspaceId },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: eventKeys.all });
			toast.success("Subscription created.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to create subscription");
		},
	});
}

export function useUpdateSubscription() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			subscriptionId,
			data,
			workspaceId,
		}: {
			subscriptionId: string;
			data: UpdateSubscriptionRequest;
			workspaceId: string;
		}) =>
			apiClient.patch<EventSubscription>(
				`/events/subscriptions/${subscriptionId}`,
				data,
				{ workspaceId },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: eventKeys.all });
			toast.success("Subscription updated.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to update subscription");
		},
	});
}

export function useDeleteSubscription() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			subscriptionId,
			workspaceId,
		}: {
			subscriptionId: string;
			workspaceId: string;
		}) =>
			apiClient.delete<{ deleted: boolean }>(
				`/events/subscriptions/${subscriptionId}`,
				{ workspaceId },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: eventKeys.all });
			toast.success("Subscription deleted.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to delete subscription");
		},
	});
}

export function useRotateSubscriptionSecret() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			subscriptionId,
			workspaceId,
		}: {
			subscriptionId: string;
			workspaceId: string;
		}) =>
			apiClient.post<RotateSubscriptionSecretResult>(
				`/events/subscriptions/${subscriptionId}/rotate-secret`,
				undefined,
				{ workspaceId },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: eventKeys.all });
			toast.success("Secret rotated.");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to rotate secret");
		},
	});
}

export function useEvents(
	workspaceId?: string,
	params?: { topic?: string; type?: string; limit?: number; offset?: number },
) {
	return useQuery({
		queryKey: eventKeys.list(workspaceId, {
			topic: params?.topic,
			type: params?.type,
			offset: params?.offset,
		}),
		queryFn: () =>
			apiClient.get<PaginatedResponse<EventRecord>>("/events", {
				workspaceId,
				params: params as Record<string, string | number | boolean | undefined>,
			}),
		enabled: !!workspaceId,
	});
}

export function useEvent(eventId: string | undefined, workspaceId?: string) {
	return useQuery({
		queryKey: eventKeys.detail(eventId ?? ""),
		queryFn: () =>
			apiClient.get<EventWithDeliveries>(`/events/${eventId}`, { workspaceId }),
		enabled: !!eventId && !!workspaceId,
	});
}
