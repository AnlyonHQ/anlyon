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

const { createPolicy, updatePolicy, listPolicyVersions, evaluatePolicies, assistCondition } = await import("../src/core/approvals/policy.ts");

const ws = "00000000-0000-4000-8000-0000000000f1";
const env = "00000000-0000-4000-8000-0000000000f2";
const sql = (text: string, params: unknown[] = []) => state.client!.query(text, params);
let n = 0;
const create = (condition: string, actionName = "refund_order") =>
  createPolicy(ws, { environmentId: env, name: `p${++n}`, matchKind: "action", matchActionName: actionName, condition });

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', 'ws-cond')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug) VALUES ($1, $2, 'prod', 'prod')", [env, ws]);
  const action = (name: string, schema: unknown) => sql(
    "INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template, input_schema) VALUES ($1, $2, $3, $4, 'https://e.test', $5)",
    [ws, env, `act_${name}`, name, JSON.stringify(schema)],
  );
  await action("refund_order", { type: "object", properties: { amount: { type: "number" }, currency: { type: "string" } } });
  await action("scale_deployment", { type: "object", properties: { replicas: { type: "integer" }, env: { type: "string" } } });
}, 120_000);

describe("saving policy conditions", () => {
  it("checks the condition against the target action's input schema", async () => {
    await expect(create("input.ammount >= 500")).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Invalid condition: No such key: ammount/) });
    await expect(create('input.currency > 5')).rejects.toMatchObject({ statusCode: 400 });
    const saved = await create('input.amount >= 500 && input.currency == "USD"');
    expect(saved.match.condition).toBe('input.amount >= 500 && input.currency == "USD"');
  });

  it("re-checks when the policy is pointed at a different action", async () => {
    const saved = await create("input.amount >= 500");
    await expect(updatePolicy(ws, saved.id, { matchActionName: "scale_deployment" })).rejects.toMatchObject({ statusCode: 400 });
    const moved = await updatePolicy(ws, saved.id, { matchActionName: "scale_deployment", condition: 'input.replicas > 5 || input.env in ["prod"]' });
    expect(moved.match).toMatchObject({ actionName: "scale_deployment", condition: 'input.replicas > 5 || input.env in ["prod"]' });
  });

  it("records the condition in immutable history and clears it with null", async () => {
    const saved = await create("input.amount >= 10");
    const cleared = await updatePolicy(ws, saved.id, { condition: null });
    expect(cleared.match.condition).toBeNull();
    const { versions } = await listPolicyVersions(ws, saved.id);
    expect(versions.map((v) => (v.snapshot as { condition: string | null }).condition)).toEqual([null, "input.amount >= 10"]);
  });

  it("governs live evaluation, and routes an unevaluable request to a person", async () => {
    await sql("UPDATE approval_policies SET enabled = false");
    const saved = await createPolicy(ws, {
      environmentId: env, name: "big refunds denied", matchKind: "action", matchActionName: "refund_order",
      condition: "input.amount >= 1000", effect: "auto_deny",
    });
    const ctx = (payload: Record<string, unknown>) => ({ kind: "action" as const, actionName: "refund_order", payload });
    expect(await evaluatePolicies(env, ctx({ amount: 5000 }))).toMatchObject({ effect: "auto_deny", matchedPolicyId: saved.id });
    expect((await evaluatePolicies(env, ctx({ amount: 10 }))).matched).toBe(false);
    expect(await evaluatePolicies(env, ctx({}))).toMatchObject({ effect: "require_approval", matchedPolicyId: saved.id });
  });
});

describe("condition assist for the editor", () => {
  const target = { environmentId: env, matchKind: "action" as const, matchActionName: "refund_order" };

  it("lists the action's input fields and checks a draft against its schema", async () => {
    const result = await assistCondition(ws, { ...target, condition: "input.ammount > 1" });
    expect(result.inputFields.map((f) => f.path)).toEqual(["input.amount", "input.currency"]);
    expect(result.check).toMatchObject({ valid: false, message: expect.stringMatching(/ammount/) });
    expect(result.sample).toBeNull();
    expect(result.facts.map((f) => f.name)).toContain("agent.id");
  });

  it("tries a valid draft on a sample input, including the fail-closed error", async () => {
    const draft = { ...target, condition: 'input.amount >= 500 && input.currency == "USD"' };
    expect((await assistCondition(ws, { ...draft, sampleInput: { amount: 700, currency: "USD" } })).sample).toEqual({ result: true });
    expect((await assistCondition(ws, { ...draft, sampleInput: { amount: 70, currency: "USD" } })).sample).toEqual({ result: false });
    expect((await assistCondition(ws, { ...draft, sampleInput: { currency: "USD" } })).sample).toMatchObject({ error: expect.stringMatching(/no_such_key/) });
  });

  it("offers an existing policy's legacy matchers as one condition", async () => {
    const legacy = await createPolicy(ws, {
      environmentId: env, name: "legacy threshold", matchKind: "action", matchActionName: "refund_order",
      minAmount: 50.01, conditions: { currency: "USD" },
    });
    const result = await assistCondition(ws, { ...target, policyId: legacy.id });
    expect(result.legacyCondition).toBe('input.amount >= 50.01 && has(input.currency) && input.currency == "USD"');
    expect(result.check).toBeNull();
  });

  it("never reads a policy from another environment", async () => {
    await expect(assistCondition(ws, { ...target, environmentId: "00000000-0000-4000-8000-0000000000ff" })).resolves.toBeDefined();
    const other = "00000000-0000-4000-8000-0000000000f9";
    await sql("INSERT INTO environments (id, workspace_id, name, slug) VALUES ($1, $2, 'dev', 'dev')", [other, ws]);
    const saved = await create("input.amount >= 1");
    await expect(assistCondition(ws, { environmentId: other, matchKind: "action", policyId: saved.id })).rejects.toMatchObject({ statusCode: 404 });
  });
});
