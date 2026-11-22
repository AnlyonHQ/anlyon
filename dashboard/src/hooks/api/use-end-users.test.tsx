/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	useEndUserConnections,
	useEndUsers,
	useEnvironmentOAuthApp,
	useEraseEndUser,
	useRevokeEndUserConnection,
	useSaveConnectSettings,
	useSaveEnvironmentOAuthApp,
} from "./use-end-users";

vi.mock("@/components/ui/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

let answer: unknown = [];

beforeEach(() => {
	answer = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ success: true, data: answer }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		),
	);
});

function wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

function lastRequest() {
	const [input, init] = vi.mocked(fetch).mock.calls.at(-1) ?? [];
	const url = new URL(String(input));
	const headers = (init?.headers ?? {}) as Record<string, string>;
	return {
		url,
		method: init?.method,
		body: init?.body ? JSON.parse(String(init.body)) : undefined,
		workspace: headers["X-Workspace-Id"],
	};
}

describe("end-user reads", () => {
	it("lists a page of end users in the chosen environment", async () => {
		const { result } = renderHook(
			() => useEndUsers("workspace-1", "env-prod", "cur_2", "user_"),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		const request = lastRequest();
		expect(request.url.pathname).toBe("/api/v2/end-users");
		expect(request.url.searchParams.get("environmentId")).toBe("env-prod");
		expect(request.url.searchParams.get("cursor")).toBe("cur_2");
		expect(request.url.searchParams.get("prefix")).toBe("user_");
		expect(request.workspace).toBe("workspace-1");
	});

	it("encodes the end user's id in the path", async () => {
		const { result } = renderHook(
			() => useEndUserConnections("workspace-1", undefined, "org:7/user@x"),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		const request = lastRequest();
		expect(request.url.pathname).toBe(
			"/api/v2/end-users/org%3A7%2Fuser%40x/connections",
		);
		expect(request.url.searchParams.has("environmentId")).toBe(false);
	});

	it("reads an OAuth app per environment and integration", async () => {
		answer = {
			integration: "gmail",
			configured: false,
			clientId: null,
			redirectUri: "https://api.anlyon.com/oauth/callback",
			updatedAt: null,
		};
		const { result } = renderHook(
			() => useEnvironmentOAuthApp("workspace-1", "env-prod", "gmail"),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(lastRequest().url.pathname).toBe(
			"/api/v2/environments/env-prod/oauth-apps/gmail",
		);
	});
});

describe("end-user changes", () => {
	it("revokes one connection", async () => {
		const { result } = renderHook(
			() => useRevokeEndUserConnection("workspace-1", "env-prod"),
			{ wrapper },
		);
		await act(() =>
			result.current.mutateAsync({ endUserId: "u_1", integration: "slack" }),
		);
		const request = lastRequest();
		expect(request.method).toBe("DELETE");
		expect(request.url.pathname).toBe(
			"/api/v2/end-users/u_1/connections/slack",
		);
		expect(request.url.searchParams.get("environmentId")).toBe("env-prod");
	});

	it("erases an end user", async () => {
		const { result } = renderHook(
			() => useEraseEndUser("workspace-1", undefined),
			{ wrapper },
		);
		await act(() => result.current.mutateAsync({ endUserId: "u_1" }));
		const request = lastRequest();
		expect(request.method).toBe("DELETE");
		expect(request.url.pathname).toBe("/api/v2/end-users/u_1");
	});

	it("sends the client secret on save and nothing else", async () => {
		const { result } = renderHook(
			() => useSaveEnvironmentOAuthApp("workspace-1", "env-prod"),
			{ wrapper },
		);
		await act(() =>
			result.current.mutateAsync({
				integration: "hubspot",
				clientId: "client-1",
				clientSecret: "shh",
			}),
		);
		const request = lastRequest();
		expect(request.method).toBe("PUT");
		expect(request.url.pathname).toBe(
			"/api/v2/environments/env-prod/oauth-apps/hubspot",
		);
		expect(request.body).toEqual({ clientId: "client-1", clientSecret: "shh" });
	});

	it("saves redirect URLs on the environment", async () => {
		const { result } = renderHook(() => useSaveConnectSettings("workspace-1"), {
			wrapper,
		});
		await act(() =>
			result.current.mutateAsync({
				environmentId: "env-prod",
				allowedRedirectUrls: ["https://app.acme.com/settings"],
				defaultRedirectUrl: "https://app.acme.com/settings",
			}),
		);
		const request = lastRequest();
		expect(request.method).toBe("PATCH");
		expect(request.url.pathname).toBe(
			"/api/v2/workspaces/workspace-1/environments/env-prod",
		);
		expect(request.body).toEqual({
			allowedRedirectUrls: ["https://app.acme.com/settings"],
			defaultRedirectUrl: "https://app.acme.com/settings",
		});
	});
});

describe("connect confirmation", () => {
	it("sends only the setting that changed", async () => {
		const { result } = renderHook(() => useSaveConnectSettings("workspace-1"), {
			wrapper,
		});
		await act(() =>
			result.current.mutateAsync({
				environmentId: "env-dev",
				connectConfirmation: "off",
			}),
		);
		expect(lastRequest().body).toEqual({ connectConfirmation: "off" });
	});
});
