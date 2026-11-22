import { describe, expect, it } from "vitest";
import type { ApprovalPolicy } from "../src/db/schema/approvals.ts";
import { MIN_APPROVALS, mineSuggestions, type HistoryRow } from "../src/core/assistant/policy-suggestions.ts";

const now = new Date("2026-09-24T12:00:00Z");
const row = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  environmentId: "env-1",
  actionName: "refund_order",
  agentId: "support-bot",
  status: "approved",
  origin: "human",
  amount: 10,
  risk: 0.3,
  ...over,
});
const many = (n: number, over: (i: number) => Partial<HistoryRow> = () => ({})) =>
  Array.from({ length: n }, (_, i) => row(over(i)));

describe("policy suggestions", () => {
  it("suggests a capped pair from enough clean human approvals, previewed through the real engine", async () => {
    const rows = many(MIN_APPROVALS, (i) => ({ amount: 10 + i }));
    const [s] = await mineSuggestions(rows, [], now);
    expect(s).toMatchObject({ environmentId: "env-1", actionName: "refund_order", agentId: "support-bot", approved: 20, maxAmount: 29 });
    expect(s.policies).toEqual([
      expect.objectContaining({ effect: "require_approval", minAmount: 30, priority: 49 }),
      expect.objectContaining({ effect: "auto_approve", minAmount: null, priority: 50 }),
    ]);
    expect(s.preview).toEqual({ wouldAutoApprove: 20, wouldStillReview: 0, wouldApproveDenied: 0 });
  });

  it("uses a cent above the largest amount when amounts are not whole", async () => {
    const [s] = await mineSuggestions(many(MIN_APPROVALS, () => ({ amount: 12.5 })), [], now);
    expect(s.policies[0].minAmount).toBe(12.51);
  });

  it("suggests only auto_approve when there are no amounts", async () => {
    const [s] = await mineSuggestions(many(MIN_APPROVALS, () => ({ amount: null })), [], now);
    expect(s.policies.map((p) => p.effect)).toEqual(["auto_approve"]);
  });

  it("never suggests a group with a denial", async () => {
    const rows = [...many(50), row({ status: "denied" })];
    expect(await mineSuggestions(rows, [], now)).toEqual([]);
  });

  it("needs enough approvals by people, not by policy or the assistant", async () => {
    const rows = [...many(MIN_APPROVALS - 1), ...many(10, () => ({ origin: "policy" })), ...many(10, () => ({ origin: "assistant" }))];
    expect(await mineSuggestions(rows, [], now)).toEqual([]);
  });

  it("skips groups the assistant rated risky on average", async () => {
    expect(await mineSuggestions(many(MIN_APPROVALS, () => ({ risk: 2 })), [], now)).toEqual([]);
  });

  it("skips a group an auto_approve policy already governs", async () => {
    const existing = [{
      id: "p1", workspaceId: "w", environmentId: "env-1", policyId: "apol_1", name: "x", priority: 10, enabled: true,
      matchKind: "action", matchActionName: "refund_order", matchAgentId: "support-bot", matchUserId: null, matchTags: null,
      minAmount: null, conditions: null, effect: "auto_approve", requiredApprovals: 1, version: 1,
      scopeReviewedAt: now, createdAt: now, updatedAt: now,
    } as unknown as ApprovalPolicy];
    expect(await mineSuggestions(many(MIN_APPROVALS), existing, now)).toEqual([]);
  });

  it("keys a suggestion stably and separates environments and agents", async () => {
    const rows = [...many(MIN_APPROVALS), ...many(MIN_APPROVALS, () => ({ environmentId: "env-2" })), ...many(MIN_APPROVALS, () => ({ agentId: null }))];
    const first = await mineSuggestions(rows, [], now);
    expect(first).toHaveLength(3);
    expect(new Set(first.map((s) => s.key)).size).toBe(3);
    expect((await mineSuggestions(rows, [], now)).map((s) => s.key)).toEqual(first.map((s) => s.key));
  });
});
