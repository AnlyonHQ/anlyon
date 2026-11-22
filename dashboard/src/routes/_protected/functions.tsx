import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";
import { useWorkspace } from "@/contexts/workspace-context";
import { useFunctionsAvailable } from "@/hooks/api/use-functions";
import { requireFeature } from "@/lib/feature-flags";

export const Route = createFileRoute("/_protected/functions")({
	beforeLoad: () => requireFeature("functions"),
	component: FunctionsLayout,
});

function FunctionsLayout() {
	const { currentWorkspace } = useWorkspace();
	const available = useFunctionsAvailable(currentWorkspace?.id);
	if (available === false) return <Navigate to="/dashboard" />;
	return <Outlet />;
}
