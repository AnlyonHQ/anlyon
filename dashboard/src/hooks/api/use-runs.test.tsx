/* @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RunWithSpans } from "@/lib/types";
import { TraceTree } from "@/routes/_protected/recent-runs";

const useRunMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/api/use-runs", () => ({
	useRun: useRunMock,
	useRuns: vi.fn(),
	runKeys: { all: ["runs"], detail: (id: string) => ["runs", "detail", id] },
}));

const run = {
	id: "run_MgINLcS0tuXbjs7KyoLyV",
	name: "nightly-summary",
	status: "completed",
	durationMs: 1200,
	tokens: 350,
	cost: null,
	spans: [
		{
			id: "span_1",
			name: "llm.call",
			status: "ok",
			startedAt: "2026-09-12T20:00:00.000Z",
			durationMs: 900,
			children: [],
		},
	],
} as unknown as RunWithSpans;

describe("TraceTree", () => {
	it("renders the run detail from the unwrapped API client response", () => {
		useRunMock.mockReturnValue({ data: run, isLoading: false });

		render(
			<TraceTree
				onViewChange={vi.fn()}
				runId={run.id}
				view="tree"
				workspaceId="workspace-1"
			/>,
		);

		expect(screen.getByText("nightly-summary")).toBeTruthy();
		expect(screen.getByText("llm.call")).toBeTruthy();
	});
});
