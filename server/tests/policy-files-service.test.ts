import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client) };
});
vi.mock("../src/core/environments/service.ts", async () => {
  const { NotFoundError } = await import("../src/utils/errors.ts");
  return {
    getEnvironment: async (workspaceId: string, environmentId: string) => {
      const { rows } = await state.client!.query("SELECT id, slug FROM environments WHERE workspace_id = $1 AND id = $2", [workspaceId, environmentId]);
      if (!rows[0]) throw new NotFoundError("Environment");
      return rows[0];
    },
  };
});

const files = await import("../src/core/approvals/policy-files.ts");
const { usePlanFixture } = await import("./support/plan-fixture.ts");
usePlanFixture({ "*": { maxApprovalPoliciesPerEnvironment: 25 } });
const { createPolicy, updatePolicy, deletePolicy, listPolicies } = await import("../src/core/approvals/policy.ts");

const ws = "00000000-0000-4000-8000-00000000f1a1";
const env = "00000000-0000-4000-8000-00000000f1a2";
const dev = "00000000-0000-4000-8000-00000000f1a3";
const operator = { environmentId: env, actor: { type: "api_key" as const, id: "key_deploy" } };
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => state.client!.query<T>(text, params);
const policyCount = async () => (await sql<{ n: number }>("SELECT count(*)::int AS n FROM approval_policies WHERE environment_id = $1", [env])).rows[0].n;
const historyCount = async () => (await sql<{ n: number }>("SELECT count(*)::int AS n FROM approval_policy_versions WHERE environment_id = $1", [env])).rows[0].n;

const refunds = (extra = "", fileId = "payments/refunds") => `apiVersion: anlyon.com/policies/v1
file: ${fileId}
environment: prod
policies:
  big-refunds:
    name: Big refunds need two approvers
    target: { action: refund_order }
    when: input.amount >= 50000
    approvals: 2
    priority: 10
  small-refunds:
    name: Small refunds are automatic
    target: { action: refund_order }
    when: input.amount < 1000
    effect: auto_approve
    priority: 20
${extra}`;

async function planAndApply(source: string, note?: string) {
  const plan = await files.planPolicyFile(ws, env, source);
  expect(plan.errors).toEqual([]);
  return files.applyPolicyFile(ws, env, source, plan.digest, operator, note);
}

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', 'ws-files')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug) VALUES ($1, $3, 'prod', 'prod'), ($2, $3, 'dev', 'dev')", [env, dev, ws]);
  await sql(
    "INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template, input_schema) VALUES ($1, $2, 'act_r', 'refund_order', 'https://e.test', $3)",
    [ws, env, JSON.stringify({ type: "object", required: ["amount"], properties: { amount: { type: "number" }, currency: { type: "string" } } })],
  );
}, 120_000);

