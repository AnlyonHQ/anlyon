import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { ApiError, apiClient } from "@/lib/api-client";
import type { Role } from "@/lib/types";

export interface SsoConnection {
	workspaceId: string;
	providerId: string;
	protocol: "oidc" | "saml";
	issuer: string;
	domains: string[];
	domainsVerified: boolean;
	domainsVerifiedAt: string | null;
	verificationRecords: Array<{
		domain: string;
		name: string;
		type: "TXT";
		value: string;
	}>;
	enforced: boolean;
	defaultRole: string;
	serviceProvider: {
		oidcRedirectUri?: string;
		samlAcsUrl?: string;
		samlEntityId?: string;
		samlMetadataUrl?: string;
	};
	createdAt: string;
	updatedAt: string;
}

export type CreateSsoConnectionInput =
	| {
			protocol: "oidc";
			domains: string[];
			defaultRole?: string;
			oidc: { issuer: string; clientId: string; clientSecret: string };
	  }
	| {
			protocol: "saml";
			domains: string[];
			defaultRole?: string;
			saml: {
				entityId: string;
				ssoUrl: string;
				certificate: string;
				emailAttribute?: string;
				nameAttribute?: string;
			};
	  };

export interface ScimRoleMapping {
	groupName: string;
	role: string;
	priority: number;
}

export interface ScimSettings {
	connected: boolean;
	baseUrl: string;
	tokenPrefix: string | null;
	defaultRole: string;
	createdAt: string | null;
	rotatedAt: string | null;
	lastUsedAt: string | null;
	roleMappings: ScimRoleMapping[];
}

export const identityKeys = {
	sso: (workspaceId: string) => ["workspaces", "sso", workspaceId] as const,
	scim: (workspaceId: string) => ["workspaces", "scim", workspaceId] as const,
};

export function isUnavailable(error: unknown): boolean {
	return error instanceof ApiError && error.status === 404;
}

export function isEnforcementSuspended(error: unknown): boolean {
	return (
		error instanceof ApiError && error.code === "SSO_ENFORCEMENT_SUSPENDED"
	);
}

const fail = (fallback: string) => (error: Error) =>
	toast.error(error.message || fallback);

export function useSsoConnection(workspaceId: string) {
	return useQuery({
		queryKey: identityKeys.sso(workspaceId),
		queryFn: () =>
			apiClient.get<SsoConnection | null>(`/workspaces/${workspaceId}/sso`),
		enabled: !!workspaceId,
		retry: (count, error) => !isUnavailable(error) && count < 2,
	});
}

function useSsoMutation<V>(
	workspaceId: string,
	fn: (vars: V) => Promise<unknown>,
	success: string,
	fallback: string,
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: identityKeys.sso(workspaceId),
			});
			toast.success(success);
		},
		onError: fail(fallback),
	});
}

export function useCreateSsoConnection(workspaceId: string) {
	return useSsoMutation(
		workspaceId,
		(input: CreateSsoConnectionInput) =>
			apiClient.post<SsoConnection>(`/workspaces/${workspaceId}/sso`, input),
		"Identity provider saved. Add the DNS records, then verify.",
		"Could not save the identity provider",
	);
}

export function useVerifySsoDomains(workspaceId: string) {
	return useSsoMutation(
		workspaceId,
		() =>
			apiClient.post<SsoConnection>(
				`/workspaces/${workspaceId}/sso/verify-domains`,
				{},
			),
		"Domains verified. Members can now sign in with SSO.",
		"The domains could not be verified",
	);
}

export function useUpdateSsoConnection(workspaceId: string) {
	return useSsoMutation(
		workspaceId,
		(patch: { enforced?: boolean; defaultRole?: string }) =>
			apiClient.patch<SsoConnection>(`/workspaces/${workspaceId}/sso`, patch),
		"Single sign-on settings saved",
		"Could not save the settings",
	);
}

export function useDeleteSsoConnection(workspaceId: string) {
	return useSsoMutation(
		workspaceId,
		() => apiClient.delete(`/workspaces/${workspaceId}/sso`),
		"Identity provider removed",
		"Could not remove the identity provider",
	);
}

export function useScimSettings(workspaceId: string) {
	return useQuery({
		queryKey: identityKeys.scim(workspaceId),
		queryFn: () =>
			apiClient.get<ScimSettings>(`/workspaces/${workspaceId}/scim`),
		enabled: !!workspaceId,
		retry: (count, error) => !isUnavailable(error) && count < 2,
	});
}

export function useIssueScimToken(workspaceId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () =>
			apiClient.post<{ token: string; settings: ScimSettings }>(
				`/workspaces/${workspaceId}/scim/token`,
				{},
			),
		onSuccess: (result) => {
			queryClient.setQueryData(identityKeys.scim(workspaceId), result.settings);
		},
		onError: fail("Could not create the SCIM token"),
	});
}

function useScimMutation<V>(
	workspaceId: string,
	fn: (vars: V) => Promise<unknown>,
	success: string,
	fallback: string,
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: identityKeys.scim(workspaceId),
			});
			toast.success(success);
		},
		onError: fail(fallback),
	});
}

export function useRevokeScimToken(workspaceId: string) {
	return useScimMutation(
		workspaceId,
		() => apiClient.delete(`/workspaces/${workspaceId}/scim/token`),
		"Directory disconnected",
		"Could not disconnect the directory",
	);
}

export function useUpdateScimDefaultRole(workspaceId: string) {
	return useScimMutation(
		workspaceId,
		(defaultRole: string) =>
			apiClient.patch(`/workspaces/${workspaceId}/scim`, { defaultRole }),
		"Default role saved",
		"Could not save the default role",
	);
}

export function useReplaceScimRoleMappings(workspaceId: string) {
	return useScimMutation(
		workspaceId,
		(mappings: ScimRoleMapping[]) =>
			apiClient.put(`/workspaces/${workspaceId}/scim/role-mappings`, {
				mappings,
			}),
		"Group mappings saved",
		"Could not save the group mappings",
	);
}

export const PROVISIONABLE_ROLE_OPTIONS: Array<{
	value: Role;
	label: string;
}> = [
	{ value: "member", label: "Member" },
	{ value: "approver", label: "Approver" },
	{ value: "viewer", label: "Viewer" },
	{ value: "admin", label: "Admin" },
];
