import { beforeEach, describe, expect, it, vi } from "vitest";

const getRunWithTree = vi.fn();
const ingestSpans = vi.fn();

vi.mock("../src/core/runs/service.ts", () => ({ getRunWithTree, ingestSpans }));

const { recordBudgetDecision, recordPlanQuotaDecision } = await import("../src/core/billing/budget-tracing.ts");

describe("budget tracing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRunWithTree.mockResolvedValue({ id: "run_trace" });
    ingestSpans.mockResolvedValue({ ingested: 1 });
  });

  it("records a parent-correlated rejected decision with safe accounting attributes", async () => {
    await recordBudgetDecision("ws_1", {
      runId: "run_trace",
      environmentId: "env_1",
      parentSpanId: "span_parent",
    }, {
      id: "budget_eventPublishes_req_1",
      dimension: "eventPublishes",
      allowed: false,
      startedAt: new Date("2026-07-15T00:00:00.000Z"),
      usageBefore: 10,
      usageAfter: 10,
      dimensionCap: 10,
      spendBeforeCents: 5,
      projectedSpendCents: 6,
      monthlyCapCents: 5,
    });

    expect(ingestSpans).toHaveBeenCalledWith(
      { workspaceId: "ws_1", environmentId: "env_1" },
      "run_trace",
      [expect.objectContaining({
        id: "budget_eventPublishes_req_1",
        parentId: "span_parent",
        type: "budget_check",
        status: "failed",
        error: { code: "BUDGET_EXCEEDED" },
        attributes: expect.objectContaining({ dimension: "eventPublishes", decision: "rejected", usageBefore: 10 }),
      })]
    );
  });

  it("records an explainable workspace plan-quota rejection without request content", async () => {
    await recordPlanQuotaDecision("ws_1", {
      runId: "run_trace",
      environmentId: "env_1",
      parentSpanId: "span_parent",
    }, {
      id: "plan_quota_message_req_1",
      allowed: false,
      startedAt: new Date("2026-07-15T00:00:00.000Z"),
      messageCount: 1,
      messageSize: 512,
      dailyUsage: 99,
      monthlyUsage: 999,
      bandwidthUsage: 2048,
      dailyCap: 100,
      monthlyCap: 1000,
      bandwidthCap: 4096,
      messageSizeCap: 1024,
      rejectedDimension: "messages_daily",
    });

    const span = ingestSpans.mock.calls[0][2][0];
    expect(span).toEqual(expect.objectContaining({
      name: "Enforce workspace plan quota",
      type: "budget_check",
      status: "failed",
      error: { code: "QUOTA_EXCEEDED" },
      attributes: expect.objectContaining({
        scope: "workspace_plan",
        dimension: "messages_daily",
        dailyUsage: 99,
        dailyCap: 100,
      }),
    }));
    expect(JSON.stringify(span)).not.toContain("request content");
  });
});
