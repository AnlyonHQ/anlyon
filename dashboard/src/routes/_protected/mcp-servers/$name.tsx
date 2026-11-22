import { createFileRoute } from "@tanstack/react-router";
import {
	ServerPage,
	type ServerSearch,
} from "@/components/mcp-servers/server-page";

export const Route = createFileRoute("/_protected/mcp-servers/$name")({
	validateSearch: (search: Record<string, unknown>): ServerSearch => ({
		tab:
			search.tab === "people" || search.tab === "use" ? search.tab : undefined,
		filter:
			search.filter === "adopted" || search.filter === "review"
				? search.filter
				: undefined,
	}),
	component: ServerRoute,
});

function ServerRoute() {
	const { name } = Route.useParams();
	const { tab, filter } = Route.useSearch();
	return <ServerPage filter={filter} name={name} tab={tab} />;
}
