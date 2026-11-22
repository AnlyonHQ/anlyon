import { describe, expect, it, vi } from "vitest";
import type { ApprovalPolicy } from "../src/db/schema/approvals.ts";

vi.mock("../src/db/index.ts", () => ({ db: {} }));
const { checkCondition, evaluateCondition, evaluateConditions, normalizeBatchOutcome, celSchemaFromJsonSchema, legacyCondition } = await import("../src/core/approvals/condition.ts");
const { decideFromPolicies } = await import("../src/core/approvals/policy.ts");

const refundSchema = {
  type: "object",
  required: ["amount"],
  properties: {
    amount: { type: "number" },
    currency: { type: "string" },
    express: { type: "boolean" },
    order: { type: "object", properties: { total: { type: "integer" }, lines: { type: "array" } } },
    meta: {},
  },
};

const facts = (input: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  input, agent: { id: null }, user: { id: null }, tags: [], environment: { id: "env" }, action: { name: "refund_order" }, kind: "action" as const, ...over,
});

function policy(over: Partial<ApprovalPolicy> = {}): ApprovalPolicy {
  return {
    id: "row", workspaceId: "ws", environmentId: "env", policyId: "apol_1", name: "refunds", priority: 10, enabled: true,
    matchKind: "action", matchActionName: "refund_order", matchAgentId: null, matchUserId: null, matchTags: null,
    minAmount: null, conditions: null, condition: null, effect: "require_approval", requiredApprovals: 2, version: 3,
    scopeReviewedAt: null, createdAt: new Date(0), updatedAt: new Date(0), ...over,
  } as ApprovalPolicy;
}
const request = (payload: Record<string, unknown>) => ({
  kind: "action" as const, actionName: "refund_order", payload, tags: [],
  amount: typeof payload.amount === "number" ? payload.amount : null,
});

describe("checkCondition", () => {
  it.each([
    "input.amount >= 500",
    'input.amount >= 500.5 && input.currency == "USD"',
    "input.order.total > 100 && input.order.lines.size() > 2",
    'has(input.meta) && input.meta.region in ["eu", "us"]',
    'agent.id == "agt_support" || user.id != null',
    'kind == "action" && action.name == "refund_order"',
  ])("accepts %s against the action schema", (source) => {
    expect(checkCondition(source, { inputSchema: refundSchema })).toEqual({ valid: true });
  });

  it.each([
    ["input.ammount >= 500", /No such key: ammount/],
    ["input.currency > 5", /no such overload/],
    ["input.amount", /must be true or false, but this produces double/],
    ["input.amount >>= 5", /Unexpected token/],
    ["secrets.token == 'x'", /Unknown variable: secrets/],
    ["   ", /empty/],
    [`input.amount > 1 && ${"input.amount > 1 && ".repeat(120)}true`, /limit is 2000/],
  ])("refuses %s with a usable message", (source, message) => {
    const result = checkCondition(source, { inputSchema: refundSchema });
    expect(result.valid).toBe(false);
    expect(!result.valid && result.message).toMatch(message);
  });

  it("treats input as a free map when no action schema applies", async () => {
    expect(checkCondition("input.anything.nested == 1")).toEqual({ valid: true });
  });

  it("bounds the size of one condition", async () => {
    const wide = Array.from({ length: 90 }, (_, i) => `input.f${i} == 1`).join(" || ");
    expect(checkCondition(wide).valid).toBe(false);
  });
});

describe("celSchemaFromJsonSchema", () => {
  it("rejects excessive schema nesting during authoring", async () => {
    let schema: unknown = { type: "number" };
    for (let i = 0; i < 20; i++) schema = { type: "object", properties: { child: schema } };
    expect(checkCondition("true", { inputSchema: schema })).toMatchObject({ valid: false, message: expect.stringMatching(/depth limit/) });
  });
  it("maps JSON Schema types, with numbers as doubles and unknown shapes as dyn", async () => {
    expect(celSchemaFromJsonSchema(refundSchema)).toEqual({
      amount: "double", currency: "string", express: "bool", order: { total: "double", lines: "list" }, meta: "dyn",
    });
    expect(celSchemaFromJsonSchema({})).toBe("dyn");
    expect(celSchemaFromJsonSchema({ type: "object" })).toBe("map");
  });
});

