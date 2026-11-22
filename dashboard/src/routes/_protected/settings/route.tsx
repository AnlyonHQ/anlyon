import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/settings")({
	component: SettingsLayout,
});

function SettingsLayout() {
	return (
		<div className="pt-4">
			<Outlet />
		</div>
	);
}
