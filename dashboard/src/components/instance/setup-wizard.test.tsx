/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	pending: true,
	status: undefined as unknown,
	settings: undefined as unknown,
	health: { api: true, database: true, redis: false } as unknown,
	verify: vi.fn(),
	create: vi.fn(),
	signIn: vi.fn(),
	confirm: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
		<a href={to}>{children}</a>
	),
}));
vi.mock("@/lib/runtime-config", () => ({
	isSelfHosted: () => true,
	consoleEdition: () => "community",
	configuredEdition: () => "community",
	runtimeConfig: {},
}));
vi.mock("@/lib/auth-client", () => ({
	authClient: { signIn: { email: mocks.signIn } },
}));
vi.mock("@/hooks/api/use-instance", () => ({
	instanceKeys: { setup: ["setup"] },
	isForbidden: () => false,
	useSetupPending: () => ({ data: mocks.pending, isLoading: false }),
	useInstanceStatus: (enabled = true) => ({
		data: enabled ? mocks.status : undefined,
		isLoading: false,
		error: null,
	}),
	useInstanceSettings: (enabled = true) => ({
		data: enabled ? mocks.settings : undefined,
	}),
	useServerHealth: () => ({
		data: mocks.health,
		dataUpdatedAt: Date.now(),
		isFetching: false,
		isError: false,
	}),
	useInstanceAdmins: () => ({ data: [] }),
	useConfirmRootKeyBackup: () => ({ mutate: mocks.confirm, isPending: false }),
	useUpdateInstanceSettings: () => ({ mutate: vi.fn(), isPending: false }),
	useSendTestEmail: () => ({ mutate: vi.fn(), isPending: false }),
	useTestStorage: () => ({ mutate: vi.fn(), isPending: false }),
	usePreviewLicense: () => ({ mutate: vi.fn(), isPending: false }),
	useTelemetryPreview: () => ({ data: undefined }),
	useGrantInstanceAdmin: () => ({ mutate: vi.fn(), isPending: false }),
	useRevokeInstanceAdmin: () => ({ mutate: vi.fn(), isPending: false }),
	verifySetupToken: mocks.verify,
	createSetupOwner: mocks.create,
}));

import { SetupWizard } from "./setup-wizard";

const STATUS = {
	edition: "community",
	setupCompletedAt: null,
	rootKey: {
		inUse: true,
		derivedKeys: [],
		backupConfirmedAt: null,
		backupConfirmedBy: null,
	},
	telemetry: { enabled: true, endpoint: "" },
};

function renderWizard() {
	const client = new QueryClient();
	return render(
		<QueryClientProvider client={client}>
			<SetupWizard />
		</QueryClientProvider>,
	);
}

function fill(label: string | RegExp, value: string) {
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("SetupWizard", () => {
	beforeEach(() => {
		mocks.pending = true;
		mocks.status = STATUS;
		mocks.settings = [];
		mocks.verify.mockReset().mockResolvedValue({ valid: true });
		mocks.create
			.mockReset()
			.mockResolvedValue({ userId: "u", workspaceId: "w" });
		mocks.signIn.mockReset().mockResolvedValue({ error: null });
		mocks.confirm.mockReset();
	});

	it("shows the live server status, with Redis down, before anything else", () => {
		renderWizard();
		const status = screen.getByRole("region", { name: "Server status" });
		expect(status.textContent).toContain("Not reachable");
		expect(status.textContent).toContain("After sign-in");
		expect(screen.getByText("1/4")).toBeTruthy();
	});

	it("validates inline and sends nothing until the form is right", async () => {
		renderWizard();
		fill("Setup token", "tok");
		fill("Email", "sam@");
		fill("Password", "short");
		fireEvent.click(screen.getByRole("button", { name: /Create owner/ }));
		expect(await screen.findByText("Enter your name")).toBeTruthy();
		expect(screen.getByText("Not an email address")).toBeTruthy();
		expect(screen.getByText("7 more characters")).toBeTruthy();
		expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe(
			"true",
		);
		expect(mocks.verify).not.toHaveBeenCalled();
	});

	it("creates the owner, signs in and moves to the root key", async () => {
		renderWizard();
		fill("Setup token", "tok_123");
		fill("Your name", "Sam");
		fill("Email", "sam@example.com");
		fill("Password", "correct horse battery");
		fill("Confirm password", "correct horse battery");
		fireEvent.click(screen.getByRole("button", { name: /Create owner/ }));
		expect(await screen.findByText("Keep a copy of the root key")).toBeTruthy();
		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({ token: "tok_123", email: "sam@example.com" }),
		);
		expect(mocks.signIn).toHaveBeenCalled();
		expect(
			screen.getByText("sudo grep ANLYON_ROOT_KEY /opt/anlyon/.env"),
		).toBeTruthy();
	});

	it("a wrong token says so and stays on the form", async () => {
		mocks.verify.mockResolvedValue({ valid: false });
		renderWizard();
		fill("Setup token", "nope");
		fill("Your name", "Sam");
		fill("Email", "sam@example.com");
		fill("Password", "correct horse battery");
		fill("Confirm password", "correct horse battery");
		fireEvent.click(screen.getByRole("button", { name: /Create owner/ }));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"not this server's",
		);
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("resumes at the root key after a reload, once the owner exists", async () => {
		mocks.pending = false;
		renderWizard();
		expect(await screen.findByText("Keep a copy of the root key")).toBeTruthy();
		const confirm = screen.getByRole("button", { name: "Continue" });
		expect((confirm as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(screen.getByText(/I have a copy/));
		await waitFor(() =>
			expect((confirm as HTMLButtonElement).disabled).toBe(false),
		);
		fireEvent.click(confirm);
		expect(mocks.confirm).toHaveBeenCalledTimes(1);
	});

	it("an install already set up, with the copy confirmed, offers to sign in", () => {
		mocks.pending = false;
		mocks.status = undefined;
		renderWizard();
		expect(screen.getByText("This server is set up")).toBeTruthy();
		expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
	});
});
