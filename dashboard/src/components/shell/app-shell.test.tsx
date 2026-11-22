/* @vitest-environment jsdom */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	path: "/actions",
	mobile: false,
	pending: 0,
	halted: false,
	navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		children,
		onClick,
		...rest
	}: {
		to: string;
		children?: React.ReactNode;
		onClick?: (event: React.MouseEvent) => void;
	} & Record<string, unknown>) => (
		<a
			{...rest}
			href={to}
			onClick={(event) => {
				event.preventDefault();
				onClick?.(event);
			}}
		>
			{children}
		</a>
	),
	useLocation: () => ({ pathname: mocks.path }),
	useNavigate: () => mocks.navigate,
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }));
vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({
		currentWorkspace: { id: "ws_1", name: "Acme", plan: "team" },
		workspaces: [{ id: "ws_1", name: "Acme" }],
		switchWorkspace: vi.fn(),
	}),
}));
vi.mock("@/hooks/api/use-approvals", () => ({
	useApprovals: () => ({ data: { pagination: { total: mocks.pending } } }),
}));
vi.mock("@/hooks/api/use-sign-offs", () => ({
	useSignOffs: () => ({ data: [] }),
}));
vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({
		data: [{ id: "env_1", name: "Production", halted: mocks.halted }],
	}),
}));
vi.mock("@/hooks/api/use-first-run", () => ({
	useFirstRun: () => ({ loading: false }),
}));
vi.mock("@/lib/first-run-storage", () => ({
	useFirstRunHidden: () => [true],
}));
vi.mock("@/hooks/use-auth", () => ({
	useAuth: () => ({
		user: { name: "Sam Rivera", email: "sam@example.com" },
		logout: vi.fn(),
	}),
}));
vi.mock("@/contexts/theme-provider", () => ({
	useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));
vi.mock("../notifications", () => ({
	NotificationPopover: () => <button type="button">Notifications</button>,
}));
vi.mock("@/hooks/api/use-functions", () => ({
	useFunctionsAvailable: () => false,
}));

import { AppShell, breadcrumbFor } from "./app-shell";
import { navAreas } from "./nav-config";

beforeEach(() => {
	mocks.path = "/actions";
	mocks.mobile = false;
	mocks.pending = 0;
	mocks.halted = false;
	window.localStorage.clear();
	window.localStorage.setItem("anlyon.orientation.seen.sam@example.com", "1");
	window.matchMedia ??= ((query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	})) as unknown as typeof window.matchMedia;
});
afterEach(() => vi.clearAllMocks());

const shell = () =>
	render(
		<AppShell>
			<p>Page content</p>
		</AppShell>,
	);

describe("breadcrumbFor", () => {
	const areas = navAreas({ showGetStarted: true });

	it("is Area › Page on a page", () => {
		expect(breadcrumbFor(areas, "/actions/invocations")).toEqual({
			area: "Activity",
			title: "Invocations",
		});
		expect(breadcrumbFor(areas, "/settings/api-keys")).toEqual({
			area: "Settings",
			title: "API keys",
		});
	});

	it("links back to the page from an item under it, and shows the id as given", () => {
		expect(breadcrumbFor(areas, "/users/org%3A7%40acme")).toEqual({
			area: undefined,
			parent: { title: "Users", href: "/users" },
			title: "org:7@acme",
		});
		expect(breadcrumbFor(areas, "/connect-settings").area).toBe("Integrations");
	});

	it("names the add flow and a server under Integrations, by name", () => {
		expect(breadcrumbFor(areas, "/mcp-servers/new")).toEqual({
			area: undefined,
			parent: { title: "Integrations", href: "/integrations" },
			title: "Add server",
			named: true,
		});
		expect(breadcrumbFor(areas, "/mcp-servers/github")).toEqual({
			area: undefined,
			parent: { title: "Integrations", href: "/integrations" },
			title: "github",
		});
	});

	it("names an old URL by the page it redirects to", () => {
		expect(breadcrumbFor(areas, "/dashboard")).toEqual({
			area: "Home",
			title: "Overview",
		});
		expect(breadcrumbFor(areas, "/end-users/user_42").title).toBe("Users");
	});

	it("names a URL-only legacy page plainly", () => {
		expect(breadcrumbFor(areas, "/dlq")).toEqual({
			title: "Dead letter queue",
		});
	});
});

