import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/settings/connections")({
	beforeLoad: ({ location }) => {
		throw redirect({
			href: `/integrations/settings${location.searchStr}`,
			replace: true,
		});
	},
});
