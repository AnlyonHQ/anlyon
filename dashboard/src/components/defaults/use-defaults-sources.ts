import { isFeatureEnabled } from "@anlyon/feature-flags";
import { useEnvironments } from "@/hooks/api/use-environments";
import { useIntegrations } from "@/hooks/api/use-integrations";
import { useNotificationPreferences } from "@/hooks/api/use-notifications";
import { useWorkspacePermissions } from "@/hooks/api/use-permissions";
import { useWorkspaceDefaults } from "@/hooks/api/use-workspace-defaults";

export function useDefaultsSources(workspaceId?: string) {
	const defaults = useWorkspaceDefaults(workspaceId);
	const preferences = useNotificationPreferences(workspaceId);
	const environments = useEnvironments(workspaceId);
	const integrations = useIntegrations(workspaceId);
	const permissions = useWorkspacePermissions(workspaceId);

	const granted = permissions.data?.permissions ?? [];
	const canEdit =
		granted.includes("workspace.update") &&
		granted.includes("notifications.manage");
	const environment = (environments.data ?? []).find((env) => env.isDefault);
	const slack = (integrations.data ?? []).find(
		(integration) => integration.type === "slack" && integration.isActive,
	);

	return {
		defaults: defaults.data,
		preferences: preferences.data,
		environment,
		slack,
		canEdit,
		roleKnown: permissions.data !== undefined,
		asksRedirect:
			isFeatureEnabled("connected-accounts") && environment !== undefined,
		isLoading:
			defaults.isLoading ||
			preferences.isLoading ||
			environments.isLoading ||
			permissions.isLoading,
		isError: defaults.isError || preferences.isError,
		refetch: () => {
			void defaults.refetch();
			void preferences.refetch();
		},
	};
}
