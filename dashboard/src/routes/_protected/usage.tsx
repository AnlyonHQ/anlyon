import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/usage")({
	beforeLoad: () => {
		throw redirect({ to: "/settings/usage" });
	},
});
