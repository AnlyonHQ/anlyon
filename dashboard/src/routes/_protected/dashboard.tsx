import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_protected/dashboard")({
	component: DashboardPage,
	beforeLoad: async () => {
		return redirect({ to: "/analytics" });
	},
});

function DashboardPage() {
	return <div></div>;
}
