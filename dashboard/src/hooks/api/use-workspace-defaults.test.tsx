/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSaveWorkspaceDefaults } from "./use-workspace-defaults";

vi.mock("@/components/ui/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ success: true, data: {} }), {
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

const requests = () =>
	vi.mocked(fetch).mock.calls.map(([input, init]) => ({
		path: new URL(String(input)).pathname,
		body: init?.body ? JSON.parse(String(init.body)) : undefined,
	}));

describe("saving workspace defaults", () => {
	it("names where in the console the change was made, for the audit record", async () => {
		const { result } = renderHook(
			() =>
				useSaveWorkspaceDefaults("ws_1", {
					source: "defaults_page",
					successMessage: null,
				}),
			{ wrapper },
		);
		await act(() =>
			result.current.mutateAsync({ defaults: { approvalWindowHours: 4 } }),
		);
		expect(requests()).toEqual([
			{
				path: "/api/v2/workspaces/ws_1/defaults",
				body: { approvalWindowHours: 4, source: "defaults_page" },
			},
		]);
	});

	it("sends no defaults request when no answer there changed", async () => {
		const { result } = renderHook(
			() =>
				useSaveWorkspaceDefaults("ws_1", {
					source: "setup_journey",
					successMessage: null,
				}),
			{ wrapper },
		);
		await act(() =>
			result.current.mutateAsync({
				defaults: {},
				preferences: { emailEnabled: false },
			}),
		);
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(requests().map((request) => request.path)).toEqual([
			"/api/v2/notifications/preferences",
		]);
	});
});
