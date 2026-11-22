import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/end-users/$endUserId")({
	beforeLoad: ({ location, params }) => {
		throw redirect({
			href: `/users/${encodeURIComponent(params.endUserId)}${location.searchStr}`,
			replace: true,
		});
	},
});