describe("the two-level navigation on desktop", () => {
	it("marks the current area in the rail and the current page in the panel", () => {
		mocks.path = "/actions/secrets";
		shell();
		const rail = screen.getByRole("navigation", { name: "Areas" });
		const current = within(rail).getByRole("link", {
			name: "Agents & actions",
		});
		expect(current.getAttribute("aria-current")).toBe("page");
		expect(current.getAttribute("href")).toBe("/actions");
		expect(
			within(rail)
				.getByRole("link", { name: "Activity" })
				.getAttribute("aria-current"),
		).toBeNull();

		const panel = screen.getByRole("navigation", { name: "Agents & actions" });
		const pages = within(panel)
			.getAllByRole("link")
			.map((link) => link.textContent);
		expect(pages).toEqual(["Actions", "Secrets", "Agents"]);
		expect(
			within(panel)
				.getByRole("link", { name: "Secrets" })
				.getAttribute("aria-current"),
		).toBe("page");
	});

	it("shows the page that a URL belongs to, not its first segment", () => {
		mocks.path = "/actions/invocations";
		shell();
		const panel = screen.getByRole("navigation", { name: "Activity" });
		expect(
			within(panel)
				.getByRole("link", { name: "Invocations" })
				.getAttribute("aria-current"),
		).toBe("page");
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"Invocations",
		);
	});

	it("puts the breadcrumb in the top bar as the page's one h1", () => {
		mocks.path = "/users/user_42";
		shell();
		const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
		expect(
			within(crumbs).getByRole("link", { name: "Users" }).getAttribute("href"),
		).toBe("/users");
		expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"user_42",
		);
		expect(document.title).toBe("user_42 · Anlyon");
	});

	it("keeps Settings in the rail, with the pages grouped in the panel", () => {
		mocks.path = "/settings/team";
		shell();
		const panel = screen.getByRole("navigation", { name: "Settings" });
		for (const group of ["Workspace", "Access and audit", "Your account"]) {
			expect(within(panel).getByText(group)).toBeTruthy();
		}
		expect(
			within(panel)
				.getByRole("link", { name: "Team" })
				.getAttribute("aria-current"),
		).toBe("page");
		expect(screen.queryByText("Back to app")).toBeNull();
	});

	it("shows approvals waiting and a halted environment on the rail", () => {
		mocks.pending = 4;
		mocks.halted = true;
		shell();
		const rail = screen.getByRole("navigation", { name: "Areas" });
		expect(
			within(rail).getByRole("link", { name: "Controls, 4 waiting" }),
		).toBeTruthy();
		expect(
			within(rail).getByRole("link", { name: "Settings, needs attention" }),
		).toBeTruthy();
	});

	it("collapses to the rail with Ctrl+B, and the rail then offers search", () => {
		shell();
		expect(screen.queryByRole("button", { name: "Search pages" })).toBeNull();
		act(() => {
			fireEvent.keyDown(window, { key: "b", ctrlKey: true });
		});
		const sidebar = document.querySelector('[data-slot="sidebar"]');
		expect(sidebar?.getAttribute("data-state")).toBe("collapsed");
		expect(screen.getByRole("button", { name: "Search pages" })).toBeTruthy();
	});

	it("collapses to exactly the 56px rail, with nothing beside it", () => {
		shell();
		act(() => {
			fireEvent.keyDown(window, { key: "b", ctrlKey: true });
		});
		const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]');
		expect(
			(wrapper as HTMLElement).style.getPropertyValue("--sidebar-width-icon"),
		).toBe("3.5rem");
		const sidebar = document.querySelector('[data-slot="sidebar"]');
		expect(sidebar?.getAttribute("data-collapsible")).toBe("icon");
		expect(sidebar?.getAttribute("data-variant")).toBe("inset");
		const gap = document.querySelector('[data-slot="sidebar-gap"]');
		expect(gap?.className).toContain(
			"group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
		);
		expect(gap?.className).not.toContain("--spacing(4)");
		const container = document.querySelector('[data-slot="sidebar-container"]');
		expect(container?.className).toContain(
			"group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
		);
		expect(container?.className).toContain(
			"group-data-[collapsible=icon]:px-0",
		);
		expect(container?.className).not.toMatch(/(^|\s)p-2(\s|$)/);
		const inset = document.querySelector('[data-slot="sidebar-inset"]');
		expect(inset?.className).not.toContain("peer-data-[state=collapsed]:ml-2");
		const rail = document.querySelector('[data-slot="nav-rail"]');
		expect(rail?.getAttribute("data-state")).toBe("collapsed");
		expect(rail?.className).toContain("w-14");
		expect(rail?.className).toContain("items-center");
		const panel = document.querySelector('[data-slot="nav-panel"]');
		expect(panel?.className).toContain("group-data-[collapsible=icon]:hidden");
	});

	it("gives every rail item the same centred 40px square", () => {
		mocks.pending = 4;
		mocks.halted = true;
		shell();
		act(() => {
			fireEvent.keyDown(window, { key: "b", ctrlKey: true });
		});
		const rail = screen.getByRole("navigation", { name: "Areas" });
		const items = [
			...within(rail).getAllByRole("link"),
			within(rail).getByRole("button", { name: "Search pages" }),
			within(rail).getByRole("button", { name: /Switch workspace/ }),
			within(rail).getByRole("button", { name: /Your account/ }),
		];
		expect(items.length).toBeGreaterThanOrEqual(9);
		for (const item of items) {
			for (const cls of ["size-10", "items-center", "justify-center"]) {
				expect(item.className.split(/\s+/)).toContain(cls);
			}
		}
		for (const li of rail.querySelectorAll("li")) {
			expect(li.className).toBe("flex");
		}
		const marks = rail.querySelectorAll(
			'[data-slot="rail-badge"], [data-slot="rail-dot"]',
		);
		expect(marks).toHaveLength(2);
		for (const mark of marks) {
			expect(mark.className.split(/\s+/)).toContain("absolute");
			expect(mark.className).toContain("pointer-events-none");
		}
		const current = within(rail).getByRole("link", {
			name: "Agents & actions",
		});
		expect(current.className).toContain("bg-sidebar-active");
		expect(current.className).toContain("size-10");
	});

	it("searches every area's pages from the panel", () => {
		shell();
		const field = screen.getByRole("combobox", { name: "Search pages" });
		fireEvent.change(field, { target: { value: "receipts" } });
		const results = screen.getByRole("listbox");
		expect(within(results).getByRole("option").textContent).toContain(
			"Receipts",
		);
		fireEvent.keyDown(field, { key: "Enter" });
		expect(mocks.navigate).toHaveBeenCalledWith({ to: "/actions/effects" });
	});
});

