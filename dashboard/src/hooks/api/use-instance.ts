import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { ApiError, apiClient } from "@/lib/api-client";
import { API_BASE_URL } from "@/lib/constants";
import type { Health } from "@/lib/instance-onboarding";
import { isSelfHosted } from "@/lib/runtime-config";

export type InstanceSettingGroup =
	| "email"
	| "storage"
	| "accounts"
	| "license"
	| "telemetry"
	| "oauth"
	| "slack"
	| "mcp"
	| "network";

export interface InstanceSetting {
	key: string;
	group: InstanceSettingGroup;
	label: string;
	description: string;
	secret: boolean;
	value?: string | null;
	set: boolean;
	source: "environment" | "database" | "default" | "unset";
	env: string;
	default: string | null;
	updatedAt: string | null;
	updatedBy: string | null;
}

export interface InstanceStatus {
	edition: "community" | "team" | "enterprise";
	setupCompletedAt: string | null;
	rootKey: {
		inUse: boolean;
		derivedKeys: string[];
		backupConfirmedAt: string | null;
		backupConfirmedBy: string | null;
	};
	telemetry: { enabled: boolean; endpoint: string };
}

export interface CheckResult {
	ok: boolean;
	message: string;
}

export interface LicensePreview {
	valid: boolean;
	message: string;
	tier: "team" | "enterprise" | null;
	org: string | null;
	seats: number | null;
	features: string[];
	expiresAt: string | null;
}

export interface InstanceAdmin {
	userId: string;
	email: string;
	name: string;
	grantedBy: string | null;
	grantedAt: string;
}

export const instanceKeys = {
	setup: ["setup"] as const,
	status: ["instance", "status"] as const,
	settings: ["instance", "settings"] as const,
	telemetry: ["instance", "telemetry"] as const,
	admins: ["instance", "admins"] as const,
};

export const isNotFound = (error: unknown) =>
	error instanceof ApiError && error.status === 404;
export const isForbidden = (error: unknown) =>
	error instanceof ApiError && error.status === 403;

const fail = (fallback: string) => (error: Error) =>
	toast.error(error.message || fallback);

export function useSetupPending() {
	return useQuery({
		queryKey: instanceKeys.setup,
		queryFn: async () => {
			try {
				return (await apiClient.get<{ pending: boolean }>("/setup")).pending;
			} catch (error) {
				if (isNotFound(error)) return false;
				throw error;
			}
		},
		enabled: isSelfHosted(),
		retry: false,
		staleTime: 30_000,
	});
}

export function verifySetupToken(token: string) {
	return apiClient.post<{ valid: boolean }>("/setup/verify", { token });
}

export interface OwnerInput {
	token: string;
	name: string;
	email: string;
	password: string;
	workspaceName?: string;
}

export function createSetupOwner(input: OwnerInput) {
	return apiClient.post<{ userId: string; workspaceId: string }>(
		"/setup/owner",
		input,
	);
}

export function useServerHealth(intervalMs = 5000) {
	return useQuery({
		queryKey: ["server-health"],
		queryFn: async (): Promise<Health & { commit: string | null }> => {
			const origin = API_BASE_URL.replace(/\/$/, "");
			const live = await fetch(`${origin}/health`, { cache: "no-store" })
				.then(async (response) =>
					response.ok
						? ((await response.json()) as { build?: { commit?: string } })
						: null,
				)
				.catch(() => null);
			if (!live) return { api: false, commit: null };
			const ready = await fetch(`${origin}/health/ready`, { cache: "no-store" })
				.then(
					async (response) =>
						(await response.json()) as {
							checks?: { redis?: boolean; database?: boolean };
						},
				)
				.catch(() => null);
			const commit = live.build?.commit;
			return {
				api: true,
				database: ready?.checks?.database ?? false,
				redis: ready?.checks?.redis ?? false,
				commit: commit && commit !== "unknown" ? commit : null,
			};
		},
		enabled: isSelfHosted(),
		refetchInterval: intervalMs,
		refetchIntervalInBackground: false,
		retry: false,
	});
}

export function useInstanceStatus(enabled = true) {
	return useQuery({
		queryKey: instanceKeys.status,
		queryFn: () => apiClient.get<InstanceStatus>("/instance/status"),
		enabled: isSelfHosted() && enabled,
		retry: (count, error) => !isForbidden(error) && count < 2,
	});
}

export function useConfirmRootKeyBackup() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () =>
			apiClient.post<InstanceStatus>(
				"/instance/root-key/backup-confirmation",
				{},
			),
		onSuccess: (status) => {
			queryClient.setQueryData(instanceKeys.status, status);
		},
		onError: fail("Could not record the confirmation"),
	});
}

export function useInstanceSettings(enabled = true) {
	return useQuery({
		queryKey: instanceKeys.settings,
		queryFn: async () =>
			(
				await apiClient.get<{ settings: InstanceSetting[] }>(
					"/instance/settings",
				)
			).settings,
		enabled: isSelfHosted() && enabled,
		retry: (count, error) => !isForbidden(error) && count < 2,
	});
}

export function useUpdateInstanceSettings() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (values: Record<string, string | null>) =>
			apiClient.patch<{ changed: string[]; settings: InstanceSetting[] }>(
				"/instance/settings",
				{ values },
			),
		onSuccess: (result) => {
			queryClient.setQueryData(instanceKeys.settings, result.settings);
			queryClient.invalidateQueries({ queryKey: instanceKeys.status });
			queryClient.invalidateQueries({ queryKey: ["edition"] });
			toast.success("Saved. It applies now; no restart needed.");
		},
		onError: fail("Could not save the settings"),
	});
}

export function useSendTestEmail() {
	return useMutation({
		mutationFn: (to: string) =>
			apiClient.post<CheckResult>("/instance/settings/email/test", { to }),
		onError: fail("Could not send the test email"),
	});
}

export function useTestStorage() {
	return useMutation({
		mutationFn: () =>
			apiClient.post<CheckResult>("/instance/settings/storage/test", {}),
		onError: fail("Could not test storage"),
	});
}

export function usePreviewLicense() {
	return useMutation({
		mutationFn: (key: string) =>
			apiClient.post<LicensePreview>("/instance/license/preview", { key }),
		onError: fail("Could not verify the licence key"),
	});
}

export function useTelemetryPreview(enabled: boolean) {
	return useQuery({
		queryKey: instanceKeys.telemetry,
		queryFn: () =>
			apiClient.get<Record<string, unknown>>("/instance/telemetry/preview"),
		enabled: isSelfHosted() && enabled,
	});
}

export function useInstanceAdmins(enabled = true) {
	return useQuery({
		queryKey: instanceKeys.admins,
		queryFn: async () =>
			(await apiClient.get<{ admins: InstanceAdmin[] }>("/instance/admins"))
				.admins,
		enabled: isSelfHosted() && enabled,
		retry: (count, error) => !isForbidden(error) && count < 2,
	});
}

export function useGrantInstanceAdmin() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (email: string) =>
			apiClient.post<InstanceAdmin>("/instance/admins", { email }),
		onSuccess: (admin) => {
			queryClient.invalidateQueries({ queryKey: instanceKeys.admins });
			toast.success(`${admin.email} is now an instance admin`);
		},
		onError: fail("Could not grant instance admin"),
	});
}

export function useRevokeInstanceAdmin() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (userId: string) =>
			apiClient.delete<{ revoked: boolean }>(
				`/instance/admins/${encodeURIComponent(userId)}`,
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: instanceKeys.admins });
			toast.success("Instance admin revoked");
		},
		onError: fail("Could not revoke instance admin"),
	});
}
