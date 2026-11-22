/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/auth/login-form";
import { SignupForm } from "@/components/auth/signup-form";
import { addServerSearch } from "@/lib/mcp-server-link";
import { safeReturnPath } from "@/lib/security";

const mocks = vi.hoisted(() => ({
	session: null as unknown,
	signInEmail: vi.fn(),
	signUpEmail: vi.fn(),
	social: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
	authClient: {
		getSession: async () => ({ data: mocks.session }),
		signIn: { email: mocks.signInEmail, social: mocks.social },
		signUp: { email: mocks.signUpEmail },
		oneTap: vi.fn(),
	},
}));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: () => false,
	getRateLimitResetTime: () => 0,
}));
vi.mock("@/components/layout/app-layout", () => ({ AppLayout: () => null }));
vi.mock("@/components/global-banners", () => ({ GlobalBanners: () => null }));
vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({}),
	WorkspaceProvider: () => null,
}));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => "connected" }));

const PAGE = "/mcp-servers/new?server=linear&ref=anlyon-com";
const SEARCH = { server: "linear", ref: "anlyon-com" };

async function appAt(start: string) {
	const { Route: Protected } = await import("@/routes/_protected");
	const root = createRootRoute();
	const guard = Protected.options.beforeLoad as unknown as () => void;
	const page = createRoute({
		getParentRoute: () => root,
		path: "/mcp-servers/new",
		beforeLoad: guard,
		validateSearch: addServerSearch,
		component: () => <h1>Add an MCP server</h1>,
	});
	const dashboard = createRoute({
		getParentRoute: () => root,
		path: "/dashboard",
		component: () => <h1>Dashboard</h1>,
	});
	const getStarted = createRoute({
		getParentRoute: () => root,
		path: "/get-started",
		component: () => <h1>Get started</h1>,
	});
	const redirectSearch = (search: Record<string, unknown>) =>
		typeof search.redirect === "string" ? { redirect: search.redirect } : {};
	const login = createRoute({
		getParentRoute: () => root,
		path: "/auth/login",
		validateSearch: redirectSearch,
		component: function Login() {
			return <LoginForm redirectTo={login.useSearch().redirect} />;
		},
	});
	const signup = createRoute({
		getParentRoute: () => root,
		path: "/auth/signup",
		validateSearch: redirectSearch,
		component: function Signup() {
			return <SignupForm redirectTo={signup.useSearch().redirect} />;
		},
	});
	const router = createRouter({
		routeTree: root.addChildren([page, dashboard, getStarted, login, signup]),
		history: createMemoryHistory({ initialEntries: [start] }),
	});
	render(
		<QueryClientProvider client={new QueryClient()}>
			<RouterProvider router={router as never} />
		</QueryClientProvider>,
	);
	await waitFor(() => expect(router.state.status).toBe("idle"));
	return router;
}

const type = (label: string, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } });

const PASSWORD = "Str0ng!pass";

