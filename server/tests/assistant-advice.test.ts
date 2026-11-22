import { describe, expect, it } from "vitest";
import {
  amountStats,
  buildQuestions,
  buildState,
  removeFields,
  toAdvice,
  type AdviceSubject,
} from "../src/core/assistant/advice.ts";
import {
  CONSISTENCY_FLOOR,
  ENVELOPE_RULE_TEXT,
  INJECTION_CEILING,
  MIN_CONFIDENCE_FLOOR,
  mayAutoApprove, readAmount,
  type EnvelopeInput,
  type EnvelopeRule,
} from "../src/core/assistant/envelope.ts";
import type { TypeSafeResponse } from "../src/core/assistant/typesafe-client.ts";

const subject = (over: Partial<AdviceSubject> = {}): AdviceSubject => ({
  kind: "action",
  title: "Run action refund_order",
  description: null,
  actionName: "refund_order",
  method: "POST",
  urlTemplate: "https://api.shop.example/v1/orders/{{input.orderId}}/refund?token={{secret:SHOP_TOKEN}}",
  input: { orderId: "ord_1", amount: 40, customer: { email: "a@b.example", name: "Ada" }, apiKey: "sk_live_x" },
  agentId: "support-bot",
  policyName: "refunds",
  policyExplanation: 'Matched policy "refunds"',
  amount: 40,
  ...over,
});

const history = { approved: 25, denied: 0, maxAmount: 90, medianAmount: 30 };

describe("buildState: what is sent to the model", () => {
  it("redacts sensitive keys, removes excluded fields, and sends only the destination host", () => {
    const state = buildState(subject(), history, ["customer.email"]);
    const sent = JSON.stringify(state);
    expect(sent).not.toContain("sk_live_x");
    expect(sent).not.toContain("a@b.example");
    expect(sent).not.toContain("SHOP_TOKEN");
    expect(sent).not.toContain("/v1/orders");
    expect(state.request.destinationHost).toBe("api.shop.example");
    expect(JSON.parse(state.request.input)).toEqual({
      orderId: "ord_1",
      amount: 40,
      customer: { name: "Ada" },
      apiKey: "[REDACTED]",
    });
  });

  it("truncates a large input", () => {
    const state = buildState(subject({ input: { note: "x".repeat(20_000) } }), history, []);
    expect(state.request.input.length).toBeLessThan(8_100);
    expect(state.request.input.endsWith("…[truncated]")).toBe(true);
  });

  it("omits values nested too deep to inspect rather than sending them unchecked", () => {
    let deep: Record<string, unknown> = { password: "hunter2" };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const state = buildState(subject({ input: deep }), history, []);
    expect(state.request.input).not.toContain("hunter2");
  });

  it("removes excluded fields through arrays", () => {
    expect(removeFields({ items: [{ note: "a", sku: 1 }, { note: "b", sku: 2 }] }, ["items.note"]))
      .toEqual({ items: [{ sku: 1 }, { sku: 2 }] });
  });

  it("never sends an excluded amount, including the copies derived from it", () => {
    const state = buildState(subject(), history, ["amount"]);
    expect(state.request.amount).toBeNull();
    expect(JSON.parse(state.request.input)).not.toHaveProperty("amount");
    expect(state.history_last_30_days_for_this_agent_and_action).toEqual({ approved: 25, denied: 0 });
    expect(JSON.stringify(state)).not.toMatch(/"(max|median)Amount"/);
    expect(Object.keys(buildQuestions(subject(), ["amount"]))).not.toContain("amount_unusual");
  });

  it("asks about the amount only when there is one", () => {
    expect(Object.keys(buildQuestions(subject()))).toContain("amount_unusual");
    expect(Object.keys(buildQuestions(subject({ amount: null })))).not.toContain("amount_unusual");
  });
});

const response = (over: Partial<Record<string, unknown>> = {}): TypeSafeResponse => ({
  model: "jev-1.13.0",
  answers: {
    risk: { type: "score", score: 0.4, confidence: 0.9, probabilities: {} },
    recommendation: { type: "choice", choice: "approve", confidence: 0.93, probabilities: {} },
    consistent_with_history: { type: "noul", noul: 0.88 },
    injection_suspected: { type: "noul", noul: 0.03 },
    amount_unusual: { type: "noul", noul: 0.7 },
    ...over,
  } as TypeSafeResponse["answers"],
  usage: { input_tokens: 512, output_tokens: 0 },
});

