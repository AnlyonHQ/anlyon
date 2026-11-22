/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRealtime } from "./use-realtime";

function QueryWrapper({ children }: PropsWithChildren) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

describe("useRealtime", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reports a disconnected stream when the server rejects the workspace", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 403,
			body: null,
		});
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useRealtime("workspace-a"), {
			wrapper: QueryWrapper,
		});

		await waitFor(() => expect(result.current).toBe("disconnected"));
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/api/v2/stream"),
			expect.objectContaining({
				headers: expect.objectContaining({ "X-Workspace-Id": "workspace-a" }),
			}),
		);
	});
});
