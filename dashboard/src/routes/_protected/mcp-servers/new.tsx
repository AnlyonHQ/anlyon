import { createFileRoute } from "@tanstack/react-router";
import { AddServerPage } from "@/components/mcp-servers/add-server-page";
import { addServerSearch } from "@/lib/mcp-server-link";

export const Route = createFileRoute("/_protected/mcp-servers/new")({
	validateSearch: addServerSearch,
	component: AddServerRoute,
});

function AddServerRoute() {
	const { server } = Route.useSearch();
	return <AddServerPage serverSlug={server} />;
}
