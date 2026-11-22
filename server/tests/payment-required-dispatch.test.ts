import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { usePlanFixture } from "./support/plan-fixture.ts";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));
vi.mock("../src/core/events/emitter.ts", () => ({ emitEvent: vi.fn() }));
vi.mock("../src/core/notifications/notification-service.ts", () => ({ createAndSendNotification: vi.fn() }));
vi.mock("../src/core/assistant/service.ts", () => ({ onApprovalAnnounced: async () => false }));
vi.mock("../src/lib/product-events.ts", () => ({ captureMilestoneOnce: vi.fn() }));
vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client) };
});
vi.mock("../src/core/actions/execute.ts", async (original) => ({
  ...await original<typeof import("../src/core/actions/execute.ts")>(),
  executeInvocation: vi.fn(async () => { throw new Error("must not dispatch"); }),
}));

const plans = usePlanFixture({
  free: { usagePolicy: { actionInvokes: { kind: "payment-required" } } },
  starter: { usagePolicy: { actionInvokes: { kind: "included-with-grace", includedUnits: 1_000, graceCapUnits: 1_100 } } },
}, { purchasable: true });

const { invokeAction } = await import("../src/core/actions/service.ts");
const { reserveActionExecution } = await import("../src/core/billing/action-accounting.ts");
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const { PaymentRequiredError, assertActionsEntitled, checkActionInvokeQuota } = await import("../src/core/billing/usage-enforcement.ts");
const { resetPlanProvider, setPlanProvider } = await import("../src/core/plans/limits.ts");
const { Hono } = await import("hono");

const ws = "00000000-0000-4000-8000-0000000402c1";
const env = "00000000-0000-4000-8000-0000000402c2";
const MONTH = new Date().toISOString().slice(0, 7);
const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);
const count = async (table: string) => Number((await sql(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [ws])).rows[0].n);

beforeAll(async () => {
  const { redis } = await import("../src/lib/redis.ts");
  vi.spyOn(redis, "incr").mockResolvedValue(1);
  await sql("INSERT INTO workspaces (id, name, slug, plan) VALUES ($1, 'ws', 'ws-402-core', 'free')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug) VALUES ($1, $2, 'prod', 'prod')", [env, ws]);
  await sql(`INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template, input_schema)
    VALUES ($1, $2, 'act_402_core', 'refund_order', 'https://example.test/refund', '{"type":"object"}')`, [ws, env]);
}, 120_000);
afterAll(() => resetPlanProvider());