describe("toAdvice", () => {
  it("maps answers to stored advice with template reasons", () => {
    const advice = toAdvice(response(), history)!;
    expect(advice).toMatchObject({ model: "jev-1.13.0", recommendation: "approve", risk: 0.4, confidence: 0.93, inputTokens: 512 });
    expect(advice.flags).toEqual({ injectionSuspected: 0.03, consistentWithHistory: 0.88, amountUnusual: 0.7 });
    expect(advice.reasons).toEqual([
      "Suggests approve (confidence 0.93)",
      "Risk: routine (0.40 on a 0–4 scale)",
      "Consistent with 25 approved and 0 denied requests in 30 days (0.88)",
      "Amount is unusual for this agent (0.70)",
    ]);
  });

  it("says when there is no history, and flags suspected injection", () => {
    const advice = toAdvice(response({ injection_suspected: { type: "noul", noul: 0.81 } }), { approved: 0, denied: 0, maxAmount: null, medianAmount: null })!;
    expect(advice.reasons).toContain("No history for this agent and action in the last 30 days");
    expect(advice.reasons).toContain("Possible injected instructions or values (0.81)");
  });

  it("returns null for a risk beyond the five levels asked about", () => {
    expect(toAdvice(response({ risk: { type: "score", score: 4.5, confidence: 0.9, probabilities: {} } }), history)).toBeNull();
    expect(toAdvice(response({ risk: { type: "score", score: 4, confidence: 0.9, probabilities: {} } }), history)).not.toBeNull();
  });

  it("returns null when an answer the envelope depends on is missing or not a known choice", () => {
    expect(toAdvice(response({ risk: undefined }), history)).toBeNull();
    expect(toAdvice(response({ recommendation: { type: "choice", choice: "escalate", confidence: 1, probabilities: {} } }), history)).toBeNull();
  });

  it("computes median and max", () => {
    expect(amountStats([])).toEqual({ medianAmount: null, maxAmount: null });
    expect(amountStats([5, 1, 3])).toEqual({ medianAmount: 3, maxAmount: 5 });
    expect(amountStats([1, 2, 3, 4])).toEqual({ medianAmount: 2.5, maxAmount: 4 });
  });
});

const now = new Date("2026-09-24T12:00:00Z");
const passing = (): EnvelopeInput => ({
  platformKillSwitch: false,
  environmentHalted: false,
  settings: {
    enabled: true,
    autoApprove: { enabled: true, actions: ["refund_order"], maxAmount: 100, minConfidence: 0.9, maxRisk: 1, minHistory: 20 },
  },
  approval: { kind: "action", status: "pending", expiresAt: new Date(now.getTime() + 60_000), requiredApprovals: 1, environmentId: "env-1" },
  actionName: "refund_order",
  amount: 40,
  advice: { recommendation: "approve", risk: 0.4, confidence: 0.95, injectionSuspected: 0.01, consistentWithHistory: 0.9 },
  history: { approved: 25, denied: 0 },
  now,
});

