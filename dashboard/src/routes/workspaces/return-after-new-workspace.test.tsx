/* @vitest-environment jsdom */

import { cleanup, render, waitFor } from "@testing-library/react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { Route as Protected } from "@/routes/_protected";

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => mocks.navigate,
	Outlet: () => null,
}));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
vi.mock("@/components/layout/app-layout", () => ({ AppLayout: () => null }));
vi.mock("@/components/global-banners", () => ({ GlobalBanners: () => null }));
vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ hasWorkspaces: false, isLoading: false }),
	WorkspaceProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => "connected" }));

const Layout = Protected.options.component as React.ComponentType & {
	preload?: () => Promise<void>;
};

beforeAll(async () => {
	await Layout.preload?.();
});

beforeEach(() => {
	mocks.navigate.mockClear();
});

afterEach(() => {
	cleanup();
	window.history.pushState(null, "", "/");
});

describe("a signed-in person with no workspace", () => {
	it("keeps the page a link named on the way to creating one", async () => {
		const page =
			"/mcp-servers/new?url=https%3A%2F%2Fmcp.figma.com%2Fmcp&utm_source=anlyon.dev";
		window.history.pushState(null, "", page);
		render(<Layout />);
		await waitFor(() =>
			expect(mocks.navigate).toHaveBeenCalledWith({
				to: "/workspaces/new",
				search: { redirect: page },
			}),
		);
	});

	it.each(["/", "/dashboard", "/get-started"])(
		"from %s goes on to the setup journey as before",
		async (landing) => {
			window.history.pushState(null, "", landing);
			render(<Layout />);
			await waitFor(() =>
				expect(mocks.navigate).toHaveBeenCalledWith({
					to: "/workspaces/new",
					search: {},
				}),
			);
		},
	);
});
