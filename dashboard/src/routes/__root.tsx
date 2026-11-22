import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { ToastProvider } from "@/components/ui/toast";
import { ThemeProvider } from "@/contexts/theme-provider";

interface MyRouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
	component: () => (
		<ToastProvider position="top-right">
			<ThemeProvider defaultTheme="system" storageKey="theme">
				<div className="min-w-0 overflow-x-hidden">
					<Outlet />
				</div>
			</ThemeProvider>
		</ToastProvider>
	),
});
