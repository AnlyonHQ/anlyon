import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { SetupJourney } from "@/components/defaults/setup-journey";
import { useWorkspace, WorkspaceProvider } from "@/contexts/workspace-context";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/workspaces/setup")({
	beforeLoad: async ({ location }) => {
		try {
			const session = await authClient.getSession();
			if (!session?.data?.user) {
				throw redirect({
					to: "/auth/login",
					search: { redirect: location.href },
				});
			}
		} catch {
			throw redirect({
				to: "/auth/login",
				search: { redirect: location.href },
			});
		}
	},
	component: WorkspaceSetupPage,
});

function WorkspaceSetupPage() {
	return (
		<WorkspaceProvider>
			<WorkspaceSetup />
		</WorkspaceProvider>
	);
}

function WorkspaceSetup() {
	const { currentWorkspace, hasWorkspaces, isLoading } = useWorkspace();
	const navigate = useNavigate();

	useEffect(() => {
		if (!isLoading && !hasWorkspaces) navigate({ to: "/workspaces/new" });
	}, [hasWorkspaces, isLoading, navigate]);

	return (
		<SetupJourney
			onDone={() => navigate({ to: "/dashboard" })}
			workspaceId={currentWorkspace?.id}
			workspaceName={currentWorkspace?.name}
		/>
	);
}
