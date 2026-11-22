/* @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
	AgentAnalytics,
	OverviewAnalytics,
	TrustControlAnalytics,
} from "@/lib/types";
import * as panels from "./analytics-panels";
import {
	AgentsPanel,
	OverviewPanel,
	TrustControlPanel,
} from "./analytics-panels";

class ResizeObserverMock {
	private readonly callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
	}

	disconnect() {}
	observe(target: Element) {
		this.callback(
			[
				{
					contentRect: { height: 256, width: 800 },
					target,
				} as ResizeObserverEntry,
			],
			this as unknown as ResizeObserver,
		);
	}
	unobserve() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const metadata = {
	range: {
		startDate: "2026-07-01T00:00:00.000Z",
		endDate: "2026-07-29T00:00:00.000Z",
		granularity: "day" as const,
		truncated: false,
		retentionDays: null,
	},
	scope: { workspaceId: "workspace-1", environmentId: "environment-1" },
};

describe("analytics panels", () => {
	it("keeps a tab-level query failure inside the active panel", () => {
		render(<OverviewPanel data={undefined} isError={true} isLoading={false} />);

		expect(screen.getByText("Analytics could not be loaded")).toBeTruthy();
		expect(
			screen.getByText("Refresh the page or try a shorter date range."),
		).toBeTruthy();
	});

	it("renders governed overview metrics and no other product tiles", () => {
		const data = {
			...metadata,
			summary: {
				agentRuns: 12,
				agentRunSuccessRate: 75,
				actionInvocations: 9,
				actionSuccessRate: 89,
				pendingApprovals: 2,
			},
			usage: {
				counters: {
					messagesPublished: 100,
					messagesDelivered: 90,
					messagesFailed: 10,
					schedulesExecuted: 7,
					bandwidthBytes: 2048,
					memoryOperations: 15,
					embeddingTokens: 1200,
					llmTokens: 500,
					rerankOperations: 3,
					eventPublishes: 22,
					cacheLookups: 20,
					cacheHits: 15,
					actionInvokes: 9,
				},
				scope: "workspace" as const,
			},
			series: [],
			attention: [
				{
					product: "actions",
					label: "Failed action invocations",
					count: 3,
					href: "/actions",
				},
				{
					product: "delivery",
					label: "Failed messages",
					count: 7,
					href: "/messages",
				},
				{
					product: "workflows",
					label: "Failed workflow runs",
					count: 4,
					href: "/workflows",
				},
			],
		} satisfies OverviewAnalytics;

		render(<OverviewPanel data={data} isError={false} isLoading={false} />);

		expect(screen.getByText("Agent runs")).toBeTruthy();
		expect(screen.getByText("Action invocations")).toBeTruthy();
		expect(screen.getByText("Pending approvals")).toBeTruthy();
		expect(screen.getByText("Failed action invocations")).toBeTruthy();
		for (const hidden of [
			"Event publishes",
			"Messages delivered",
			"Workflow runs",
			"Delivery activity",
			"Failed messages",
			"Failed workflow runs",
			"Memory operations",
			"Cache hit rate",
			"Stored data",
		]) {
			expect(screen.queryByText(hidden)).toBeNull();
		}
	});

	it("renders agent ranking data and a complete empty state", () => {
		const data = {
			...metadata,
			summary: {
				totalRuns: 10,
				runningRuns: 1,
				succeededRuns: 6,
				failedRuns: 2,
				cancelledRuns: 1,
				successRate: 60,
				p50DurationMs: 250,
				p95DurationMs: 1500,
				totalTokens: 4000,
				totalCost: 2.5,
			},
			series: [
				{
					period: "2026-07-28",
					total: 10,
					running: 1,
					succeeded: 6,
					failed: 2,
					cancelled: 1,
				},
			],
			topAgents: [
				{
					agentId: "agent-1",
					name: "Research agent",
					totalRuns: 10,
					failedRuns: 2,
					successRate: 60,
					totalTokens: 4000,
					totalCost: 2.5,
				},
			],
			topVersions: [],
		} satisfies AgentAnalytics;

		render(<AgentsPanel data={data} isError={false} isLoading={false} />);

		expect(screen.getByText("Research agent")).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: "Failed" })).toBeTruthy();
		expect(screen.getByText("Running")).toBeTruthy();
		expect(screen.getByText("Cancelled")).toBeTruthy();
	});

	it("renders failed actions and expired approvals from trust analytics", () => {
		const data = {
			...metadata,
			actions: {
				summary: {
					totalInvocations: 12,
					succeededInvocations: 7,
					failedInvocations: 3,
					deniedInvocations: 2,
					pendingInvocations: 0,
					successRate: 58.33,
					p50DurationMs: 200,
					p95DurationMs: 900,
					approvalGatedRate: 25,
				},
				series: [
					{
						period: "2026-07-28",
						total: 12,
						pending: 0,
						succeeded: 7,
						failed: 3,
						denied: 2,
					},
				],
				topActions: [
					{
						actionId: "action-1",
						name: "Send email",
						totalInvocations: 12,
						failedInvocations: 3,
						successRate: 58.33,
						p95DurationMs: 900,
					},
				],
			},
			approvals: {
				summary: {
					totalRequests: 5,
					pendingRequests: 1,
					approvedRequests: 2,
					deniedRequests: 1,
					expiredRequests: 1,
					approvalRate: 40,
					p50DecisionMs: 500,
					p95DecisionMs: 1200,
					oldestPendingMs: 2000,
				},
				series: [
					{
						period: "2026-07-28",
						total: 5,
						pending: 1,
						approved: 2,
						denied: 1,
						expired: 1,
					},
				],
				topPolicies: [
					{
						policyId: "policy-1",
						name: "Production writes",
						totalRequests: 5,
						approvedRequests: 2,
						deniedRequests: 1,
						expiredRequests: 1,
					},
				],
			},
		} satisfies TrustControlAnalytics;

		render(<TrustControlPanel data={data} isError={false} isLoading={false} />);

		expect(screen.getByText("Send email")).toBeTruthy();
		expect(screen.getByText("Production writes")).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: "Expired" })).toBeTruthy();
		expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
	});

	it("exports no delivery panel", () => {
		expect(Object.keys(panels).sort()).toEqual([
			"AgentsPanel",
			"OverviewPanel",
			"TrustControlPanel",
		]);
	});
});
