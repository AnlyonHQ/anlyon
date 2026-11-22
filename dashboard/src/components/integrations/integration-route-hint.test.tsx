/* @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationRouteResult } from "@/lib/types";
import { IntegrationRouteHint } from "./integration-route-hint";

const mocks = vi.hoisted(() => ({
	mcpEnabled: true,
	answer: { data: undefined, isError: false } as {
		data: unknown;
		isError: boolean;
	},
	useRoute: vi.fn(),
}));

vi.mock("@anlyon/feature-flags", async (importOriginal) => ({
	...(await importOriginal<typeof import("@anlyon/feature-flags")>()),
	isFeatureEnabled: (key: string) =>
		key === "mcp-upstreams" ? mocks.mcpEnabled : true,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({
		to,
		search,
		children,
		className,
	}: {
		to: string;
		search?: Record<string, string | undefined>;
		children?: React.ReactNode;
		className?: string;
	}) => {
		const query = new URLSearchParams(
			Object.entries(search ?? {}).filter(([, value]) => value) as [
				string,
				string,
			][],
		).toString();
		return (
			<a className={className} href={`${to}${query ? `?${query}` : ""}`}>
				{children}
			</a>
		);
	},
}));

vi.mock("@/hooks/api/use-connections", () => ({
	useIntegrationRoute: (workspaceId: string, name: string) => {
		mocks.useRoute(workspaceId, name);
		return mocks.answer;
	},
}));

const FIGMA: IntegrationRouteResult = {
	query: "figma",
	name: "Figma",
	route: {
		kind: "mcp",
		why: "Figma publishes its own MCP server, so you can govern it with MCP.",
		next: {
			summary: "Add mcp.figma.com as an MCP server.",
			command: "anlyon mcp add https://mcp.figma.com/mcp",
			url: "https://console/mcp-servers/new?url=x",
		},
		mcp: {
			registryName: "com.figma.mcp/mcp",
			url: "https://mcp.figma.com/mcp",
			host: "mcp.figma.com",
			publisher: { verifiedBy: "domain", namespace: "com.figma.mcp" },
			report: "https://anlyon.dev/servers/com.figma.mcp/mcp",
		},
	},
	alternatives: [
		{
			kind: "openapi",
			why: "If Figma publishes an OpenAPI spec, import it.",
			next: { summary: "Import it." },
		},
		{
			kind: "custom_action",
			why: "Any HTTPS API can be an action.",
			next: {
				summary: "Declare one.",
				docs: "https://docs.anlyon.com/guides/any-http-api",
			},
		},
	],
	tellUs: "mailto:support@anlyon.com?subject=Integration%20request%3A%20Figma",
};

const hrefOf = (name: string) =>
	screen.getByRole("link", { name }).getAttribute("href");

beforeEach(() => {
	mocks.mcpEnabled = true;
	mocks.answer = { data: undefined, isError: false };
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("the hint under a search with no match", () => {
	it("says why, shows the host, and routes to the add flow with the address filled in", async () => {
		mocks.answer = { data: FIGMA, isError: false };
		render(<IntegrationRouteHint name="figma" workspaceId="w" />);

		await screen.findByText(/govern it with MCP/);
		expect(screen.getByText("mcp.figma.com")).toBeTruthy();
		expect(hrefOf("Add its MCP server")).toBe("/mcp-servers/new?server=figma");
		expect(hrefOf("Import an OpenAPI spec")).toBe(
			"/actions?import=openapi&vendor=Figma",
		);
		expect(hrefOf("Declare a custom action")).toBe(
			"https://docs.anlyon.com/guides/any-http-api",
		);
		expect(hrefOf("Tell us")).toBe(FIGMA.tellUs);
	});

	it("is inline: no dialog opens", async () => {
		mocks.answer = { data: FIGMA, isError: false };
		render(<IntegrationRouteHint name="figma" workspaceId="w" />);
		await screen.findByText(/govern it with MCP/);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("routes an unknown name to an OpenAPI import with the vendor filled in", async () => {
		mocks.answer = {
			data: {
				query: "Acme CRM",
				name: "Acme CRM",
				route: {
					kind: "openapi",
					why: "If Acme CRM publishes an OpenAPI spec, import it.",
					next: { summary: "Import it." },
				},
				alternatives: [
					{
						kind: "mcp_address",
						why: "If Acme CRM runs one, add it.",
						next: { summary: "Add it." },
					},
				],
				tellUs: "mailto:support@anlyon.com",
			},
			isError: false,
		};
		render(<IntegrationRouteHint name="Acme CRM" workspaceId="w" />);
		await screen.findByText(/If Acme CRM publishes/);
		expect(hrefOf("Import an OpenAPI spec")).toBe(
			"/actions?import=openapi&vendor=Acme+CRM",
		);
		expect(hrefOf("Add an MCP server by address")).toBe("/mcp-servers/new");
	});

	it("shows server text as text, never as markup", async () => {
		mocks.answer = {
			data: {
				...FIGMA,
				name: "<img src=x onerror=alert(1)>",
				route: {
					...FIGMA.route,
					why: "<img src=x onerror=alert(1)> wants you to click.",
				},
			},
			isError: false,
		};
		const { container } = render(
			<IntegrationRouteHint name="x" workspaceId="w" />,
		);
		await screen.findByText(/wants you to click/);
		expect(container.querySelector("img")).toBeNull();
	});

	it("still offers a way on when the question could not be answered", async () => {
		mocks.answer = { data: undefined, isError: true };
		render(<IntegrationRouteHint name="figma" workspaceId="w" />);
		await screen.findByText(/Import its OpenAPI spec/);
		expect(screen.getByRole("link", { name: "ask for it" })).toBeTruthy();
	});

	it("does not ask until the typing stops", async () => {
		mocks.answer = { data: FIGMA, isError: false };
		const { rerender } = render(
			<IntegrationRouteHint name="f" workspaceId="w" />,
		);
		rerender(<IntegrationRouteHint name="fi" workspaceId="w" />);
		rerender(<IntegrationRouteHint name="fig" workspaceId="w" />);
		expect(mocks.useRoute).not.toHaveBeenCalledWith("w", "fig");
		await waitFor(() =>
			expect(mocks.useRoute).toHaveBeenCalledWith("w", "fig"),
		);
		expect(mocks.useRoute).not.toHaveBeenCalledWith("w", "fi");
	});
});

describe("with the mcp-upstreams flag off", () => {
	it("never links to the add flow, even if an older API still answers with it", async () => {
		mocks.mcpEnabled = false;
		mocks.answer = { data: FIGMA, isError: false };
		const { container } = render(
			<IntegrationRouteHint name="figma" workspaceId="w" />,
		);
		await screen.findByText(/govern it with MCP/);
		expect(
			screen.queryByRole("link", { name: "Add its MCP server" }),
		).toBeNull();
		expect(container.innerHTML).not.toContain("/mcp-servers");
		expect(hrefOf("Import an OpenAPI spec")).toBe(
			"/actions?import=openapi&vendor=Figma",
		);
	});
});
