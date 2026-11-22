import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client) };
});
vi.mock("../src/core/environments/service.ts", () => ({
  getEnvironment: async (_workspaceId: string, environmentId: string) => ({ id: environmentId }),
}));

const { draftCondition, parseDraft } = await import("../src/core/approvals/condition-draft.ts");
const { createPolicy } = await import("../src/core/approvals/policy.ts");
const { getPlanLimits } = await import("../src/core/plans/limits.ts");
const { usePlanFixture } = await import("./support/plan-fixture.ts");
usePlanFixture({ "*": { maxApprovalPoliciesPerEnvironment: 10, maxMonthlyConditionDrafts: 50 } });
const { resourcePlan } = await import("../src/core/billing/plan-management.ts");

const ws = "00000000-0000-4000-8000-00000000d0a1";
const env = "00000000-0000-4000-8000-00000000d0a2";
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => state.client!.query<T>(text, params);
const target = { environmentId: env, matchKind: "action" as const, matchActionName: "refund_order" };

type Chat = { role: string; content: string }[];
function fakeModel(...replies: Array<string | Error>) {
  const calls: Chat[] = [];
  const provider = {
    model: "fake",
    chat: async (messages: Chat) => {
      calls.push(messages);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return { content: reply ?? "", totalTokens: 1, promptTokens: 1, completionTokens: 1 };
    },
    rerank: async () => ({ results: [], totalTokens: 0 }),
  };
  return { calls, llm: () => provider };
}
const used = async () => Number((await sql<{ condition_drafts: string }>(
  "SELECT coalesce(sum(condition_drafts), 0) AS condition_drafts FROM workspace_usage_periods WHERE workspace_id = $1", [ws],
)).rows[0].condition_drafts);
const limits = async () => {
  const { rows: [row] } = await sql("SELECT * FROM workspaces WHERE id = $1", [ws]);
  const workspace = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));
  return getPlanLimits(resourcePlan(workspace as never), workspace as never);
};

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', 'ws-draft')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug) VALUES ($1, $2, 'prod', 'prod')", [env, ws]);
  await sql(
    "INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template, input_schema) VALUES ($1, $2, 'act_r', 'refund_order', 'https://e.test', $3)",
    [ws, env, JSON.stringify({
      type: "object", required: ["amount"],
      properties: { amount: { type: "number", description: "Refund in cents" }, currency: { type: "string" } },
    })],
  );
}, 120_000);

describe("drafting a condition", () => {
  it("sends only the sentence, the action's fields and the facts, and returns a checked condition", async () => {
    const model = fakeModel('{"condition": "input.amount >= 50000 && has(input.currency) && input.currency == \\"USD\\""}');
    const before = await used();
    const result = await draftCondition(ws, { ...target, request: "refunds of 500 dollars or more" }, model.llm);

    expect(result.condition).toBe('input.amount >= 50000 && has(input.currency) && input.currency == "USD"');
    expect(result.check).toEqual({ valid: true });
    expect(result.usage).toEqual({ used: before + 1, limit: (await limits()).maxMonthlyConditionDrafts });
    expect(model.calls).toHaveLength(1);
    const [system, user] = model.calls[0];
    expect(user).toEqual({ role: "user", content: "refunds of 500 dollars or more" });
    expect(system.content).toContain("- input.amount: double - Refund in cents");
    expect(system.content).toContain("- input.currency: string (optional: guard with has())");
    expect(system.content).toContain('calls to the action "refund_order"');
  });

  it("repairs an invalid draft once with the checker's own message, still counting one draft", async () => {
    const model = fakeModel('{"condition": "input.ammount > 5"}', "```json\n{\"condition\": \"input.amount > 5\"}\n```");
    const before = await used();
    const result = await draftCondition(ws, { ...target, request: "anything over five" }, model.llm);
    expect(result).toMatchObject({ condition: "input.amount > 5", check: { valid: true } });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1].at(-1)?.content).toMatch(/No such key: ammount/);
    expect(await used()).toBe(before + 1);
  });

  it("returns an unrepairable draft with its error rather than hiding it", async () => {
    const model = fakeModel('{"condition": "input.ammount > 5"}', '{"condition": "input.nope > 5"}');
    const result = await draftCondition(ws, { ...target, request: "anything over five" }, model.llm);
    expect(result.condition).toBe("input.nope > 5");
    expect(result.check).toMatchObject({ valid: false });
  });

  it("says when a sentence cannot be a condition", async () => {
    const result = await draftCondition(ws, { ...target, request: "only on sunny days" }, fakeModel('{"condition": null}').llm);
    expect(result).toMatchObject({ condition: null, check: null });
  });

  it("gives the draft back when the provider fails", async () => {
    const before = await used();
    await expect(draftCondition(ws, { ...target, request: "over five" }, fakeModel(new Error("timeout")).llm))
      .rejects.toMatchObject({ statusCode: 503, code: "DRAFTING_UNAVAILABLE" });
    expect(await used()).toBe(before);
    await expect(draftCondition(ws, { ...target, request: "over five" }, () => { throw new Error("not configured"); }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(await used()).toBe(before);
  });

  it("refuses once the month's allowance is used, without calling the model", async () => {
    const { maxMonthlyConditionDrafts } = await limits();
    await sql("UPDATE workspace_usage_periods SET condition_drafts = $2 WHERE workspace_id = $1", [ws, maxMonthlyConditionDrafts]);
    const model = fakeModel('{"condition": "true"}');
    await expect(draftCondition(ws, { ...target, request: "over five" }, model.llm))
      .rejects.toMatchObject({ statusCode: 429, code: "QUOTA_EXCEEDED", message: expect.stringMatching(/policy drafts a month/) });
    expect(model.calls).toHaveLength(0);
    await sql("UPDATE workspace_usage_periods SET condition_drafts = 0 WHERE workspace_id = $1", [ws]);
  });
});

describe("parseDraft", () => {
  it.each([
    ['{"condition": "a > 1"}', "a > 1"],
    ['```json\n{"condition": " a > 1 "}\n```', "a > 1"],
    ['{"condition": null}', null],
    ["a > 1", undefined],
    ['{"condition": 5}', undefined],
    ['{"condition": ""}', undefined],
  ])("%s", (reply, expected) => {
    expect(parseDraft(reply)).toBe(expected);
  });
});

describe("policy allowance per environment", () => {
  it("refuses a policy beyond the plan's allowance", async () => {
    const { maxApprovalPoliciesPerEnvironment } = await limits();
    expect(typeof maxApprovalPoliciesPerEnvironment).toBe("number");
    const { rows: [{ n }] } = await sql<{ n: number }>("SELECT count(*)::int AS n FROM approval_policies WHERE environment_id = $1", [env]);
    for (let i = n; i < (maxApprovalPoliciesPerEnvironment as number); i++) {
      await sql("INSERT INTO approval_policies (workspace_id, environment_id, policy_id, name) VALUES ($1, $2, $3, $3)", [ws, env, `apol_fill_${i}`]);
    }
    await expect(createPolicy(ws, { environmentId: env, name: "one too many", matchKind: "custom" }))
      .rejects.toMatchObject({ statusCode: 429, code: "QUOTA_EXCEEDED", message: expect.stringMatching(/approval policies per environment/) });
  });
});
