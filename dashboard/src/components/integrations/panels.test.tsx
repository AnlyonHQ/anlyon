/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import type {
	Environment,
	EnvironmentOAuthApp,
	IntegrationOverview,
} from "@/lib/types";

const mocks = vi.hoisted(() => ({
	apps: {} as Record<string, unknown>,
	users: [] as unknown[],
	nextCursor: null as string | null,
	saveApp: vi.fn(),
	deleteApp: vi.fn(),
	createLink: vi.fn(),
	usersArgs: [] as unknown[],
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({ children }: { children: React.ReactNode }) => (
		<a href="/">{children}</a>
	),
}));

vi.mock("@/hooks/api/use-end-users", () => ({
	useEnvironmentOAuthApp: (_w: string, _e: string, integration: string) => ({
		data: mocks.apps[integration] ?? {
			integration,
			configured: false,
			clientId: null,
			redirectUri: "https://api.anlyon.com/api/v2/connection-consent/callback",
			updatedAt: null,
		},
		isLoading: false,
		isError: false,
	}),
	useSaveEnvironmentOAuthApp: () => ({
		mutate: mocks.saveApp,
		isPending: false,
	}),
	useDeleteEnvironmentOAuthApp: () => ({
		mutate: mocks.deleteApp,
		isPending: false,
	}),
	useEndUsers: (...args: unknown[]) => {
		mocks.usersArgs = args;
		return {
			data: { data: mocks.users, pagination: { nextCursor: mocks.nextCursor } },
			isLoading: false,
			isFetching: false,
		};
	},
	useCreateEndUserConnectLink: () => ({
		mutate: mocks.createLink,
		isPending: false,
	}),
}));

import { SignInPanel } from "./sign-in-app";
import { UsersPanel } from "./users-panel";

const counts = {
	workspace: { connected: 0, needsAttention: 0 },
	endUsers: { connected: 0, needsReconnect: 0 },
};

const gmail: IntegrationOverview = {
	id: "gmail",
	name: "Gmail",
	auth: { kind: "oauth" },
	hosts: ["gmail.googleapis.com"],
	hostsFromAccount: false,
	scopes: ["https://www.googleapis.com/auth/gmail.send"],
	operationsPack: null,
	workflowPacks: [],
	connectable: false,
	signIn: {
		app: "own_required",
		redirectUri: "https://api.anlyon.com/api/v2/connection-consent/callback",
	},
	...counts,
};

const hubspot: IntegrationOverview = {
	...gmail,
	id: "hubspot",
	name: "HubSpot",
	scopes: ["crm.objects.contacts.write"],
	connectable: true,
	signIn: { ...gmail.signIn!, app: "anlyon" },
};

const github: IntegrationOverview = {
	...gmail,
	id: "github",
	name: "GitHub",
	auth: {
		kind: "api_key",
		instructions: "Create a fine-grained token.",
		instructionsUrl: "https://github.com/settings/tokens",
	},
	scopes: [],
	connectable: true,
	signIn: null,
	endUsers: { connected: 2, needsReconnect: 0 },
};

const production = {
	id: "env-prod",
	name: "Production",
	kind: "production",
	isDefault: true,
	isProtected: true,
	defaultRedirectUrl: "https://app.acme.test/connected",
	connectConfirmation: "required",
} as Environment;

beforeEach(() => {
	mocks.apps = {};
	mocks.users = [];
	mocks.nextCursor = null;
	mocks.saveApp.mockReset();
	mocks.deleteApp.mockReset();
	mocks.createLink.mockReset();
});
afterEach(cleanup);