describe("402 PAYMENT_REQUIRED on a payment-required plan", () => {
  it("refuses an invoke before any invocation exists", async () => {
    await sql("UPDATE workspaces SET plan = 'free' WHERE id = $1", [ws]);
    const before = await count("action_invocations");
    await expect(invokeAction(ws, "refund_order", {}, { environmentId: env }))
      .rejects.toMatchObject({ statusCode: 402, code: "PAYMENT_REQUIRED", details: { billingUrl: expect.stringMatching(/\/settings\/billing$/) } });
    expect(await count("action_invocations")).toBe(before);
  });

  it("refuses an action that needs approval without parking an approval", async () => {
    await sql("UPDATE actions SET requires_approval = true WHERE workspace_id = $1", [ws]);
    try {
      await expect(invokeAction(ws, "refund_order", {}, { environmentId: env })).rejects.toMatchObject({ statusCode: 402 });
      expect(await count("approvals")).toBe(0);
    } finally {
      await sql("UPDATE actions SET requires_approval = false WHERE workspace_id = $1", [ws]);
    }
  });

  it("refuses at the dispatch reservation, where approvals and resumes arrive, and releases the call", async () => {
    const { rows: [action] } = await sql("SELECT id FROM actions WHERE workspace_id = $1", [ws]);
    const { rows: [invocation] } = await sql(`INSERT INTO action_invocations (workspace_id, environment_id, action_id, invocation_id, status, input)
      VALUES ($1, $2, $3, 'inv_402_core_resume', 'running', '{}') RETURNING id`, [ws, env, action.id]);
    await expect(reserveActionExecution(ws, String(invocation.id))).rejects.toBeInstanceOf(PaymentRequiredError);
    const { rows: [after] } = await sql("SELECT status, usage_state, dispatch_claimed_at FROM action_invocations WHERE id = $1", [invocation.id]);
    expect(after).toMatchObject({ status: "failed", usage_state: "released", dispatch_claimed_at: null });
  });

  it("answers the REST route (and so the SDKs and MCP) with status 402 and the code", async () => {
    const app = new Hono();
    app.onError((err, c) => buildErrorResponse(err, c));
    app.post("/invoke", async () => { await invokeAction(ws, "refund_order", {}, { environmentId: env }); return new Response(null); });
    const response = await app.request("/invoke", { method: "POST" });
    expect(response.status).toBe(402);
    expect(((await response.json()) as any).error.code).toBe("PAYMENT_REQUIRED");
  });

  it("does not apply once the plan's action policy is anything else", async () => {
    plans.set("free", { usagePolicy: { actionInvokes: { kind: "hard-cap", capUnits: 10 } } });
    try {
      await expect(assertActionsEntitled(ws)).resolves.toBeUndefined();
    } finally {
      plans.set("free", { usagePolicy: { actionInvokes: { kind: "payment-required" } } });
    }
  });

  it("never applies without a plan provider: the self-host core caps nothing", async () => {
    resetPlanProvider();
    try {
      await expect(assertActionsEntitled(ws)).resolves.toBeUndefined();
      await expect(checkActionInvokeQuota(ws)).resolves.toBeUndefined();
    } finally {
      setPlanProvider(plans.provider);
    }
  });
});

describe("the action allowance on a plan with a grace buffer", () => {
  beforeAll(async () => {
    await sql("UPDATE workspaces SET plan = 'starter' WHERE id = $1", [ws]);
  });

  it("refuses past the grace cap with QUOTA_EXCEEDED naming the way past it", async () => {
    await sql(`INSERT INTO workspace_usage_periods (workspace_id, month, action_billed) VALUES ($1, $2, 1100)
      ON CONFLICT (workspace_id, month) DO UPDATE SET action_billed = 1100, action_reserved = 0`, [ws, MONTH]);
    const error = await invokeAction(ws, "refund_order", {}, { environmentId: env }).catch((caught) => caught);
    expect(error).toMatchObject({ statusCode: 429, code: "QUOTA_EXCEEDED" });
    expect(error.message).toContain("1,100");
    expect(error.message).toContain("action pack");
  });

  it("admits the last slot under the grace cap", async () => {
    await sql("UPDATE workspace_usage_periods SET action_billed = 1099, action_reserved = 0 WHERE workspace_id = $1 AND month = $2", [ws, MONTH]);
    await expect(checkActionInvokeQuota(ws)).resolves.toBeUndefined();
    await sql("UPDATE workspace_usage_periods SET action_billed = 1100 WHERE workspace_id = $1 AND month = $2", [ws, MONTH]);
  });

  it("lets a prepaid action pack raise the cap; it is valid for 12 months", async () => {
    await sql("INSERT INTO workspace_action_credits (workspace_id, units, source_order_id, expires_at) VALUES ($1, 500, 'ord_402_core_pack', now() + interval '12 months')", [ws]);
    await expect(checkActionInvokeQuota(ws)).resolves.toBeUndefined();
  });

  it("stops counting a pack once it has expired", async () => {
    await sql("UPDATE workspace_action_credits SET expires_at = now() - interval '1 day' WHERE source_order_id = 'ord_402_core_pack'");
    await expect(checkActionInvokeQuota(ws)).rejects.toMatchObject({ statusCode: 429, code: "QUOTA_EXCEEDED" });
  });
});
