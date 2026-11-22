import { isFeatureEnabled } from "@anlyon/feature-flags";
import { createFileRoute } from "@tanstack/react-router";
import { FirstRunTour } from "@/components/first-run/first-run-tour";
import { Quickstart } from "@/components/first-run/quickstart";
import { useWorkspace } from "@/contexts/workspace-context";
import { requireFeature } from "@/lib/feature-flags";

interface GetStartedSearch {
	tour?: "sandbox";
}

export const Route = createFileRoute("/_protected/get-started")({
	validateSearch: (search: Record<string, unknown>): GetStartedSearch =>
		search.tour === "sandbox" ? { tour: "sandbox" } : {},
	beforeLoad: () => {
		requireFeature("actions");
		requireFeature("approvals");
	},
	component: GetStartedPage,
});

function GetStartedPage() {
	const { currentWorkspace } = useWorkspace();
	const { tour } = Route.useSearch();
	if (tour === "sandbox" || !isFeatureEnabled("connected-accounts")) {
		return <FirstRunTour workspaceId={currentWorkspace?.id} />;
	}
	return (
		<Quickstart
			workspaceId={currentWorkspace?.id}
			workspaceName={currentWorkspace?.name}
		/>
	);
}