function fillLogin() {
	type("Email", "a@example.com");
	type("Password", PASSWORD);
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

function fillSignup() {
	type("Name", "Ada");
	type("Email", "a@example.com");
	type("Password", PASSWORD);
	type("Confirm Password", PASSWORD);
	fireEvent.click(screen.getByRole("button", { name: "Get started" }));
}

async function follow(
	router: { navigate: (o: { href: string }) => Promise<void> },
	name: RegExp,
) {
	const link = screen.getByRole("link", { name }) as HTMLAnchorElement;
	await router.navigate({ href: link.getAttribute("href") ?? "" });
}

beforeEach(() => {
	mocks.session = null;
	mocks.signInEmail.mockImplementation(async () => {
		mocks.session = { user: { id: "u" } };
		return { data: { user: { id: "u" } } };
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("a signed-out visitor following a link to the add flow", () => {
	it("is sent to log in with the whole URL kept", async () => {
		const router = await appAt(PAGE);
		await screen.findByLabelText("Email");
		expect(router.state.location.pathname).toBe("/auth/login");
		expect(
			(router.state.location.search as { redirect: string }).redirect,
		).toBe(PAGE);
	});

	it("returns to the same URL after logging in", async () => {
		const router = await appAt(PAGE);
		await screen.findByLabelText("Email");
		fillLogin();
		await screen.findByRole("heading", { name: "Add an MCP server" });
		expect(router.state.location.href).toBe(PAGE);
		expect(router.state.location.search).toEqual(SEARCH);
	});

	it("keeps it on the way to sign-up, and returns after signing up with a session", async () => {
		mocks.signUpEmail.mockImplementation(async () => {
			mocks.session = { user: { id: "u" } };
			return { data: { token: "t" } };
		});
		const router = await appAt(PAGE);
		await screen.findByLabelText("Email");
		await follow(router, /sign up/i);
		await screen.findByLabelText("Confirm Password");
		fillSignup();
		await screen.findByRole("heading", { name: "Add an MCP server" });
		expect(router.state.location.href).toBe(PAGE);
		expect(router.state.location.search).toEqual(SEARCH);
	});

	it("sends the page in the verification email when signing up needs a verified address", async () => {
		mocks.signUpEmail.mockResolvedValue({ data: { token: null } });
		const router = await appAt(PAGE);
		await screen.findByLabelText("Email");
		await follow(router, /sign up/i);
		await screen.findByLabelText("Confirm Password");
		fillSignup();
		await screen.findByText("Check your email");
		expect(mocks.signUpEmail).toHaveBeenCalledWith(
			expect.objectContaining({ callbackURL: PAGE }),
		);
	});

	it("keeps it going back from sign-up to log in", async () => {
		const router = await appAt(PAGE);
		await screen.findByLabelText("Email");
		await follow(router, /sign up/i);
		await screen.findByLabelText("Confirm Password");
		await follow(router, /log in/i);
		await screen.findByLabelText("Email");
		fillLogin();
		await screen.findByRole("heading", { name: "Add an MCP server" });
		expect(router.state.location.href).toBe(PAGE);
	});

	it("carries it through a social sign-in's callback", async () => {
		mocks.social.mockResolvedValue({});
		await appAt(PAGE);
		await screen.findByLabelText("Email");
		fireEvent.click(screen.getByRole("button", { name: /Google/ }));
		await waitFor(() =>
			expect(mocks.social).toHaveBeenCalledWith(
				expect.objectContaining({
					callbackURL: `${window.location.origin}${PAGE}`,
				}),
			),
		);
	});
});

describe("with no return page", () => {
	it("logging in goes to the dashboard, and signing up to the first-run journey", async () => {
		const router = await appAt("/auth/login");
		await screen.findByLabelText("Email");
		fillLogin();
		await screen.findByRole("heading", { name: "Dashboard" });
		expect(router.state.location.pathname).toBe("/dashboard");
		cleanup();

		mocks.signUpEmail.mockResolvedValue({ data: { token: "t" } });
		const again = await appAt("/auth/signup");
		await screen.findByLabelText("Confirm Password");
		fillSignup();
		await screen.findByRole("heading", { name: "Get started" });
		expect(again.state.location.pathname).toBe("/get-started");
		expect(mocks.signUpEmail).toHaveBeenCalledWith(
			expect.not.objectContaining({ callbackURL: expect.anything() }),
		);
	});
});

describe("a redirect that leaves the console", () => {
	it.each([
		"https://evil.example/mcp-servers/new",
		"//evil.example/x",
		"/\\evil.example/x",
		"javascript:alert(1)",
	])("%s is not followed", async (redirect) => {
		expect(safeReturnPath(redirect)).toBeNull();
		const router = await appAt(
			`/auth/login?redirect=${encodeURIComponent(redirect)}`,
		);
		await screen.findByLabelText("Email");
		fillLogin();
		await screen.findByRole("heading", { name: "Dashboard" });
		expect(router.state.location.pathname).toBe("/dashboard");
	});
});

describe("safeReturnPath", () => {
	it("keeps a page on this console, with its query", () => {
		expect(safeReturnPath(PAGE)).toBe(PAGE);
		expect(safeReturnPath(`${window.location.origin}${PAGE}`)).toBe(PAGE);
		expect(safeReturnPath(undefined)).toBeNull();
		expect(safeReturnPath("")).toBeNull();
		expect(safeReturnPath("mcp-servers/new")).toBeNull();
	});

	it("refuses a path that only becomes protocol-relative once its dot segments are removed", () => {
		for (const value of [
			"/.//evil.com",
			"/..//evil.com",
			"/%2e//evil.com",
			"/%2E%2E//evil.com",
			"/a/..//evil.com",
			`${window.location.origin}//evil.com`,
			`${window.location.origin}/.//evil.com`,
			"//evil.com",
			"/\\evil.com",
		]) {
			expect(safeReturnPath(value), value).toBeNull();
		}
		expect(safeReturnPath("/a/../dashboard")).toBe("/dashboard");
	});
});