describe("evaluateCondition", () => {
  it("fails closed under queue saturation and recovers without blocking the API thread", async () => {
    const pending = Array.from({ length: 40 }, () => evaluateCondition('input.text.matches("^(a+)+$")',
      facts({ text: "a".repeat(100) + "!" })));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const outcomes = await Promise.all(pending);
    expect(outcomes.every((outcome) => "error" in outcome)).toBe(true);
    expect(outcomes.some((outcome) => "error" in outcome && outcome.error.includes("capacity"))).toBe(true);
    expect(await evaluateCondition("true", facts({}))).toEqual({ result: true });
  });
  it("terminates a pathological regex and recovers for the next evaluation", async () => {
    expect(await evaluateCondition('input.text.matches("^(a+)+$")', facts({ text: "a".repeat(100) + "!" })))
      .toEqual({ error: "Condition execution exceeded 250 ms." });
    expect(await evaluateCondition("true", facts({}))).toEqual({ result: true });
  });
  it("terminates nested macros, bounds input, and keeps errors free of request data", async () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    expect(await evaluateCondition("input.items.exists(x, input.items.exists(y, input.items.exists(z, z < 0)))", facts({ items })))
      .toEqual({ error: "Condition execution exceeded 250 ms." });
    expect(await evaluateCondition("true", facts({ value: "x".repeat(65537) }))).toHaveProperty("error");
    expect(await evaluateCondition('input.text.matches(input.pattern)', facts({ text: "x", pattern: "[PRIVATE_REQUEST" })))
      .toEqual({ error: "Condition evaluation failed: invalid_regular_expression" });
  });
  it("uses trusted environment identity even when input claims another environment", async () => {
    expect(checkCondition('environment.id == "env"')).toEqual({ valid: true });
    expect(await decideFromPolicies([policy({ condition: 'environment.id == "env"', effect: "auto_deny" })],
      request({ environment: { id: "other" } }))).toMatchObject({ effect: "auto_deny", matched: true });
  });
  it("returns the boolean result", async () => {
    expect(await evaluateCondition("input.amount >= 500", facts({ amount: 500 }))).toEqual({ result: true });
    expect(await evaluateCondition("input.amount >= 500", facts({ amount: 499.99 }))).toEqual({ result: false });
  });
  it("reports a missing field or non-bool result as an error, never as false", async () => {
    expect(await evaluateCondition("input.amount >= 500", facts({}))).toMatchObject({ error: expect.stringMatching(/no_such_key/) });
    expect(await evaluateCondition("input.amount", facts({ amount: 1 }))).toMatchObject({ error: expect.stringMatching(/true or false/) });
  });
  it("compares an unattributed agent safely", async () => {
    expect(await evaluateCondition('agent.id == "agt_1"', facts({}))).toEqual({ result: false });
  });
});

describe("the engine fails closed on a condition error", () => {
  it("requires approval instead of applying auto_deny or skipping to an auto_approve", async () => {
    const decision = await decideFromPolicies([
      policy({ condition: "input.amount >= 500", effect: "auto_deny" }),
      policy({ policyId: "apol_lenient", effect: "auto_approve", matchActionName: "refund_order" }),
    ], request({}));
    expect(decision).toMatchObject({ matched: true, effect: "require_approval", matchedPolicyId: "apol_1", requiredApprovals: 2 });
    expect(decision.explanation).toMatch(/could not be evaluated.*has\(input\.amount\)/);
  });
  it("falls through to the next policy when the condition is false", async () => {
    const decision = await decideFromPolicies([
      policy({ condition: "has(input.amount) && input.amount >= 500", effect: "auto_deny" }),
      policy({ policyId: "apol_lenient", effect: "auto_approve" }),
    ], request({ amount: 20 }));
    expect(decision).toMatchObject({ matchedPolicyId: "apol_lenient", effect: "auto_approve" });
  });
  it("requires every structural matcher and the condition", async () => {
    const scoped = policy({ matchActionName: "other_action", condition: "true" });
    expect((await decideFromPolicies([scoped], request({}))).matched).toBe(false);
  });
});

