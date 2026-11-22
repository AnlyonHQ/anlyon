import {
	createFileRoute,
	Outlet,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import { Fragment, useEffect } from "react";
import { ExtensionSessions } from "@/components/extension-slots";
import { GlobalBanners } from "@/components/global-banners";
import { AppLayout } from "@/components/layout/app-layout";
import { useWorkspace, WorkspaceProvider } from "@/contexts/workspace-context";
import { type RealtimeStatus, useRealtime } from "@/hooks/use-realtime";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_protected")({
	beforeLoad: async ({ location }) => {
		try {
			const session = await authClient.getSession();
			if (!session?.data?.user) {
				throw redirect({
					to: "/auth/login",
					search: {
						redirect: location.href,
					},
				});
			}
		} catch {
			throw redirect({
				to: "/auth/login",
				search: {
					redirect: location.href,
				},
			});
		}
	},
	component: ProtectedLayout,
});

function ProtectedLayout() {
	return (
		<WorkspaceProvider>
			<ExtensionSessions />
			<WorkspaceChecker>
				<Outlet />
			</WorkspaceChecker>
		</WorkspaceProvider>
	);
}

const LANDING_PAGES = new Set(["/", "/dashboard", "/get-started"]);

function WorkspaceChecker({ children }: { children: React.ReactNode }) {
	const { hasWorkspaces, isLoading, currentWorkspace } = useWorkspace();
	const navigate = useNavigate();

	const realtimeStatus = useRealtime(currentWorkspace?.id);

	useEffect(() => {
		const currentPath = window.location.pathname;
		const isWorkspaceManagementPage =
			currentPath.includes("/workspaces/new") ||
			currentPath.includes("/workspaces/select");

		if (!isLoading && !hasWorkspaces && !isWorkspaceManagementPage) {
			const heading = `${currentPath}${window.location.search}`;
			navigate({
				to: "/workspaces/new",
				search: LANDING_PAGES.has(currentPath) ? {} : { redirect: heading },
			});
		}
	}, [hasWorkspaces, isLoading, navigate]);

	if (isLoading) {
		return (
			<div className="flex h-screen items-center justify-center">
				<div className="text-center flex justify-center items-center flex-col gap-2">
					<div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
					<p className="mt-4 text-sm text-muted-foreground">
						Loading workspace...
					</p>
				</div>
			</div>
		);
	}

	if (!hasWorkspaces) {
		const currentPath = window.location.pathname;
		const isWorkspaceManagementPage =
			currentPath.includes("/workspaces/new") ||
			currentPath.includes("/workspaces/select");

		if (isWorkspaceManagementPage) {
			return <AppLayout>{children}</AppLayout>;
		}
		return null;
	}

	return (
		<AppLayout>
			<GlobalBanners />
			<RealtimeStatusNotice status={realtimeStatus} />
			<Fragment key={currentWorkspace?.id}>{children}</Fragment>
		</AppLayout>
	);
}

function RealtimeStatusNotice({ status }: { status: RealtimeStatus }) {
	if (status !== "reconnecting" && status !== "disconnected") return null;

	const isDisconnected = status === "disconnected";
	return (
		<output
			aria-live="polite"
			className={`block rounded-lg border px-3.5 py-2.5 text-sm ${
				isDisconnected
					? "border-destructive/40 bg-destructive/10 text-destructive"
					: "border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-200"
			}`}
		>
			{isDisconnected
				? "Live updates are unavailable. Refresh to check for new activity."
				: "Reconnecting to live updates…"}
		</output>
	);
}
