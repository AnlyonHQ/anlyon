/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	oauthGrantKeys,
	useOAuthGrants,
	useRevokeOAuthGrant,
	useUpdateOAuthGrantEnvironment,
} from "./use-oauth-grants";

vi.mock("@/components/ui/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const data =
				init?.method === "POST"
					? {
							workspaceId: "workspace-1",
							environmentId: "environment-staging",
						}
					: { grants: [] };

			return new Response(JSON.stringify({ success: true, data }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
});

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);

	return { queryClient, wrapper };
}

describe("useOAuthGrants", () => {
	it("loads grants from the unversioned OAuth route", async () => {
		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useOAuthGrants(), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const requestUrl = vi.mocked(fetch).mock.calls[0]?.[0];
		expect(new URL(String(requestUrl)).pathname).toBe("/api/oauth/grants");
	});
});

describe("useUpdateOAuthGrantEnvironment", () => {
	it("rebinds only the selected OAuth client and refreshes grants", async () => {
		const { queryClient, wrapper } = createWrapper();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const { result } = renderHook(() => useUpdateOAuthGrantEnvironment(), {
			wrapper,
		});

		act(() => {
			result.current.mutate({
				clientId: "claude-client",
				workspaceId: "workspace-1",
				environmentId: "environment-staging",
			});
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const [requestUrl, request] = vi.mocked(fetch).mock.calls[0] ?? [];
		expect(new URL(String(requestUrl)).pathname).toBe(
			"/api/oauth/workspace-binding",
		);
		expect(request).toEqual(
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					clientId: "claude-client",
					workspaceId: "workspace-1",
					environmentId: "environment-staging",
				}),
			}),
		);
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: oauthGrantKeys.all,
		});
	});
});

describe("useRevokeOAuthGrant", () => {
	it("disconnects the selected client through the unversioned OAuth route", async () => {
		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useRevokeOAuthGrant(), { wrapper });

		act(() => {
			result.current.mutate("claude-client");
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const [requestUrl, request] = vi.mocked(fetch).mock.calls[0] ?? [];
		expect(new URL(String(requestUrl)).pathname).toBe(
			"/api/oauth/grants/claude-client",
		);
		expect(request).toEqual(expect.objectContaining({ method: "DELETE" }));
	});
});