describe("legacy conversion decides exactly as before", () => {
  const legacy: Array<Pick<ApprovalPolicy, "minAmount" | "conditions">> = [
    { minAmount: "0", conditions: null },
    { minAmount: "50.01", conditions: null },
    { minAmount: "500", conditions: null },
    { minAmount: null, conditions: { currency: "USD" } },
    { minAmount: null, conditions: { priority: 1, express: true } },
    { minAmount: null, conditions: { note: null } },
    { minAmount: null, conditions: { "cost centre": "ops" } },
    { minAmount: null, conditions: { tags: ["a", "b"] } },
    { minAmount: "100", conditions: { currency: "EUR", region: { code: "eu" } } },
  ];
  const payloads: Record<string, unknown>[] = [
    {}, { amount: 0 }, { amount: 50 }, { amount: 50.01 }, { amount: 500 }, { amount: 1e9 }, { amount: -1 },
    { amount: "900" }, { amount: null }, { amount: true },
    { currency: "USD" }, { currency: "usd" }, { currency: "EUR", amount: 150, region: { code: "eu" } },
    { currency: "EUR", amount: 99, region: { code: "eu" } }, { currency: "EUR", amount: 150, region: { code: "us" } },
    { priority: 1, express: true }, { priority: "1", express: true }, { priority: 1.0, express: true }, { priority: 1 },
    { note: null }, { note: "x" }, { "cost centre": "ops" }, { "cost centre": "dev" },
    { tags: ["a", "b"] }, { tags: ["b", "a"] }, { tags: ["a"] },
  ];

  it.each(legacy.map((l) => [JSON.stringify(l), l] as const))("%s", async (_label, l) => {
    const condition = legacyCondition({ minAmount: l.minAmount, conditions: l.conditions });
    expect(condition).not.toBeNull();
    expect(checkCondition(condition!)).toEqual({ valid: true });
    for (const payload of payloads) {
      const before = await decideFromPolicies([policy(l)], request(payload));
      const after = await decideFromPolicies([policy({ condition })], request(payload));
      if (!before.explanation.includes("no numeric amount")) expect(after.explanation).not.toContain("could not be evaluated");
      expect({ payload, matched: after.matched, effect: after.effect }).toEqual({ payload, matched: before.matched, effect: before.effect });
    }
  });

  it("converts nothing when there is nothing to convert", async () => {
    expect(legacyCondition({ minAmount: null, conditions: null })).toBeNull();
    expect(legacyCondition({ minAmount: null, conditions: {} })).toBeNull();
  });
});