describe("the navigation on a phone", () => {
	beforeEach(() => {
		mocks.mobile = true;
	});

	it("is one sheet behind the menu button, with the current area open", async () => {
		mocks.path = "/approvals";
		mocks.pending = 2;
		shell();
		expect(screen.queryByRole("navigation", { name: "Areas" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
		const nav = await screen.findByRole("navigation", { name: "Areas" });
		const rows = within(nav)
			.getAllByRole("button")
			.map((row) => row.getAttribute("data-area"));
		expect(rows).toEqual([
			"home",
			"build",
			"integrations",
			"users",
			"controls",
			"activity",
			"settings",
		]);
		expect(
			within(nav)
				.getByRole("link", { name: "Approvals, 2 waiting" })
				.getAttribute("aria-current"),
		).toBe("page");
		expect(within(nav).queryByRole("link", { name: "Invocations" })).toBeNull();
	});

	it("opens another area in place, and closes the sheet on a page", async () => {
		mocks.path = "/approvals";
		shell();
		fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
		const nav = await screen.findByRole("navigation", { name: "Areas" });
		fireEvent.click(within(nav).getByRole("button", { name: "Activity" }));
		const page = await within(nav).findByRole("link", { name: "Invocations" });
		fireEvent.click(page);
		await vi.waitFor(() =>
			expect(screen.queryByRole("navigation", { name: "Areas" })).toBeNull(),
		);
	});
});

describe("the orientation on a first visit", () => {
	const SEEN = "anlyon.orientation.seen.sam@example.com";
	beforeEach(() => {
		window.localStorage.removeItem(SEEN);
	});

	const note = () => screen.findByRole("dialog", {}, { timeout: 3000 });
	const pause = (ms: number) =>
		new Promise((resolve) => setTimeout(resolve, ms));

	it("points at the rail's areas one at a time, then never again", async () => {
		const { unmount } = shell();
		const first = await note();
		expect(within(first).getByText("1 of 5")).toBeTruthy();
		const titles = [within(first).getByRole("heading").textContent];
		for (let i = 0; i < 4; i++) {
			fireEvent.click(screen.getByRole("button", { name: "Next" }));
			titles.push(
				within(screen.getByRole("dialog")).getByRole("heading").textContent,
			);
		}
		expect(titles).toEqual([
			"Agents & actions",
			"Integrations",
			"Users",
			"Controls",
			"Activity",
		]);
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(window.localStorage.getItem(SEEN)).toBe("1");
		unmount();
		shell();
		await pause(1000);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("says what Controls holds, and goes away with Esc", async () => {
		shell();
		await note();
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(
			within(screen.getByRole("dialog")).getByText(
				/The rules your agent runs under/,
			),
		).toBeTruthy();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(window.localStorage.getItem(SEEN)).toBe("1");
	});

	it("is not shown on a phone, where every area is labelled", async () => {
		mocks.mobile = true;
		shell();
		await pause(1000);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(window.localStorage.getItem(SEEN)).toBeNull();
	});
});