describe("policy files", () => {
  it("fixtures and applied policies choose the same winner when priorities tie", async () => {
    const source = `apiVersion: anlyon.com/policies/v1
file: tie-order
environment: prod
policies:
  alpha: { name: Tie alpha, target: { action: refund_order }, effect: auto_approve, priority: 0 }
  beta: { name: Tie beta, target: { action: refund_order }, effect: auto_deny, priority: 0 }
`;
    const preview = await files.testPolicyFile(ws, env, source, [{ name: "tie", request: { kind: "action", action: "refund_order" }, expect: { effect: "auto_deny" } }]);
    await planAndApply(source);
    const { evaluatePolicies } = await import("../src/core/approvals/policy.ts");
    expect((await evaluatePolicies(env, { kind: "action", actionName: "refund_order" })).effect).toBe(preview.results[0].effect);
    await planAndApply(source.replace(/policies:[\s\S]*/, "policies: {}"));
  });

  it("invalidates the digest if schema changes before the version pointer catches up", async () => {
    const source = refunds("", "schema-review").replaceAll("Big refunds", "Schema big").replaceAll("Small refunds", "Schema small");
    const plan = await files.planPolicyFile(ws, env, source);
    await sql("UPDATE actions SET input_schema = input_schema || '{\"description\":\"changed without a version\"}'::jsonb WHERE action_id = 'act_r'");
    await expect(files.applyPolicyFile(ws, env, source, plan.digest, operator)).rejects.toMatchObject({ code: "STALE_PLAN" });
  });

  it("reports occupied-name rename cycles at plan time instead of promising an applicable plan", async () => {
    const source = `apiVersion: anlyon.com/policies/v1
file: rename-check
environment: prod
policies:
  one: { name: Rename one, target: { customRequests: true } }
  two: { name: Rename two, target: { customRequests: true } }
`;
    await planAndApply(source);
    const swapped = source.replace("name: Rename one", "name: PLACEHOLDER").replace("name: Rename two", "name: Rename one").replace("name: PLACEHOLDER", "name: Rename two");
    expect((await files.planPolicyFile(ws, env, swapped)).errors.join(" ")).toContain("temporary unique name");
    await planAndApply(source.replace(/policies:[\s\S]*/, "policies: {}"));
  });
  it("plans without writing, applies atomically with provenance, and re-plans as unchanged", async () => {
    const before = { policies: await policyCount(), history: await historyCount() };
    const plan = await files.planPolicyFile(ws, env, refunds());
    expect(plan.summary).toEqual({ create: 2, update: 0, delete: 0, unchanged: 0 });
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
    expect({ policies: await policyCount(), history: await historyCount() }).toEqual(before);

    const applied = await files.applyPolicyFile(ws, env, refunds(), plan.digest, operator, "FIN-42 rollout");
    expect(applied.applied).toBe(true);
    const policies = await listPolicies(ws, env);
    const big = policies.find((p) => p.name === "Big refunds need two approvers")!;
    expect(big).toMatchObject({ requiredApprovals: 2, priority: 10, managedBy: { file: "payments/refunds", key: "big-refunds" },
      match: { condition: "input.amount >= 50000", actionName: "refund_order" } });
    const { rows } = await sql("SELECT actor_id, change_note, operation FROM approval_policy_versions WHERE policy_id = $1", [big.id]);
    expect(rows).toEqual([{ actor_id: "key_deploy", change_note: "FIN-42 rollout", operation: "created" }]);

    expect((await files.planPolicyFile(ws, env, refunds())).summary).toEqual({ create: 0, update: 0, delete: 0, unchanged: 2 });
  });

  it("updates, deletes and creates only the file's own policies", async () => {
    const console = await createPolicy(ws, { environmentId: env, name: "Console rule", matchKind: "custom" });
    const other = await planAndApply(`apiVersion: anlyon.com/policies/v1
file: ops/other
environment: prod
policies:
  keep:
    name: Other file rule
    target: { customRequests: true }
`);
    expect(other.summary.create).toBe(1);

    const changed = refunds().replace("approvals: 2", "approvals: 3").replace(/  small-refunds:[\s\S]*$/, `  eu-refunds:
    name: EU refunds
    target: { action: refund_order }
    when: has(input.currency) && input.currency == "EUR"
`);
    const plan = await files.planPolicyFile(ws, env, changed);
    expect(plan.changes.map((c) => [c.op, c.key])).toEqual([
      ["update", "big-refunds"], ["create", "eu-refunds"], ["delete", "small-refunds"],
    ]);
    expect(plan.changes[0]).toMatchObject({ fields: ["requiredApprovals"] });
    await files.applyPolicyFile(ws, env, changed, plan.digest, operator);

    const names = (await listPolicies(ws, env)).map((p) => p.name).sort();
    expect(names).toEqual(["Big refunds need two approvers", "Console rule", "EU refunds", "Other file rule"]);
    expect((await listPolicies(ws, env)).find((p) => p.id === console.id)?.managedBy).toBeNull();
  });

  it("refuses a stale plan and writes nothing", async () => {
    const source = refunds().replace("approvals: 2", "approvals: 4");
    const plan = await files.planPolicyFile(ws, env, source);
    await createPolicy(ws, { environmentId: env, name: "Created after the plan", matchKind: "custom" });
    const before = { policies: await policyCount(), history: await historyCount() };
    await expect(files.applyPolicyFile(ws, env, source, plan.digest, operator)).rejects.toMatchObject({ statusCode: 409, code: "STALE_PLAN" });
    expect({ policies: await policyCount(), history: await historyCount() }).toEqual(before);
  });

  it("lets exactly one of two concurrent applies of the same plan win", async () => {
    const source = refunds().replace("priority: 10", "priority: 11");
    const plan = await files.planPolicyFile(ws, env, source);
    const outcomes = await Promise.allSettled([
      files.applyPolicyFile(ws, env, source, plan.digest, operator),
      files.applyPolicyFile(ws, env, source, plan.digest, operator),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((o) => o.status === "rejected")).toMatchObject({ reason: { statusCode: 409 } });
  });

  it("refuses console and API edits of a file-owned policy", async () => {
    const owned = (await listPolicies(ws, env)).find((p) => p.managedBy?.key === "big-refunds")!;
    await expect(updatePolicy(ws, owned.id, { enabled: false }, operator)).rejects.toMatchObject({ statusCode: 409, code: "POLICY_MANAGED_BY_FILE" });
    await expect(deletePolicy(ws, owned.id, operator)).rejects.toMatchObject({ statusCode: 409, code: "POLICY_MANAGED_BY_FILE" });
  });

  it("reports every problem instead of taking over, and refuses to apply them", async () => {
    const bad = `apiVersion: anlyon.com/policies/v1
file: payments/bad
environment: prod
policies:
  clash:
    name: Console rule
    target: { customRequests: true }
  typo:
    name: Typo
    target: { action: refund_order }
    when: input.ammount > 5
  ghost:
    name: Ghost
    target: { action: no_such_action }
  deny-all:
    name: Deny all
    target: { allRequests: true }
    effect: auto_deny
`;
    const plan = await files.planPolicyFile(ws, env, bad);
    expect(plan.errors.join("\n")).toMatch(/policies\.clash: a policy named "Console rule" already exists .*made in the console/);
    expect(plan.errors.join("\n")).toMatch(/policies\.typo\.when: No such key: ammount/);
    expect(plan.errors.join("\n")).toMatch(/policies\.ghost: action "no_such_action" does not exist/);
    expect(plan.errors.join("\n")).toMatch(/policies\.deny-all: .*acknowledgeBroadScope/);
    await expect(files.applyPolicyFile(ws, env, bad, plan.digest, operator)).rejects.toMatchObject({ statusCode: 400, code: "POLICY_FILE_INVALID" });
  });

  it.each([
    ["duplicate keys", "apiVersion: anlyon.com/policies/v1\nfile: a\nfile: b\nenvironment: prod\npolicies: {}\n", /not valid YAML/],
    ["aliases", "apiVersion: anlyon.com/policies/v1\nfile: a\nenvironment: prod\npolicies:\n  x: &p { name: X, target: { customRequests: true } }\n  y: *p\n", /aliases/],
    ["unknown fields", "apiVersion: anlyon.com/policies/v1\nfile: a\nenvironment: prod\npolicies:\n  x: { name: X, target: { customRequests: true }, approver: bob }\n", /Unrecognized key/],
    ["two targets", "apiVersion: anlyon.com/policies/v1\nfile: a\nenvironment: prod\npolicies:\n  x: { name: X, target: { customRequests: true, allRequests: true } }\n", /exactly one/],
    ["wrong version", "apiVersion: v0\nfile: a\nenvironment: prod\npolicies: {}\n", /apiVersion/],
    ["oversized", "apiVersion: anlyon.com/policies/v1\n# " + "x".repeat(300 * 1024), /larger than 256 KiB/],
  ])("refuses %s", async (_label, source, message) => {
    await expect(files.planPolicyFile(ws, env, source)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(message) });
  });

  it("refuses a file declared for another environment", async () => {
    await expect(files.planPolicyFile(ws, env, refunds().replace("environment: prod", "environment: dev")))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("tests fixtures against the environment as it would be after apply, writing nothing", async () => {
    const before = { policies: await policyCount(), history: await historyCount() };
    const source = refunds().replace("approvals: 2", "approvals: 2\n    effect: auto_deny");
    const result = await files.testPolicyFile(ws, env, source, `cases:
  - name: big refunds are denied under the new file
    request: { kind: action, action: refund_order, input: { amount: 60000 } }
    expect: { effect: auto_deny, policy: big-refunds }
  - name: small refunds run
    request: { kind: action, action: refund_order, input: { amount: 10 } }
    expect: { effect: auto_approve, policy: small-refunds }
  - name: a console policy still governs custom requests
    request: { kind: custom, input: {} }
    expect: { effect: require_approval }
  - name: deliberately wrong expectation
    request: { kind: action, action: refund_order, input: { amount: 60000 } }
    expect: { effect: auto_approve }
`);
    expect(result.results.map((r) => [r.name, r.pass])).toEqual([
      ["big refunds are denied under the new file", true],
      ["small refunds run", true],
      ["a console policy still governs custom requests", true],
      ["deliberately wrong expectation", false],
    ]);
    expect(result).toMatchObject({ passed: 3, failed: 1 });
    expect({ policies: await policyCount(), history: await historyCount() }).toEqual(before);
  });

  it("enforces the plan's policy allowance in the plan", async () => {
    const { getPlanLimits } = await import("../src/core/plans/limits.ts");
    const { rows } = await state.client!.query("SELECT plan, pending_plan, created_at FROM workspaces WHERE id = $1", [ws]);
    const row = rows[0] as { plan: string; pending_plan: string | null; created_at: Date };
    const limit = getPlanLimits(row.pending_plan ?? row.plan, { createdAt: row.created_at }).maxApprovalPoliciesPerEnvironment;
    expect(typeof limit).toBe("number");
    const many = Array.from({ length: (limit as number) + 1 }, (_, i) => `  p${i}:\n    name: Rule ${i}\n    target: { customRequests: true }\n    priority: ${200 + i}\n`).join("");
    const plan = await files.planPolicyFile(ws, env, `apiVersion: anlyon.com/policies/v1\nfile: bulk\nenvironment: prod\npolicies:\n${many}`);
    expect(plan.errors.join(" ")).toMatch(/would hold \d+ policies; the plan allows \d+/);
  });
});