describe("one worker round trip per request", () => {
  const base = { input: {}, agent: { id: null }, user: { id: null }, tags: [], action: { name: "refund_order" }, kind: "action" as const };
  const item = (source: string) => ({ source, environmentId: "env" });

  it("returns the first decisive condition and evaluates nothing after it", async () => {
    const slow = 'input.text.matches("^(a+)+$")';
    const withText = { ...base, input: { text: "a".repeat(100) + "!" } };
    expect(await evaluateConditions([item("false"), item("true"), item(slow)], withText)).toEqual({ index: 1, result: true });
    expect(await evaluateConditions([item("false"), item("input.missing > 1"), item("true")], base))
      .toMatchObject({ index: 1, error: expect.stringMatching(/Condition evaluation failed/) });
    expect(await evaluateConditions([item("false"), item("1 > 2")], base)).toEqual({ index: -1 });
    expect(await evaluateConditions([], base)).toEqual({ index: -1 });
  });

  it("reports an oversized expression at its own position, after earlier policies decide", async () => {
    const huge = `true || ${"true || ".repeat(400)}true`;
    expect(await evaluateConditions([item("true"), item(huge)], base)).toEqual({ index: 0, result: true });
    expect(await evaluateConditions([item("false"), item(huge)], base)).toEqual({ index: 1, error: "Condition expression is too large." });
  });

  it("keeps exact first-match order across conditioned, unconditioned and undecidable policies", async () => {
    const p = (policyId: string, over: Partial<ApprovalPolicy> = {}) => policy({ policyId, name: policyId, ...over });
    const decide = async (list: ApprovalPolicy[], payload: Record<string, unknown> = {}) =>
      (await decideFromPolicies(list, request(payload))).matchedPolicyId;
    expect(await decide([p("a", { condition: "false" }), p("b", { condition: "true" }), p("c")])).toBe("b");
    expect(await decide([p("a", { condition: "false" }), p("b", { condition: "false" }), p("c")])).toBe("c");
    expect(await decide([p("a"), p("b", { condition: "true" })])).toBe("a");
    expect(await decide([p("a", { matchAgentId: "agt_1" }), p("b", { condition: "true" })])).toBe("a");
    expect(await decide([p("a", { condition: "true" }), p("b", { matchAgentId: "agt_1" })])).toBe("a");
    expect(await decide([p("a", { condition: "false" }), p("b", { matchAgentId: "agt_1" })])).toBe("b");
    expect(await decide([p("a", { matchActionName: "other", condition: "input.missing > 1" }), p("b", { condition: "true" })])).toBe("b");
    const failed = await decideFromPolicies([p("a", { condition: "false" }), p("b", { condition: "input.missing > 1", effect: "auto_deny" }), p("c")], request({}));
    expect(failed).toMatchObject({ matchedPolicyId: "b", effect: "require_approval" });
    expect((await decideFromPolicies([p("a", { condition: "false" })], request({}))).matched).toBe(false);
  });

  it("decides a long policy list in one round trip", async () => {
    const list = Array.from({ length: 250 }, (_, i) => policy({ policyId: `p${i}`, condition: `input.amount == ${i + 1000}` }));
    const started = performance.now();
    const decision = await decideFromPolicies(list, request({ amount: 1249 }));
    expect(decision.matchedPolicyId).toBe("p249");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("an untrusted worker reply fails closed", () => {
  const invalid = { index: 0, error: "Condition evaluation returned an invalid result." };
  it.each([
    [{ index: 3, error: "Condition execution exceeded 250 ms." }, 3, invalid],
    [{ index: 3, result: true }, 3, invalid],
    [{ index: -2 }, 3, invalid],
    [{ index: 1.5, result: true }, 3, invalid],
    [{ index: 1 }, 3, invalid],
    [{ index: 1, result: false }, 3, invalid],
    [{ index: -1, error: "x" }, 3, invalid],
    [null, 3, invalid],
    ["nope", 3, invalid],
    [{ index: 2, error: "Condition execution exceeded 250 ms." }, 3, { index: 2, error: "Condition execution exceeded 250 ms." }],
    [{ index: 0, result: true }, 3, { index: 0, result: true }],
    [{ index: -1 }, 3, { index: -1 }],
  ])("%j over %i conditions", (reply, length, expected) => {
    expect(normalizeBatchOutcome(reply, length)).toEqual(expected);
  });
});

describe("minAmount states the amount and unit it compared", () => {
  const big = policy({ minAmount: "1000" });

  it("an adapter action's amount is the trusted quantity in minor units, and the decision says so", async () => {
    const decision = await decideFromPolicies([big], { kind: "action", actionName: "refund_order", payload: { amount: 1250 }, amount: 1250, amountCurrency: "usd" });
    expect(decision.matched).toBe(true);
    expect(decision.explanation).toContain("Compared the policy's minimum amount with 1250 USD minor units");
  });

  it("a template action's amount is input.amount as sent, unchanged, and the decision says so", async () => {
    expect((await decideFromPolicies([big], request({ amount: 999 }))).matched).toBe(false);
    const decision = await decideFromPolicies([big], request({ amount: 1500 }));
    expect(decision.explanation).toContain("Compared the policy's minimum amount with 1500 (input.amount as sent");
  });

  it("a policy without minAmount says nothing about amounts", async () => {
    const decision = await decideFromPolicies([policy()], request({ amount: 1500 }));
    expect(decision.explanation).not.toContain("minAmount");
  });
});
