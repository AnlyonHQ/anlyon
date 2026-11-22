import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { oauthApiClient } from "@/lib/api-client";

export interface OAuthGrant {
	clientId: string;
	name: string | null;
	uri: string | null;
	redirectHosts: string[];
	permissions: Array<{ scope: string; label: string; sensitive: boolean }>;
	workspace: { id: string; name: string } | null;
	environment: { id: string; name: string } | null;
	authorizedAt: string;
	lastRenewedAt: string | null;
	active: boolean;
}

export const oauthGrantKeys = {
	all: ["oauth-grants"] as const,
};

export function useOAuthGrants() {
	return useQuery({
		queryKey: oauthGrantKeys.all,
		queryFn: () => oauthApiClient.get<{ grants: OAuthGrant[] }>("/grants"),
		select: (data) => data.grants,
	});
}

export function useRevokeOAuthGrant() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (clientId: string) =>
			oauthApiClient.delete<{ revoked: boolean }>(`/grants/${clientId}`),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: oauthGrantKeys.all });
			toast.success("App disconnected", {
				description:
					"It lost access immediately and will have to be authorized again.",
			});
		},
		onError: (error: Error) => {
			toast.error("Could not disconnect", { description: error.message });
		},
	});
}

export function useUpdateOAuthGrantEnvironment() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (input: {
			clientId: string;
			workspaceId: string;
			environmentId: string;
		}) =>
			oauthApiClient.post<{ workspaceId: string; environmentId: string }>(
				"/workspace-binding",
				input,
			),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: oauthGrantKeys.all });
			toast.success("App environment updated");
		},
		onError: (error: Error) => {
			toast.error("Could not update app environment", {
				description: error.message,
			});
		},
	});
}
