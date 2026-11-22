import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type {
	MyNotificationPreferences,
	Notification,
	NotificationPreferences,
	NotificationType,
	UpdateNotificationPreferencesRequest,
} from "@/lib/types";

export const notificationKeys = {
	all: ["notifications"] as const,
	list: (workspaceId: string) =>
		[...notificationKeys.all, "list", workspaceId] as const,
	unreadCount: (workspaceId: string) =>
		[...notificationKeys.all, "unread", workspaceId] as const,
	preferences: (workspaceId: string) =>
		[...notificationKeys.all, "preferences", workspaceId] as const,
	myPreferences: (workspaceId: string) =>
		[...notificationKeys.all, "preferences", "me", workspaceId] as const,
};

interface NotificationsResponse {
	notifications: Notification[];
	total: number;
	unreadCount: number;
}

export function useNotifications(workspaceId?: string) {
	return useQuery({
		queryKey: notificationKeys.list(workspaceId || ""),
		queryFn: () =>
			apiClient.get<NotificationsResponse>("/notifications", { workspaceId }),
		enabled: !!workspaceId,
		refetchInterval: 60000,
		select: (data) => data.notifications,
	});
}

export function useUnreadNotificationCount(workspaceId?: string) {
	return useQuery({
		queryKey: notificationKeys.unreadCount(workspaceId || ""),
		queryFn: () =>
			apiClient.get<{ count: number }>("/notifications/unread-count", {
				workspaceId,
			}),
		enabled: !!workspaceId,
		refetchInterval: 30000,
		select: (data) => data.count,
	});
}

export function useMarkNotificationRead() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			notificationId,
		}: {
			workspaceId: string;
			notificationId: string;
		}) =>
			apiClient.patch<{ success: boolean }>(
				`/notifications/${notificationId}/read`,
				{},
				{ workspaceId },
			),
		onSuccess: (_, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: notificationKeys.list(workspaceId),
			});
			queryClient.invalidateQueries({
				queryKey: notificationKeys.unreadCount(workspaceId),
			});
		},
	});
}

export function useMarkAllNotificationsRead() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (workspaceId: string) =>
			apiClient.patch<{ success: boolean }>(
				"/notifications/read-all",
				{},
				{ workspaceId },
			),
		onSuccess: (_, workspaceId) => {
			queryClient.invalidateQueries({
				queryKey: notificationKeys.list(workspaceId),
			});
			queryClient.invalidateQueries({
				queryKey: notificationKeys.unreadCount(workspaceId),
			});
			toast.success("All notifications marked as read");
		},
	});
}

export function useDismissNotification() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			notificationId,
		}: {
			workspaceId: string;
			notificationId: string;
		}) =>
			apiClient.delete<{ success: boolean }>(
				`/notifications/${notificationId}`,
				{ workspaceId },
			),
		onSuccess: (_, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: notificationKeys.list(workspaceId),
			});
			queryClient.invalidateQueries({
				queryKey: notificationKeys.unreadCount(workspaceId),
			});
		},
	});
}

export function useNotificationPreferences(workspaceId?: string) {
	return useQuery({
		queryKey: notificationKeys.preferences(workspaceId || ""),
		queryFn: () =>
			apiClient.get<NotificationPreferences>("/notifications/preferences", {
				workspaceId,
			}),
		enabled: !!workspaceId,
	});
}

export function useUpdateNotificationPreferences() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			preferences,
		}: {
			workspaceId: string;
			preferences: UpdateNotificationPreferencesRequest;
		}) =>
			apiClient.patch<NotificationPreferences>(
				"/notifications/preferences",
				preferences,
				{ workspaceId },
			),
		onSuccess: (_, { workspaceId }) => {
			queryClient.invalidateQueries({
				queryKey: notificationKeys.preferences(workspaceId),
			});
			toast.success("Notification preferences updated");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to update preferences");
		},
	});
}

export function useMyNotificationPreferences(workspaceId?: string) {
	return useQuery({
		queryKey: notificationKeys.myPreferences(workspaceId || ""),
		queryFn: () =>
			apiClient.get<MyNotificationPreferences>(
				"/notifications/preferences/me",
				{ workspaceId },
			),
		enabled: !!workspaceId,
	});
}

export function useUpdateMyNotificationPreferences() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			workspaceId,
			mutedTypes,
		}: {
			workspaceId: string;
			mutedTypes: NotificationType[];
		}) =>
			apiClient.patch<MyNotificationPreferences>(
				"/notifications/preferences/me",
				{ mutedTypes },
				{ workspaceId },
			),
		onSuccess: (saved, { workspaceId }) => {
			queryClient.setQueryData(
				notificationKeys.myPreferences(workspaceId),
				saved,
			);
			queryClient.invalidateQueries({
				queryKey: notificationKeys.list(workspaceId),
			});
			queryClient.invalidateQueries({
				queryKey: notificationKeys.unreadCount(workspaceId),
			});
			toast.success("Your notification preferences were saved");
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to save your preferences");
		},
	});
}
