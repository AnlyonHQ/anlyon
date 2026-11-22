/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStartHere } from "./use-start-here";

vi.mock("@anlyon/feature-flags", () => ({ isFeatureEnabled: () => true }));
vi.mock("@/components/ui/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

let server: Record<string, { data: unknown; pagination?: unknown }> = {};

beforeEach(() => {
	server = {};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			const env = url.searchParams.get("environmentId");
			const key = env ? `${url.pathname}?${env}` : url.pathname;
			const hit = Object.entries(server).find(([path]) => key.endsWith(path));
			const body = hit ? hit[1] : { data: [] };
			return new Response(JSON.stringify({ success: true, ...body }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
});

function wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

const env = (id: string, defaultRedirectUrl: string | null = null) => ({
	id,
	name: id,
	defaultRedirectUrl,
});
const users = (...rows: [string, number, number][]) => ({
	data: rows.map(([endUserId, connections, invocations]) => ({
		endUserId,
		connections,
		invocations,
		pendingApprovals: 0,
	})),
	pagination: { nextCursor: null },
});

describe("useStartHere", () => {
	it("reads a brand-new workspace as nothing done", async () => {
		server = {
			"/workspaces/ws_1/api-keys": { data: [] },
			"/workspaces/ws_1/environments": { data: [env("env_prod")] },
			"/actions": { data: [] },
			"/end-users?env_prod": users(),
		};
		const { result } = renderHook(() => useStartHere("ws_1"), { wrapper });
		await waitFor(() => expect(result.current.usersWithCalls).toBe(0));
		expect(result.current).toMatchObject({
			available: true,
			apiKeys: 0,
			connectedUsers: 0,
			usersWithCalls: 0,
			redirectUrlSet: false,
			actions: 0,
		});
	});

	it("counts active keys, users with a connection and users with a call, across environments", async () => {
		server = {
			"/workspaces/ws_1/api-keys": {
				data: [
					{ id: "k1", isActive: true },
					{ id: "k2", isActive: false },
				],
			},
			"/workspaces/ws_1/environments": {
				data: [
					env("env_prod"),
					env("env_dev", "https://app.example.com/connections/callback"),
				],
			},
			"/actions": {
				data: [
					{
						name: "linear.create_issue",
						enabled: true,
						headers: { Authorization: "Bearer {{secret:LINEAR}}" },
					},
					{
						name: "gmail-send",
						enabled: true,
						headers: { Authorization: "Bearer {{connection:gmail}}" },
					},
				],
			},
			"/end-users?env_prod": users(["user_1", 1, 0]),
			"/end-users?env_dev": users(["user_2", 2, 5], ["user_3", 0, 1]),
		};
		const { result } = renderHook(() => useStartHere("ws_1"), { wrapper });
		await waitFor(() => expect(result.current.usersWithCalls).toBe(2));
		expect(result.current).toMatchObject({
			apiKeys: 1,
			connectedUsers: 2,
			redirectUrlSet: true,
			actions: 2,
			exampleAction: "gmail-send",
		});
	});
});
