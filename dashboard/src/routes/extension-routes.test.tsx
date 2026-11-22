/* @vitest-environment jsdom */

import { QueryClient } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionPageView } from "@/components/extension-slots";
import { registerExtension, resetExtensions } from "@/lib/extensions";
import { routeTree } from "@/routeTree.gen";

vi.mock("@/lib/auth-client", () => ({
	authClient: {
		getSession: async () => ({ data: { user: { id: "user_1" } } }),
	},
}));

function renderPage(path: string) {
	const router = createRouter({
		routeTree: createRootRoute({ component: ExtensionPageView }),
		history: createMemoryHistory({ initialEntries: [path] }),
	});
	render(<RouterProvider router={router as never} />);
}

async function open(path: string) {
	const router = createRouter({
		routeTree,
		context: { queryClient: new QueryClient() },
		history: createMemoryHistory({ initialEntries: [path] }),
	});
	await router.load();
	return {
		pathname: router.state.location.pathname,
		routeId: router.state.matches.at(-1)?.routeId,
	};
}

beforeAll(async () => {
	await open("/settings/plan");
	await open("/plan");
}, 60_000);

afterEach(() => {
	cleanup();
	resetExtensions();
});

describe("extension routes", () => {
	it("serves no page at an unknown URL without an extension", async () => {
		expect(await open("/settings/plan")).toEqual({
			pathname: "/settings/plan",
			routeId: "/_protected/settings/$",
		});
		expect(await open("/plan")).toEqual({
			pathname: "/plan",
			routeId: "/_protected/$",
		});
		renderPage("/settings/plan");
		expect(await screen.findByText("Page not found")).toBeTruthy();
	});

	it("leaves every core route to its own file", async () => {
		expect((await open("/settings/usage")).routeId).toBe(
			"/_protected/settings/usage",
		);
		expect((await open("/analytics")).routeId).toBe("/_protected/analytics");
	});

	it("renders an extension's page at its path and forwards an old URL to it", async () => {
		registerExtension({
			id: "fixture",
			pages: [
				{ path: "/settings/plan", component: () => <p>Fixture plan page</p> },
				{ path: "/plan", redirectTo: "/settings/plan" },
			],
		});
		expect(await open("/plan")).toEqual({
			pathname: "/settings/plan",
			routeId: "/_protected/settings/$",
		});
		renderPage("/settings/plan/");
		expect(await screen.findByText("Fixture plan page")).toBeTruthy();
	});
});
