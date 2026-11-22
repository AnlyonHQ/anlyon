import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/mcp-servers/")({
	beforeLoad: () => {
		throw redirect({ to: "/integrations" });
	},
});