describe("Sign-in", () => {
	it("says Anlyon has no app of its own yet, and saves the developer's", () => {
		render(
			<SignInPanel
				canManage
				environmentId="env-prod"
				integration={gmail}
				workspaceId="workspace-1"
			/>,
		);
		expect(
			screen.getByText(/Anlyon does not offer its own Gmail app yet/),
		).toBeTruthy();
		expect(
			screen.getByText(/Google requires your own app in production/),
		).toBeTruthy();
		expect(
			screen.getByText("https://www.googleapis.com/auth/gmail.send"),
		).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: "Use your own Gmail app" }),
		);
		const secret = screen.getByLabelText("Client secret") as HTMLInputElement;
		expect(secret.type).toBe("password");
		fireEvent.change(screen.getByLabelText("Client id"), {
			target: { value: "123.apps.googleusercontent.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save app" }));
		expect(screen.getByRole("alert").textContent).toBe(
			"Enter the client secret.",
		);
		fireEvent.change(secret, { target: { value: "GOCSPX-secret" } });
		fireEvent.click(screen.getByRole("button", { name: "Save app" }));
		expect(mocks.saveApp.mock.calls[0][0]).toEqual({
			integration: "gmail",
			clientId: "123.apps.googleusercontent.com",
			clientSecret: "GOCSPX-secret",
		});
	});

	it("shows a saved app by its client id, never a secret, and removes it after a named confirm", async () => {
		mocks.apps.hubspot = {
			integration: "hubspot",
			configured: true,
			clientId: "hub-client-1",
			redirectUri: "https://api.anlyon.com/api/v2/connection-consent/callback",
			updatedAt: "2026-10-20T00:00:00.000Z",
		} satisfies EnvironmentOAuthApp;
		render(
			<SignInPanel
				canManage
				environmentId="env-prod"
				integration={{ ...hubspot, signIn: { ...hubspot.signIn!, app: "own" } }}
				workspaceId="workspace-1"
			/>,
		);
		expect(screen.getByText("hub-client-1")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Remove your HubSpot app" }),
		);
		expect(
			await screen.findByRole("heading", { name: "Remove your HubSpot app?" }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Remove app" }));
		expect(mocks.deleteApp).toHaveBeenCalledWith({ integration: "hubspot" });
	});

	it("offers no changes without permission to manage connections", () => {
		render(
			<SignInPanel
				canManage={false}
				environmentId="env-prod"
				integration={hubspot}
				workspaceId="workspace-1"
			/>,
		);
		expect(
			screen.getByText(/People sign in with Anlyon's HubSpot app/),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Use your own/ })).toBeNull();
	});
});

describe("Your users", () => {
	it("says a key integration needs no app, shows how to connect a user, and lists who did", () => {
		mocks.users = [
			{
				endUserId: "user_1",
				connections: 1,
				invocations: 4,
				pendingApprovals: 0,
			},
			{
				endUserId: "user_2",
				connections: 2,
				invocations: 0,
				pendingApprovals: 1,
			},
		];
		render(
			<UsersPanel
				canManage
				environment={production}
				integration={github}
				workspaceId="workspace-1"
			/>,
		);
		expect(screen.getByText(/No OAuth app needed/)).toBeTruthy();
		expect(screen.getByText("https://app.acme.test/connected")).toBeTruthy();
		expect(
			screen.getByText(/anlyon\.endUsers\.createConnectLink/),
		).toBeTruthy();
		expect(screen.getByText("user_1")).toBeTruthy();
		expect(screen.getByText("user_2")).toBeTruthy();
		expect(mocks.usersArgs).toEqual([
			"workspace-1",
			"env-prod",
			undefined,
			undefined,
			"github",
		]);
	});

	it("points to the Sign-in tab while the integration needs the developer's app", () => {
		const openSignIn = vi.fn();
		render(
			<UsersPanel
				canManage
				environment={production}
				integration={gmail}
				onOpenSignIn={openSignIn}
				workspaceId="workspace-1"
			/>,
		);
		expect(
			screen.getByText("Add your own Gmail OAuth app first."),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Add your app" }));
		expect(openSignIn).toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Create link" })).toBeNull();
	});

	it("asks for a redirect URL before a link can come back anywhere", () => {
		render(
			<UsersPanel
				canManage
				environment={{ ...production, defaultRedirectUrl: null }}
				integration={hubspot}
				workspaceId="workspace-1"
			/>,
		);
		expect(screen.getByText(/Set a redirect URL/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Create link" })).toBeNull();
	});

	it("makes a link for a user id and shows it, or says why not", () => {
		mocks.createLink.mockImplementation(
			(_input: unknown, options: { onSuccess: (link: unknown) => void }) =>
				options.onSuccess({
					url: "https://api.anlyon.com/api/v2/connection-consent/link?token=cst_1",
					expiresAt: "2999-01-01T00:00:00.000Z",
					integration: "hubspot",
				}),
		);
		render(
			<UsersPanel
				canManage
				environment={production}
				integration={hubspot}
				workspaceId="workspace-1"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Create link" }));
		expect(screen.getByRole("alert").textContent).toBe(
			"Enter the user's id in your app.",
		);
		fireEvent.change(screen.getByLabelText("User id in your app"), {
			target: { value: "user_9" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create link" }));
		expect(mocks.createLink.mock.calls[0][0]).toEqual({
			endUserId: "user_9",
			integration: "hubspot",
		});
		expect(
			screen.getByText(
				"https://api.anlyon.com/api/v2/connection-consent/link?token=cst_1",
			),
		).toBeTruthy();

		mocks.createLink.mockImplementation(
			(_input: unknown, options: { onError: (error: Error) => void }) =>
				options.onError(
					new ApiError("Too many links.", 429, "RATE_LIMIT_EXCEEDED"),
				),
		);
		fireEvent.click(screen.getByRole("button", { name: "Create link" }));
		expect(screen.getByRole("alert").textContent).toBe(
			"Too many links. (RATE_LIMIT_EXCEEDED)",
		);
	});
});
