import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireFeature } from "@/lib/feature-flags";

export const Route = createFileRoute("/_protected/events")({
	beforeLoad: () => requireFeature("events"),
	component: Outlet,
});
