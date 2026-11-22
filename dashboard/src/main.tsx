import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "./components/error-boundary";
import { RoutePending } from "./components/layout/route-pending";
import * as TanStackQueryProvider from "./integrations/tanstack-query/root-provider.tsx";
import { startExtensions } from "./lib/extensions";
import { loadExtensions } from "./lib/load-extensions";

import { routeTree } from "./routeTree.gen";

import "./styles.css";
import reportWebVitals from "./reportWebVitals.ts";

const TanStackQueryProviderContext = TanStackQueryProvider.getContext();
const router = createRouter({
	routeTree,
	context: {
		...TanStackQueryProviderContext,
	},
	defaultPreload: "intent",
	scrollRestoration: true,
	defaultStructuralSharing: true,
	defaultPreloadStaleTime: 0,
	defaultPendingComponent: RoutePending,
	defaultPendingMs: 200,
	defaultPendingMinMs: 300,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

loadExtensions();
startExtensions();

const rootElement = document.getElementById("app");
if (rootElement && !rootElement.innerHTML) {
	const root = ReactDOM.createRoot(rootElement);
	root.render(
		<StrictMode>
			<ErrorBoundary>
				<TanStackQueryProvider.Provider {...TanStackQueryProviderContext}>
					<RouterProvider router={router} />
				</TanStackQueryProvider.Provider>
			</ErrorBoundary>
		</StrictMode>,
	);
}

reportWebVitals();