describe("mayAutoApprove: every rule rejects on its own", () => {
  it("approves when every rule holds", () => {
    expect(mayAutoApprove(passing())).toEqual({ ok: true, failed: [] });
  });

  const cases: Array<[EnvelopeRule, (i: EnvelopeInput) => void]> = [
    ["platform_disabled", (i) => { i.platformKillSwitch = true; }],
    ["environment_halted", (i) => { i.environmentHalted = true; }],
    ["assistant_disabled", (i) => { i.settings.enabled = false; }],
    ["auto_approve_disabled", (i) => { i.settings.autoApprove.enabled = false; }],
    ["not_an_action", (i) => { i.approval.kind = "custom"; }],
    ["action_not_allowlisted", (i) => { i.settings.autoApprove.actions = ["other"]; }],
    ["environment_not_allowed", (i) => { i.settings.autoApprove.environments = ["env-2"]; }],
    ["needs_multiple_approvers", (i) => { i.approval.requiredApprovals = 2; }],
    ["not_pending", (i) => { i.approval.status = "approved"; }],
    ["expired", (i) => { i.approval.expiresAt = now; }],
    ["not_recommended", (i) => { i.advice.recommendation = "review"; }],
    ["confidence_below_threshold", (i) => { i.advice.confidence = 0.85; }],
    ["risk_above_threshold", (i) => { i.advice.risk = 1.5; }],
    ["injection_suspected", (i) => { i.advice.injectionSuspected = INJECTION_CEILING; }],
    ["injection_suspected", (i) => { i.advice.injectionSuspected = null; }],
    ["inconsistent_with_history", (i) => { i.advice.consistentWithHistory = CONSISTENCY_FLOOR - 0.01; }],
    ["inconsistent_with_history", (i) => { i.advice.consistentWithHistory = null; }],
    ["insufficient_history", (i) => { i.history.approved = 19; }],
    ["prior_denials", (i) => { i.history.denied = 1; }],
    ["amount_missing", (i) => { i.amount = null; }],
    ["amount_above_cap", (i) => { i.amount = 100.01; }],
    ["amount_without_cap", (i) => { i.settings.autoApprove.maxAmount = null; }],
    ["amount_without_cap", (i) => { i.settings.autoApprove.maxAmount = undefined; i.amount = 0.01; }],
  ];

  it("with no cap set, still approves a request that carries no amount", () => {
    const input = passing();
    input.settings.autoApprove.maxAmount = null;
    input.amount = null;
    expect(mayAutoApprove(input)).toEqual({ ok: true, failed: [] });
  });

  it("with no cap set, leaves to a person a request that moves money its amount field does not give", () => {
    for (const requestInput of [
      { amount: "5000000" },
      { amount: " 12.50 " },
      { amount: { value: 5000000 } },
      { amount: "five million" },
      { amount_cents: 500000000 },
      { total: 5000000 },
      { order: { lines: [{ sku: "a", price: "5000000" }] } },
      { transfer: { totalAmount: 5000000 } },
    ]) {
      const read = readAmount(requestInput, undefined);
      const input = passing();
      input.settings.autoApprove.maxAmount = null;
      input.amount = read.amount;
      input.carriesMoney = read.carriesMoney;
      expect(mayAutoApprove(input).failed, JSON.stringify(requestInput)).toEqual(["amount_without_cap"]);
    }
    expect(readAmount({ note: "x" }, undefined, true)).toEqual({ amount: null, carriesMoney: true });
  });

  it("reads an amount written as a number in text, and does not see money in counters or plain text", () => {
    expect(readAmount({ amount: "5000000" }, undefined)).toEqual({ amount: 5000000, carriesMoney: true });
    expect(readAmount({ amount: 40 }, undefined)).toEqual({ amount: 40, carriesMoney: true });
    expect(readAmount({}, 12)).toEqual({ amount: 12, carriesMoney: true });
    for (const requestInput of [{ orderId: "ord_1", note: "total refund please" }, { total_count: 3, page: 2 }, { price_id: "price_123" }, null, "text", [1, 2]]) {
      expect(readAmount(requestInput, undefined), JSON.stringify(requestInput)).toEqual({ amount: null, carriesMoney: false });
    }
  });

  it("holds a negative amount to the cap by its size", () => {
    const input = passing();
    input.amount = -5000;
    expect(mayAutoApprove(input).failed).toEqual(["amount_above_cap"]);
  });

  it.each(cases)("%s", (rule, mutate) => {
    const input = passing();
    mutate(input);
    const result = mayAutoApprove(input);
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([rule]);
    expect(ENVELOPE_RULE_TEXT[rule]).toBeTruthy();
  });

  it("never approves N-of-M, whatever the advice", () => {
    for (const requiredApprovals of [0, 2, 3, 5]) {
      const input = passing();
      input.approval.requiredApprovals = requiredApprovals;
      input.advice = { recommendation: "approve", risk: 0, confidence: 1, injectionSuspected: 0, consistentWithHistory: 1 };
      expect(mayAutoApprove(input).failed).toContain("needs_multiple_approvers");
    }
  });

  it("holds the confidence floor even when a workspace sets a lower threshold", () => {
    const input = passing();
    input.settings.autoApprove.minConfidence = 0.5;
    input.advice.confidence = MIN_CONFIDENCE_FLOOR - 0.01;
    expect(mayAutoApprove(input).failed).toEqual(["confidence_below_threshold"]);
  });

  it("does not require an amount when no cap is set", () => {
    const input = passing();
    input.settings.autoApprove.maxAmount = null;
    input.amount = null;
    expect(mayAutoApprove(input).ok).toBe(true);
  });
});
