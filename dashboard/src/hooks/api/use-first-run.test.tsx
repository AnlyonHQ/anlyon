/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_ACTION, DEMO_SECRET } from "@/lib/first-run";
import { useFirstRun, useSandboxToken } from "./use-first-run";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiClient: { get, post } }));

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient();
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
	get.mockReset();
	post.mockReset();
});

describe("useFirstRun", () => {
	it("opens a new workspace on the vault without asking for invocations", async () => {
		get.mockImplementation(async (path: string) => {
			if (path === "/secrets") return [];
			if (path === "/actions") return [];
			throw new Error(`Action not found: ${DEMO_ACTION}`);
		});
		const { result } = renderHook(() => useFirstRun("ws_1"), { wrapper });
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.step).toBe("vault");
		expect(result.current.error).toBeNull();
		expect(get.mock.calls.map(([path]) => path)).not.toContain(
			"/actions/invocations",
		);
	});

	it("reads the demo's invocations once the action exists", async () => {
		get.mockImplementation(async (path: string) => {
			if (path === "/secrets") return [{ name: DEMO_SECRET }];
			if (path === "/actions") return [{ name: DEMO_ACTION }];
			return {
				data: [
					{
						id: "inv_1",
						actionName: DEMO_ACTION,
						status: "pending_approval",
						approvalId: "apr_1",
						createdAt: "2026-09-25T10:00:00Z",
					},
				],
			};
		});
		const { result } = renderHook(() => useFirstRun("ws_1"), { wrapper });
		await waitFor(() => expect(result.current.step).toBe("approve"));
		expect(get).toHaveBeenCalledWith("/actions/invocations", {
			workspaceId: "ws_1",
			params: { action: DEMO_ACTION, limit: 5 },
		});
	});
});

describe("useSandboxToken", () => {
	it("uses the token the server signed for this workspace", async () => {
		post.mockResolvedValue({ token: "demo_sk_v1.d3NfMQ.nonce.signature" });
		const { result } = renderHook(() => useSandboxToken("ws_1"), { wrapper });
		expect(result.current.token).toBeNull();
		await waitFor(() =>
			expect(result.current.token).toBe("demo_sk_v1.d3NfMQ.nonce.signature"),
		);
		expect(post).toHaveBeenCalledWith("/sandbox/token", undefined, {
			workspaceId: "ws_1",
		});
	});

	it("falls back to a local single-use token when minting fails", async () => {
		post.mockRejectedValue(new Error("Route not found"));
		const { result } = renderHook(() => useSandboxToken("ws_1"), { wrapper });
		await waitFor(() =>
			expect(result.current.token).toMatch(/^demo_sk_[a-z2-9]{24}$/),
		);
	});
});
