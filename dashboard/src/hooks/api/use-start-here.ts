import { isFeatureEnabled } from "@anlyon/feature-flags";
import { useQueries } from "@tanstack/react-query";
import { useRef } from "react";
import { useActions } from "@/hooks/api/use-actions";
import { endUserKeys } from "@/hooks/api/use-end-users";
import { useEnvironments } from "@/hooks/api/use-environments";
import { useApiKeys } from "@/hooks/api/use-workspaces";
import { apiClient } from "@/lib/api-client";
import type { StartHereInput } from "@/lib/start-here";
import type { EndUserPage } from "@/lib/types";

export const START_HERE_POLL_MS = 15_000;

export function useStartHere(
	workspaceId: string | undefined,
): StartHereInput & { available: boolean; error: unknown } {
	const usersAvailable = isFeatureEnabled("connected-accounts");
	const keys = useApiKeys(workspaceId ?? "");
	const environments = useEnvironments(workspaceId);
	const actions = useActions(workspaceId);
	const envs = environments.data ?? [];
	const done = useRef(false);

	const userPages = useQueries({
		queries: envs.map((env) => ({
			queryKey: endUserKeys.list(workspaceId, env.id, undefined, undefined),
			queryFn: () =>
				apiClient.get<EndUserPage>("/end-users", {
					workspaceId,
					params: { environmentId: env.id },
				}),
			enabled: !!workspaceId && usersAvailable,
			refetchInterval: () => (done.current ? false : START_HERE_POLL_MS),
			refetchIntervalInBackground: false,
		})),
	});

	const usersKnown =
		usersAvailable &&
		environments.data !== undefined &&
		userPages.every((page) => page.data !== undefined || page.isError);
	const users = userPages.flatMap((page) => page.data?.data ?? []);
	done.current = users.some((user) => user.invocations > 0);

	return {
		available: usersAvailable,
		apiKeys: keys.data
			? keys.data.filter((key) => key.isActive !== false).length
			: undefined,
		connectedUsers: usersKnown
			? users.filter((user) => user.connections > 0).length
			: undefined,
		usersWithCalls: usersKnown
			? users.filter((user) => user.invocations > 0).length
			: undefined,
		redirectUrlSet: environments.data
			? envs.some((env) => !!env.defaultRedirectUrl)
			: undefined,
		actions: actions.data?.length,
		exampleAction: (
			actions.data?.find(
				(action) =>
					action.enabled !== false &&
					JSON.stringify(action.headers ?? {}).includes("{{connection:"),
			) ?? actions.data?.find((action) => action.enabled !== false)
		)?.name,
		error: keys.error ?? environments.error ?? actions.error,
	};
}
