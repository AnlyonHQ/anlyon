import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/actions/connections")({
	beforeLoad: ({ location }) => {
		throw redirect({
			href: `/integrations${location.searchStr}`,
			replace: true,
		});
	},
});
