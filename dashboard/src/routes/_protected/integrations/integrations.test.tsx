/* @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpUpstream } from "@/hooks/api/use-mcp-upstreams";
import { ApiError } from "@/lib/api-client";
import type { ConsentClientFactory } from "@/lib/consent";
import type { OperationsApi } from "@/lib/packs";
import type {
	ConnectionIntegration,
	ConnectSession,
	Secret,
} from "@/lib/types";

const mocks = vi.hoisted(() => ({
	createSession: vi.fn(),
	complete: vi.fn(),
	connectWithKey: vi.fn(),
	check: vi.fn(),
	reconnect: vi.fn(),
	deleteSecret: vi.fn(),
	integrations: [] as unknown[],
	connections: [] as unknown[],
	environments: [] as unknown[],
	servers: [] as unknown[],
	mcpOn: false,
	serversError: false,
	navigate: vi.fn(),
}));

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => true,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: Record<string, unknown>) => options,
	useNavigate: () => mocks.navigate,
	Link: ({ children }: { children: React.ReactNode }) => (
		<a href="/">{children}</a>
	),
}));

vi.mock("@anlyon/feature-flags", async (importOriginal) => ({
	...(await importOriginal<typeof import("@anlyon/feature-flags")>()),
	isFeatureEnabled: (feature: string) =>
		feature === "mcp-upstreams" ? mocks.mcpOn : true,
}));

vi.mock("@/hooks/api/use-mcp-upstreams", () => ({
	useMcpUpstreams: () => ({
		data: mocks.serversError ? undefined : mocks.servers,
		isLoading: false,
		isError: mocks.serversError,
		error: mocks.serversError ? new Error("unavailable") : null,
	}),
}));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "workspace-1" } }),
}));

vi.mock("@/components/defaults/defaults-hint", () => ({
	ConnectionBrokenHint: () => null,
}));
vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({ data: mocks.environments, isLoading: false }),
}));

vi.mock("@/hooks/api/use-end-users", () => ({
	useEndUsers: () => ({
		data: { data: [], pagination: { nextCursor: null } },
		isLoading: false,
	}),
	useCreateEndUserConnectLink: () => ({ mutate: vi.fn(), isPending: false }),
	useEnvironmentOAuthApp: () => ({ data: undefined, isLoading: false }),
	useSaveEnvironmentOAuthApp: () => ({ mutate: vi.fn(), isPending: false }),
	useDeleteEnvironmentOAuthApp: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/api/use-actions", () => ({
	useDeleteSecret: () => ({ mutate: mocks.deleteSecret, isPending: false }),
}));

vi.mock("@/hooks/api/use-connections", () => ({
	useIntegrationRoute: (_workspaceId: string, name: string) => ({
		data: {
			query: name,
			name,
			route: {
				kind: "openapi",
				why: `If ${name} publishes an OpenAPI spec, import it.`,
				next: { summary: "Import it." },
			},
			alternatives: [],
			tellUs: "mailto:support@anlyon.com",
		},
		isError: false,
	}),
	useConnections: () => ({
		data: mocks.connections,
		isLoading: false,
		isError: false,
	}),
	useConnectionsOverview: () => ({
		data: (mocks.integrations as Array<Record<string, unknown>>).map(
			(entry) => ({
				connectable: true,
				signIn:
					(entry.auth as { kind?: string } | undefined)?.kind === "api_key"
						? null
						: {
								app: "anlyon",
								redirectUri:
									"https://api.anlyon.com/api/v2/connection-consent/callback",
							},
				workspace: { connected: 0, needsAttention: 0 },
				endUsers: { connected: 0, needsReconnect: 0 },
				...entry,
			}),
		),
		isLoading: false,
		isError: false,
	}),
	useCreateConnectSession: () => ({
		mutateAsync: mocks.createSession,
		isPending: false,
	}),
	useCompleteConnectSession: () => ({
		mutateAsync: mocks.complete,
		isPending: false,
	}),
	useConnectWithApiKey: () => ({
		mutateAsync: mocks.connectWithKey,
		isPending: false,
	}),
	useCheckConnection: () => ({ mutate: mocks.check, isPending: false }),
	useReconnectConnection: () => ({
		mutateAsync: mocks.reconnect,
		isPending: false,
	}),
}));

import { ConnectAccountDialog, ConnectionsPage } from "./index";

const hubspot: ConnectionIntegration = {
	id: "hubspot",
	name: "HubSpot",
	hosts: ["api.hubapi.com"],
	hostsFromAccount: false,
	scopes: ["crm.objects.contacts.write"],
	operationsPack: "anlyon/hubspot",
	workflowPacks: [],
};

const session: ConnectSession = {
	sessionId: "csn_abcdef123456",
	sessionToken: "tok",
	expiresAt: "2999-01-01T00:00:00.000Z",
	connectUrl:
		"https://api.anlyon.com/api/v2/connection-consent/start?token=tok",
	integration: hubspot,
};

const secret: Secret = {
	id: "sec_1",
	name: "HUBSPOT",
	description: null,
	allowedHosts: ["api.hubapi.com"],
	kind: "connection",
	connection: { integrationId: "hubspot", status: "active" },
	lastUsedAt: null,
	createdAt: "2026-10-11T00:00:00.000Z",
	updatedAt: "2026-10-11T00:00:00.000Z",
};

const emptyWorkspace = {
	getAction: async () => null,
	listPolicies: async () => [],
	listLimits: async () => [],
} as unknown as OperationsApi;

type FakeWindow = { closed: boolean; close: () => void };

function consentOpening(...windows: Array<FakeWindow | null>) {
	const open = vi.fn(() =>
		windows.length > 0
			? (windows.shift() ?? null)
			: { closed: false, close: vi.fn() },
	);
	return { open, factory: () => ({ open, pollIntervalMs: 1 }) };
}

async function openAndConnect(factory: ConsentClientFactory) {
	render(
		<ConnectAccountDialog workspaceId="workspace-1" consentClient={factory} />,
	);
	fireEvent.click(screen.getByRole("button", { name: "Connect an account" }));
	fireEvent.change(await screen.findByLabelText("Integration"), {
		target: { value: "hubspot" },
	});
	expect(screen.getByLabelText("Secret name")).toHaveProperty(
		"value",
		"HUBSPOT",
	);
	expect(screen.getByText(/crm\.objects\.contacts\.write/)).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}

describe("Connect an account dialog", () => {
	beforeEach(() => {
		mocks.integrations = [hubspot];
		mocks.connections = [];
		mocks.environments = [];
		mocks.createSession.mockReset().mockResolvedValue(session);
		mocks.complete
			.mockReset()
			.mockResolvedValue({ status: "completed", secret });
	});
	afterEach(cleanup);

	it("creates the session, opens its connect URL, waits for Anlyon to record the account and shows the new secret", async () => {
		mocks.complete
			.mockResolvedValueOnce({ status: "pending", secret: null })
			.mockResolvedValueOnce({ status: "completed", secret });
		const consent = consentOpening();
		await openAndConnect(consent.factory);
		expect(await screen.findByText("Connected as HUBSPOT")).toBeTruthy();
		expect(mocks.createSession).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			integrationId: "hubspot",
			secretName: "HUBSPOT",
			description: undefined,
		});
		expect(consent.open).toHaveBeenCalledWith(session.connectUrl);
		expect(mocks.complete).toHaveBeenCalledTimes(2);
		expect(mocks.complete).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			sessionId: "csn_abcdef123456",
		});
	});

	it("continues to the operations of the connected account, then to adding them to the agent", async () => {
		render(
			<ConnectAccountDialog
				workspaceId="workspace-1"
				consentClient={consentOpening().factory}
				operationsApi={emptyWorkspace}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Connect an account" }));
		fireEvent.change(await screen.findByLabelText("Integration"), {
			target: { value: "hubspot" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(await screen.findByText("Connected as HUBSPOT")).toBeTruthy();
		const operations = await screen.findByRole("list", { name: "Writes" });
		expect(operations.textContent).toContain("hubspot-update-contact-stage");
		fireEvent.click(
			screen.getByRole("button", { name: "Next: add to your agent" }),
		);
		expect(await screen.findByText("No operations are on yet")).toBeTruthy();
	});

	it("a blocked popup offers to open it again from a click, which then completes", async () => {
		const consent = consentOpening(null);
		await openAndConnect(consent.factory);
		expect(
			await screen.findByText("The sign-in window was blocked"),
		).toBeTruthy();
		expect(mocks.complete).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "Open the sign-in window" }),
		);
		expect(await screen.findByText("Connected as HUBSPOT")).toBeTruthy();
		expect(consent.open).toHaveBeenCalledTimes(2);
		expect(mocks.createSession).toHaveBeenCalledTimes(1);
	});

	it("keeps waiting when the window reads closed, since a provider page can sever it", async () => {
		mocks.complete
			.mockResolvedValueOnce({ status: "pending", secret: null })
			.mockResolvedValueOnce({ status: "completed", secret });
		await openAndConnect(
			consentOpening({ closed: true, close: vi.fn() }).factory,
		);
		expect(await screen.findByText("Connected as HUBSPOT")).toBeTruthy();
	});

	it("a declined sign-in shows Anlyon's message and saves nothing", async () => {
		mocks.complete.mockRejectedValue(
			new ApiError(
				"The account was not connected: access was not approved at the provider. Start again.",
				400,
				"VALIDATION_ERROR",
			),
		);
		await openAndConnect(consentOpening().factory);
		expect(
			await screen.findByText(/access was not approved at the provider/),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
	});

	it("Cancel stops waiting for the sign-in", async () => {
		mocks.complete.mockResolvedValue({ status: "pending", secret: null });
		await openAndConnect(consentOpening().factory);
		expect(
			await screen.findByText(/Waiting for you to approve access/),
		).toBeTruthy();
		await waitFor(() => expect(mocks.complete).toHaveBeenCalled());
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(
				screen.queryByText(/Waiting for you to approve access/),
			).toBeNull(),
		);
		const calls = mocks.complete.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(mocks.complete.mock.calls.length).toBeLessThanOrEqual(calls + 1);
	});

	it("an expired session says so", async () => {
		mocks.complete.mockRejectedValue(
			new ApiError("expired", 410, "CONNECTION_SESSION_EXPIRED"),
		);
		await openAndConnect(consentOpening().factory);
		expect(await screen.findByText("The session expired")).toBeTruthy();
	});

	it("a provider error shows Anlyon's code", async () => {
		mocks.createSession.mockRejectedValue(
			new ApiError(
				"The connected-account service could not start a session. Try again shortly.",
				502,
				"CONNECTION_PROVIDER_ERROR",
			),
		);
		await openAndConnect(consentOpening().factory);
		expect(
			await screen.findByText(/\(CONNECTION_PROVIDER_ERROR\)/),
		).toBeTruthy();
	});

	it("validates the secret name before anything is sent", async () => {
		render(
			<ConnectAccountDialog
				workspaceId="workspace-1"
				consentClient={consentOpening().factory}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Connect an account" }));
		fireEvent.change(await screen.findByLabelText("Integration"), {
			target: { value: "hubspot" },
		});
		fireEvent.change(screen.getByLabelText("Secret name"), {
			target: { value: "bad-name" },
		});
		expect(screen.getByRole("alert").textContent).toMatch(/Uppercase letters/);
		expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty(
			"disabled",
			true,
		);
		expect(mocks.createSession).not.toHaveBeenCalled();
	});

	it("says so when nothing can be connected yet", async () => {
		mocks.integrations = [];
		render(<ConnectAccountDialog workspaceId="workspace-1" />);
		fireEvent.click(screen.getByRole("button", { name: "Connect an account" }));
		expect(
			await screen.findByText(/No integrations can be connected/),
		).toBeTruthy();
	});
});

const github: ConnectionIntegration = {
	id: "github",
	name: "GitHub",
	auth: {
		kind: "api_key",
		instructions: "Create a fine-grained token with Issues: Read and write.",
		instructionsUrl: "https://github.com/settings/personal-access-tokens/new",
	},
	hosts: ["api.github.com"],
	hostsFromAccount: false,
	scopes: [],
	operationsPack: "anlyon/github",
	workflowPacks: [],
};

const githubSecret: Secret = {
	id: "sec_gh",
	name: "GITHUB",
	description: null,
	allowedHosts: ["api.github.com"],
	kind: "static",
	connection: null,
	integrationId: "github",
	lastUsedAt: null,
	createdAt: "2026-10-13T00:00:00.000Z",
	updatedAt: "2026-10-13T00:00:00.000Z",
};

describe("Connecting with an API key", () => {
	const KEY = "fixture-github-token-not-a-key-0000";

	beforeEach(() => {
		mocks.createSession.mockReset();
		mocks.connectWithKey.mockReset();
		mocks.integrations = [hubspot, github];
		mocks.connections = [];
		mocks.environments = [];
	});
	afterEach(cleanup);

	function openGithub() {
		render(
			<ConnectAccountDialog
				workspaceId="workspace-1"
				integrationId="github"
				operationsApi={emptyWorkspace}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Connect an account" }));
	}

	it("shows the provider's instructions and a key field, and no sign-in", async () => {
		openGithub();
		expect(await screen.findByText(/fine-grained token/)).toBeTruthy();
		expect(
			screen.getByRole("link", { name: /creating a key/ }).getAttribute("href"),
		).toBe("https://github.com/settings/personal-access-tokens/new");
		const field = screen.getByLabelText("API key");
		expect(field.getAttribute("type")).toBe("password");
		expect(field.getAttribute("autocomplete")).toBe("off");
		expect(
			screen.getByText(/may only be sent to: api\.github\.com/),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty(
			"disabled",
			true,
		);
	});

	it("sends the key once, shows the connected secret, and starts no consent session", async () => {
		mocks.connectWithKey.mockResolvedValue(githubSecret);
		openGithub();
		fireEvent.change(await screen.findByLabelText("API key"), {
			target: { value: `  ${KEY}  ` },
		});
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(await screen.findByText("Connected as GITHUB")).toBeTruthy();
		expect(mocks.connectWithKey).toHaveBeenCalledTimes(1);
		expect(mocks.connectWithKey).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			integrationId: "github",
			secretName: "GITHUB",
			apiKey: KEY,
			description: undefined,
		});
		expect(mocks.createSession).not.toHaveBeenCalled();
		expect(document.body.innerHTML).not.toContain(KEY);
		expect(await screen.findByRole("list", { name: "Writes" })).toBeTruthy();
	});

	it("asks for each field of a key made of several values, shows the account's host, and sends them as fields", async () => {
		const TOKEN = "fixture-zendesk-token-not-a-key-00";
		const desk: ConnectionIntegration = {
			id: "zendesk",
			name: "Zendesk",
			auth: {
				kind: "api_key",
				instructions:
					"In Zendesk Admin Center, turn on token access and add an API token.",
				instructionsUrl:
					"https://support.zendesk.com/hc/en-us/articles/4408889192858",
				fields: [
					{
						name: "subdomain",
						label: "Zendesk subdomain",
						secret: false,
						kind: "account",
					},
					{
						name: "email",
						label: "Agent email",
						secret: false,
						kind: "credential",
					},
					{
						name: "apiToken",
						label: "API token",
						secret: true,
						kind: "credential",
					},
				],
			},
			hosts: null,
			hostsFromAccount: true,
			hostTemplate: "{subdomain}.zendesk.com",
			scopes: [],
			operationsPack: null,
			workflowPacks: [],
		};
		mocks.integrations = [desk];
		mocks.connectWithKey.mockResolvedValue({
			...githubSecret,
			name: "ZENDESK",
			integrationId: "zendesk",
			allowedHosts: ["acme.zendesk.com"],
		});
		render(
			<ConnectAccountDialog
				workspaceId="workspace-1"
				integrationId="zendesk"
				operationsApi={emptyWorkspace}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Connect an account" }));

		expect(screen.queryByLabelText("API key")).toBeNull();
		expect(
			screen.getByText(
				/may only be sent to: your account's own host, \{subdomain\}\.zendesk\.com/,
			),
		).toBeTruthy();
		expect(screen.getByLabelText("API token").getAttribute("type")).toBe(
			"password",
		);
		expect(screen.getByLabelText("Agent email").getAttribute("type")).toBe(
			"text",
		);
		fireEvent.change(screen.getByLabelText("Zendesk subdomain"), {
			target: { value: "acme" },
		});
		expect(screen.getByText("acme.zendesk.com")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Agent email"), {
			target: { value: "ana@acme.test" },
		});
		expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty(
			"disabled",
			true,
		);
		fireEvent.change(screen.getByLabelText("API token"), {
			target: { value: ` ${TOKEN} ` },
		});
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(await screen.findByText("Connected as ZENDESK")).toBeTruthy();
		expect(mocks.connectWithKey).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			integrationId: "zendesk",
			secretName: "ZENDESK",
			fields: { subdomain: "acme", email: "ana@acme.test", apiToken: TOKEN },
			description: undefined,
		});
		expect(document.body.innerHTML).not.toContain(TOKEN);
	});

	it("signs in by default to an integration that also takes a key, and connects with a token on request", async () => {
		const TOKEN = "fixture-github-token-not-a-key-0000";
		mocks.integrations = [
			{
				...github,
				auth: {
					kind: "oauth",
					apiKey: {
						instructions:
							"Create a fine-grained token with Issues: Read and write.",
						instructionsUrl:
							"https://github.com/settings/personal-access-tokens/new",
					},
				},
				scopes: ["repo"],
			},
		];
		mocks.connectWithKey.mockResolvedValue(githubSecret);
		render(
			<ConnectAccountDialog
				workspaceId="workspace-1"
				integrationId="github"
				operationsApi={emptyWorkspace}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Connect an account" }));

		expect(screen.queryByLabelText("API key")).toBeNull();
		expect(screen.getByText(/Access Anlyon asks for: repo/)).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: "Use a token instead" }),
		);
		expect(screen.getByText(/fine-grained token/)).toBeTruthy();
		fireEvent.change(screen.getByLabelText("API key"), {
			target: { value: TOKEN },
		});
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(await screen.findByText("Connected as GITHUB")).toBeTruthy();
		expect(mocks.connectWithKey).toHaveBeenCalledWith(
			expect.objectContaining({ integrationId: "github", apiKey: TOKEN }),
		);
		expect(mocks.createSession).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("button", { name: "Sign in at GitHub instead" }),
		).toBeNull();
	});

	it("says so when the provider does not accept the key, and lets the person try again", async () => {
		mocks.connectWithKey.mockRejectedValue(
			new ApiError(
				"GitHub did not accept that key. Nothing was saved.",
				422,
				"CONNECTION_KEY_REJECTED",
			),
		);
		openGithub();
		fireEvent.change(await screen.findByLabelText("API key"), {
			target: { value: KEY },
		});
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(
			await screen.findByText(
				/did not accept that key.*CONNECTION_KEY_REJECTED/,
			),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
	});

	it("refuses a key with a space in it before anything is sent", async () => {
		openGithub();
		fireEvent.change(await screen.findByLabelText("API key"), {
			target: { value: "two words" },
		});
		expect(screen.getByRole("alert").textContent).toMatch(/whole key/);
		expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty(
			"disabled",
			true,
		);
		expect(mocks.connectWithKey).not.toHaveBeenCalled();
	});

	it("lists an account connected with a key under its integration", async () => {
		mocks.connections = [githubSecret];
		render(<ConnectionsPage operationsApi={emptyWorkspace} />);
		expect(screen.getByText("1 account")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
		expect(
			await screen.findByRole("button", { name: "Operations for GITHUB" }),
		).toBeTruthy();
		expect(
			screen.getByRole("heading", { name: "How you connect" }),
		).toBeTruthy();
		cleanup();
		render(
			<ConnectionsPage
				onSelect={vi.fn()}
				operationsApi={emptyWorkspace}
				selectedId="github"
				tab="actions"
			/>,
		);
		expect(screen.getByText("github-create-issue")).toBeTruthy();
	});
});

describe("Checking and reconnecting, for a key and for a sign-in alike", () => {
	const KEY = "fixture-github-token-renewed-1111";
	const deadKey: Secret = {
		...githubSecret,
		health: {
			status: "needs_reauth",
			checkedAt: "2026-10-15T08:00:00.000Z",
			reason: "key_rejected",
		},
	};
	const deadSignin: Secret = {
		...secret,
		connection: { integrationId: "hubspot", status: "needs_reauth" },
		health: {
			status: "needs_reauth",
			checkedAt: "2026-10-15T08:00:00.000Z",
			reason: "access_revoked",
		},
	};

	beforeEach(() => {
		mocks.check.mockReset();
		mocks.reconnect.mockReset();
		mocks.complete.mockReset();
		mocks.integrations = [hubspot, github];
		mocks.environments = [];
	});
	afterEach(cleanup);

	it("shows why an account stopped working, and when it was last checked", async () => {
		mocks.connections = [deadKey];
		render(<ConnectionsPage operationsApi={emptyWorkspace} />);
		expect(screen.getByText("1 to reconnect")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
		expect(
			await screen.findByText(/The provider refused the stored key/),
		).toBeTruthy();
		expect(screen.getByText(/checked /)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Check GITHUB" })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Reconnect GITHUB" }),
		).toBeTruthy();
	});

	it("Check asks the provider and announces the answer", async () => {
		mocks.connections = [githubSecret];
		mocks.check.mockImplementation(
			(_input: unknown, options: { onSuccess: (checked: Secret) => void }) =>
				options.onSuccess({
					...githubSecret,
					health: {
						status: "needs_reauth",
						checkedAt: "2026-10-15T09:00:00.000Z",
						reason: "key_rejected",
					},
				}),
		);
		render(<ConnectionsPage operationsApi={emptyWorkspace} />);
		fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Check GITHUB" }),
		);
		expect(mocks.check).toHaveBeenCalledWith(
			{ workspaceId: "workspace-1", secretName: "GITHUB" },
			expect.anything(),
		);
		expect(await screen.findByText(/GITHUB no longer works/)).toBeTruthy();
	});

	it("Reconnect on a key account asks for the new key only, and keeps the name", async () => {
		mocks.connections = [deadKey];
		mocks.reconnect.mockResolvedValue({
			status: "completed",
			secret: {
				...githubSecret,
				health: {
					status: "active",
					checkedAt: "2026-10-15T09:00:00.000Z",
					reason: null,
				},
			},
			session: null,
		});
		render(<ConnectionsPage operationsApi={emptyWorkspace} />);
		fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Reconnect GITHUB" }),
		);
		expect(
			await screen.findByRole("heading", { name: "Reconnect GITHUB" }),
		).toBeTruthy();
		expect(screen.queryByLabelText("Secret name")).toBeNull();
		expect(screen.queryByLabelText("Description (optional)")).toBeNull();
		expect(screen.getAllByText(/fine-grained token/).length).toBeGreaterThan(1);
		fireEvent.change(screen.getByLabelText("API key"), {
			target: { value: KEY },
		});
		fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
		expect(await screen.findByText("Reconnected GITHUB")).toBeTruthy();
		expect(mocks.reconnect).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			secretName: "GITHUB",
			apiKey: KEY,
		});
		expect(mocks.connectWithKey).not.toHaveBeenCalled();
		expect(document.body.innerHTML).not.toContain(KEY);
	});

	it("Reconnect on a sign-in account opens the consent window again and completes the session", async () => {
		mocks.connections = [deadSignin];
		mocks.reconnect.mockResolvedValue({
			status: "pending",
			secret: null,
			session,
		});
		mocks.complete.mockResolvedValue({
			status: "completed",
			secret: {
				...secret,
				health: {
					status: "active",
					checkedAt: "2026-10-15T09:00:00.000Z",
					reason: null,
				},
			},
		});
		const consent = consentOpening();
		render(
			<ConnectionsPage
				consentClient={consent.factory}
				operationsApi={emptyWorkspace}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /HubSpot/ }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Reconnect HUBSPOT" }),
		);
		expect(
			await screen.findByRole("heading", { name: "Reconnect HUBSPOT" }),
		).toBeTruthy();
		expect(screen.queryByLabelText("API key")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
		expect(await screen.findByText("Reconnected HUBSPOT")).toBeTruthy();
		expect(mocks.reconnect).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			secretName: "HUBSPOT",
		});
		expect(consent.open).toHaveBeenCalledWith(session.connectUrl);
		expect(mocks.complete).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			sessionId: "csn_abcdef123456",
		});
		expect(mocks.createSession).not.toHaveBeenCalled();
	});
});

describe("Integrations page", () => {
	afterEach(cleanup);

	it("shows the empty state when nothing can be connected and nothing is", () => {
		mocks.connections = [];
		mocks.integrations = [];
		render(<ConnectionsPage />);
		expect(screen.getByText("No integrations yet")).toBeTruthy();
	});

	it("lists what can be connected, filters by search, and connects from an integration's panel", async () => {
		mocks.connections = [];
		mocks.integrations = [hubspot];
		mocks.createSession.mockReset();
		mocks.complete.mockReset();
		mocks.createSession.mockResolvedValue(session);
		mocks.complete.mockResolvedValue({ status: "completed", secret });
		const { factory } = consentOpening();
		render(
			<ConnectionsPage
				consentClient={factory}
				operationsApi={emptyWorkspace}
			/>,
		);
		expect(screen.getByText("1 service")).toBeTruthy();
		fireEvent.click(screen.getByRole("radio", { name: "In use" }));
		expect(screen.getByText("Nothing is connected yet.")).toBeTruthy();
		fireEvent.click(screen.getByRole("radio", { name: "All" }));

		const search = screen.getByLabelText("Search integrations");
		fireEvent.change(search, { target: { value: "zzz" } });
		expect(screen.getByText(/No integration matches/)).toBeTruthy();
		expect(await screen.findByText(/publishes an OpenAPI spec/)).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
		fireEvent.change(search, { target: { value: "crm" } });

		fireEvent.click(screen.getByRole("button", { name: /HubSpot/ }));
		expect(
			await screen.findByText("No account is connected yet."),
		).toBeTruthy();
		for (const tab of ["Your account", "Your users", "Sign-in", "Actions"]) {
			expect(screen.getByRole("link", { name: new RegExp(tab) })).toBeTruthy();
		}

		fireEvent.click(screen.getByRole("button", { name: "Connect HubSpot" }));
		expect(await screen.findByLabelText("Secret name")).toHaveProperty(
			"value",
			"HUBSPOT",
		);
		expect(screen.queryByLabelText("Integration")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(await screen.findByText("Connected as HUBSPOT")).toBeTruthy();
		expect(mocks.createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				integrationId: "hubspot",
				secretName: "HUBSPOT",
			}),
		);
	});

	it("an integration's panel manages its accounts, and needs confirmation to disconnect in a protected environment", async () => {
		mocks.environments = [
			{ id: "env_1", name: "Production", isDefault: true, isProtected: true },
		];
		mocks.connections = [secret];
		mocks.deleteSecret.mockReset();
		mocks.integrations = [hubspot];
		render(<ConnectionsPage operationsApi={emptyWorkspace} />);
		expect(screen.getByText("1 account")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /HubSpot/ }));
		expect(
			await screen.findByRole("button", { name: "Operations for HUBSPOT" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Add to your agent for HUBSPOT" }),
		).toBeTruthy();
		expect(screen.getByText("api.hubapi.com")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Connect another account" }),
		).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Disconnect HUBSPOT" }));
		const disconnect = await screen.findByRole("button", {
			name: "Disconnect",
		});
		expect(disconnect).toHaveProperty("disabled", true);
		fireEvent.click(screen.getByRole("checkbox"));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Disconnect" })).toHaveProperty(
				"disabled",
				false,
			),
		);
		fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
		expect(mocks.deleteSecret).toHaveBeenCalledWith({
			name: "HUBSPOT",
			workspaceId: "workspace-1",
			confirmProtected: true,
		});
	});

	it("an account whose integration is not offered here can be disconnected but not extended", async () => {
		mocks.environments = [];
		mocks.connections = [
			{
				...secret,
				id: "sec_2",
				name: "SLACK",
				connection: { integrationId: "slack", status: "needs_reauth" },
			},
		];
		mocks.integrations = [hubspot];
		render(<ConnectionsPage operationsApi={emptyWorkspace} />);
		expect(screen.getByText("1 to reconnect")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /slack/i }));
		expect(
			await screen.findByRole("button", { name: "Disconnect SLACK" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Operations for SLACK" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: /Connect another account/ }),
		).toBeNull();
		expect(screen.getByText(/New accounts cannot be connected/)).toBeTruthy();
	});
});

const mcpServer = (over: Partial<McpUpstream>): McpUpstream => ({
	id: "ups_1",
	name: "server",
	url: "https://mcp.example.test/mcp",
	headers: {},
	registryName: null,
	protocolVersion: null,
	serverInfo: null,
	tools: [],
	toolsHash: null,
	listedAt: null,
	lastError: null,
	listedWith: null,
	oauth: null,
	adopted: [],
	archivedAt: null,
	createdAt: "2026-11-01T10:00:00.000Z",
	updatedAt: "2026-11-01T10:00:00.000Z",
	...over,
});

describe("Services", () => {
	afterEach(() => {
		cleanup();
		mocks.mcpOn = false;
		mocks.servers = [];
		mocks.navigate.mockReset();
	});

	it("lists a service once with every way to connect, and says what an agent gets", () => {
		mocks.mcpOn = true;
		mocks.connections = [];
		mocks.integrations = [hubspot, github];
		render(<ConnectionsPage operationsApi={emptyWorkspace} />);
		const row = (name: string) =>
			screen.getByRole("button", { name }).closest("tr") as HTMLElement;
		expect(screen.getAllByRole("button", { name: "GitHub" })).toHaveLength(1);
		expect(within(row("GitHub")).getByText("Full toolset")).toBeTruthy();
		expect(
			within(row("GitHub")).getByText("API key · MCP server"),
		).toBeTruthy();
		expect(within(row("Figma")).getByText("Via MCP")).toBeTruthy();
		expect(within(row("Figma")).getByText("MCP server")).toBeTruthy();
		expect(screen.getByText("Any remote MCP server")).toBeTruthy();
		expect(screen.getByText("Any HTTP API")).toBeTruthy();
	});

	it("opens the add flow for a vendor's server, prefilled from the checked list", () => {
		mocks.mcpOn = true;
		mocks.connections = [];
		mocks.integrations = [hubspot];
		render(<ConnectionsPage operationsApi={emptyWorkspace} />);
		fireEvent.click(screen.getByRole("button", { name: "Figma" }));
		expect(mocks.navigate).toHaveBeenCalledWith({
			to: "/mcp-servers/new",
			search: { server: "figma" },
		});
	});

	it("lists the servers already added, and counts their services as in use", () => {
		mocks.mcpOn = true;
		mocks.connections = [];
		mocks.integrations = [hubspot];
		mocks.servers = [
			mcpServer({ name: "design", url: "https://MCP.figma.com/mcp/" }),
		];
		render(<ConnectionsPage operationsApi={emptyWorkspace} />);
		expect(
			screen.getByRole("heading", { name: "Your MCP servers" }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("radio", { name: /In use/ }));
		expect(screen.getByRole("button", { name: "Figma" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "HubSpot" })).toBeNull();
	});

	it("shows no MCP ways, servers or vendors where MCP servers are off", () => {
		mocks.connections = [];
		mocks.integrations = [github];
		render(<ConnectionsPage operationsApi={emptyWorkspace} />);
		expect(screen.getByText("1 service")).toBeTruthy();
		expect(screen.queryByText("Via MCP")).toBeNull();
		expect(screen.queryByText("Any remote MCP server")).toBeNull();
		expect(screen.getByText("Any HTTP API")).toBeTruthy();
	});

	it("opens the server already added for a vendor instead of adding it again", () => {
		mocks.mcpOn = true;
		mocks.connections = [];
		mocks.integrations = [hubspot];
		mocks.servers = [
			mcpServer({ name: "design", url: "https://mcp.figma.com/mcp" }),
		];
		render(<ConnectionsPage operationsApi={emptyWorkspace} />);
		fireEvent.click(screen.getByRole("button", { name: "Figma" }));
		expect(mocks.navigate).toHaveBeenCalledWith({
			to: "/mcp-servers/$name",
			params: { name: "design" },
		});
	});

	it("finds a service by its vendor's name", () => {
		mocks.mcpOn = true;
		mocks.connections = [];
		mocks.integrations = [hubspot];
		render(<ConnectionsPage operationsApi={emptyWorkspace} />);
		fireEvent.change(screen.getByLabelText("Search integrations"), {
			target: { value: "atlassian" },
		});
		expect(screen.getByRole("button", { name: "Confluence" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "HubSpot" })).toBeNull();
	});

	it("says when the MCP servers could not be loaded", () => {
		mocks.mcpOn = true;
		mocks.serversError = true;
		mocks.connections = [];
		mocks.integrations = [hubspot];
		render(<ConnectionsPage operationsApi={emptyWorkspace} />);
		expect(
			screen.getByText("Your MCP servers could not be loaded"),
		).toBeTruthy();
		mocks.serversError = false;
	});

	it("names a service's other ways in from an integration's page", () => {
		mocks.mcpOn = true;
		mocks.connections = [];
		mocks.integrations = [github];
		render(
			<ConnectionsPage
				onSelect={vi.fn()}
				operationsApi={emptyWorkspace}
				selectedId="github"
			/>,
		);
		expect(screen.getByText(/Also connects through/)).toBeTruthy();
		expect(screen.getByText("GitHub MCP server")).toBeTruthy();
	});
});

describe("An integration's other tabs", () => {
	afterEach(cleanup);

	it("Your users and Sign-in show the end users' side and the app people sign in with", () => {
		mocks.environments = [
			{
				id: "env_1",
				name: "Production",
				isDefault: true,
				isProtected: true,
				defaultRedirectUrl: "https://app.acme.test/connected",
			},
		];
		mocks.connections = [];
		mocks.integrations = [hubspot];
		render(
			<ConnectionsPage onSelect={vi.fn()} selectedId="hubspot" tab="users" />,
		);
		expect(
			screen.getByRole("heading", { name: "Ready for your users" }),
		).toBeTruthy();
		expect(screen.getByText(/Users sign in with Anlyon's app/)).toBeTruthy();
		expect(screen.getByText("No user has connected yet")).toBeTruthy();
		cleanup();
		render(
			<ConnectionsPage onSelect={vi.fn()} selectedId="hubspot" tab="sign-in" />,
		);
		expect(screen.getByRole("heading", { name: "Sign-in app" })).toBeTruthy();
		expect(screen.getByText("crm.objects.contacts.write")).toBeTruthy();
	});
});
