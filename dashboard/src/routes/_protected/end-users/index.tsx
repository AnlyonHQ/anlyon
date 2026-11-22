import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/end-users/")({
	beforeLoad: ({ location }) => {
		throw redirect({ href: `/users${location.searchStr}`, replace: true });
	},
});
