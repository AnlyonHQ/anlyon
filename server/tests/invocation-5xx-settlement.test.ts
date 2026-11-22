import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));
const safeFetch = vi.hoisted(() => vi.fn());

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client) };
});
vi.mock("../src/lib/safe-http.ts", async (original) => ({
  ...await original<typeof import("../src/lib/safe-http.ts")>(),
  safeFetch: (...args: unknown[]) => safeFetch(...args),
}));
vi.mock("../src/core/environments/halt.ts", () => ({ isEnvironmentHalted: async () => false }));
vi.mock("../src/core/actions/secrets.ts", () => ({
  assertSecretsMayReachHost: async () => {},
  resolveSecrets: async () => new Map(),
  resolveAccountHost: async () => null,
}));
vi.mock("../src/core/runs/service.ts", () => ({ getRunWithTree: async () => ({}), ingestSpans: async () => {} }));
vi.mock("../src/core/events/emitter.ts", () => ({ emitEvent: () => {} }));

const { eq } = await import("drizzle-orm");
const { db } = await import("../src/db/index.ts");
const { actions, actionInvocations } = await import("../src/db/schema/actions.ts");
const { executeInvocation } = await import("../src/core/actions/execute.ts");
const { resolveInvocation } = await import("../src/core/actions/resolution.ts");
const { recordInvocationOutcome } = await import("../src/core/billing/action-accounting.ts");

const ws = "00000000-0000-4000-8000-00000000b5a1";
const env = "00000000-0000-4000-8000-00000000b5a2";
const agentKey = "00000000-0000-4000-8000-00000000b5a3";
const operator = { type: "api_key" as const, id: "00000000-0000-4000-8000-00000000b5a4" };
const MONTH = new Date().toISOString().slice(0, 7);
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => state.client!.query<T>(text, params);
let actionRowId = "";
let n = 0;

async function admitted(): Promise<string> {
  const id = `inv_5xx_${++n}`;
  const { rows: [reservation] } = await sql<{ id: string }>(
    `INSERT INTO budget_reservations (api_key_id, workspace_id, environment_id, effect_id, fingerprint, dimension, amount, month, cost_microcents)
     VALUES ($1, $2, $3, $4, 'fp', 'actionInvokes', 1, $5, 100) RETURNING id`,
    [agentKey, ws, env, `effect_${id}`, MONTH],
  );
  await sql("UPDATE budget_periods SET action_invokes = action_invokes + 1, cost_microcents = cost_microcents + 100 WHERE api_key_id = $1 AND month = $2", [agentKey, MONTH]);
  await sql(
    `INSERT INTO action_invocations (workspace_id, environment_id, action_id, invocation_id, status, input, budget_reservation_id, requested_by_key_id)
     VALUES ($1, $2, $3, $4, 'running', '{}', $5, $6)`,
    [ws, env, actionRowId, id, reservation.id, agentKey],
  );
  return id;
}

async function dispatch(id: string, status: number) {
  safeFetch.mockResolvedValueOnce(new Response('{"error":"x"}', { status }));
  const [action] = await db.select().from(actions).where(eq(actions.id, actionRowId));
  const [invocation] = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, id));
  return executeInvocation(action, invocation);
}

const ledgers = async () => {
  const usage = (await sql<{ action_reserved: string; action_billed: string }>(
    "SELECT action_reserved, action_billed FROM workspace_usage_periods WHERE workspace_id = $1 AND month = $2", [ws, MONTH],
  )).rows[0];
  const budget = (await sql<{ action_invokes: string }>(
    "SELECT action_invokes FROM budget_periods WHERE api_key_id = $1 AND month = $2", [agentKey, MONTH],
  )).rows[0];
  return { reserved: Number(usage?.action_reserved ?? 0), billed: Number(usage?.action_billed ?? 0), budget: Number(budget.action_invokes) };
};
const row = async (id: string) => (await sql<{ status: string; usage_state: string | null; reservation: string; completed_at: Date | null; id: string }>(
  `SELECT i.id, i.status, i.usage_state, i.completed_at, r.state AS reservation
     FROM action_invocations i JOIN budget_reservations r ON r.id = i.budget_reservation_id WHERE i.invocation_id = $1`, [id],
)).rows[0];

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', 'ws-5xx')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug) VALUES ($1, $2, 'prod', 'prod')", [env, ws]);
  for (const [id, name] of [[agentKey, "agent"], [operator.id, "operator"]]) {
    await sql("INSERT INTO api_keys (id, workspace_id, environment_id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4, $4, $4)", [id, ws, env, name]);
  }
  await sql("INSERT INTO budget_periods (api_key_id, month) VALUES ($1, $2)", [agentKey, MONTH]);
  actionRowId = (await sql<{ id: string }>(
    "INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template, method) VALUES ($1, $2, 'act_refund', 'refund_order', 'https://api.provider.example/v1/refunds', 'POST') RETURNING id",
    [ws, env],
  )).rows[0].id;
}, 120_000);
beforeEach(() => safeFetch.mockReset());

describe("a 5xx outcome holds its usage", () => {
  it("records unknown and holds the reservation: not billed, not refunded", async () => {
    const id = await admitted();
    const before = await ledgers();
    const result = await dispatch(id, 500);

    expect(result.status).toBe("unknown");
    expect(await row(id)).toMatchObject({ status: "unknown", usage_state: "reserved", reservation: "reserved" });
    expect(await ledgers()).toEqual({ ...before, reserved: before.reserved + 1 });
  });

  it("resolved as failed: releases the quota and refunds the budget, exactly once", async () => {
    const id = await admitted();
    const before = await ledgers();
    await dispatch(id, 503);
    await resolveInvocation(ws, env, id, { outcome: "failed", evidence: "Provider shows no refund was created." }, operator);

    const settled = await ledgers();
    expect(settled).toEqual({ reserved: before.reserved, billed: before.billed, budget: before.budget - 1 });
    expect(await row(id)).toMatchObject({ status: "failed", usage_state: "released", reservation: "refunded" });

    await expect(resolveInvocation(ws, env, id, { outcome: "failed", evidence: "again" }, operator)).rejects.toMatchObject({ statusCode: 409 });
    await recordInvocationOutcome(ws, (await row(id)).id, {}, "released");
    await recordInvocationOutcome(ws, (await row(id)).id, {}, "billed");
    expect(await ledgers()).toEqual(settled);
    expect((await row(id)).reservation).toBe("refunded");
  });

  it("resolved as succeeded: bills the held usage and settles the budget, exactly once", async () => {
    const id = await admitted();
    const before = await ledgers();
    await dispatch(id, 502);
    await resolveInvocation(ws, env, id, { outcome: "succeeded", evidence: "Provider shows refund re_42." }, operator);

    const settled = await ledgers();
    expect(settled).toEqual({ reserved: before.reserved, billed: before.billed + 1, budget: before.budget });
    expect(await row(id)).toMatchObject({ status: "succeeded", usage_state: "billed", reservation: "settled" });

    await expect(resolveInvocation(ws, env, id, { outcome: "failed", evidence: "changed my mind" }, operator)).rejects.toMatchObject({ statusCode: 409 });
    await recordInvocationOutcome(ws, (await row(id)).id, {}, "billed");
    await recordInvocationOutcome(ws, (await row(id)).id, {}, "released");
    expect(await ledgers()).toEqual(settled);
    expect((await row(id)).reservation).toBe("settled");
  });

  it("keeps the completion time the dispatch recorded", async () => {
    const id = await admitted();
    await dispatch(id, 500);
    const recorded = (await row(id)).completed_at;
    expect(recorded).not.toBeNull();
    await resolveInvocation(ws, env, id, { outcome: "failed", evidence: "No refund at the provider." }, operator);
    expect((await row(id)).completed_at).toEqual(recorded);
  });

  it("stamps a missing completion time from the database clock", async () => {
    const id = await admitted();
    await sql("UPDATE action_invocations SET status = 'unknown', completed_at = NULL WHERE invocation_id = $1", [id]);
    await resolveInvocation(ws, env, id, { outcome: "failed", evidence: "No refund at the provider." }, operator);
    const { rows: [stamp] } = await sql<{ ok: boolean }>(
      `SELECT i.completed_at IS NOT NULL AND i.completed_at >= i.created_at AND i.completed_at <= (clock_timestamp() at time zone 'utc') AS ok
         FROM action_invocations i WHERE i.invocation_id = $1`, [id],
    );
    expect(stamp.ok).toBe(true);
  });
});

describe("definite answers still bill at dispatch", () => {
  it("a 2xx is succeeded and billed", async () => {
    const id = await admitted();
    const before = await ledgers();
    expect((await dispatch(id, 200)).status).toBe("succeeded");
    expect(await row(id)).toMatchObject({ usage_state: "billed", reservation: "settled" });
    expect(await ledgers()).toEqual({ ...before, billed: before.billed + 1 });
  });

  it("a 4xx is failed and billed, and cannot be resolved", async () => {
    const id = await admitted();
    const before = await ledgers();
    expect((await dispatch(id, 422)).status).toBe("failed");
    expect(await row(id)).toMatchObject({ usage_state: "billed", reservation: "settled" });
    expect(await ledgers()).toEqual({ ...before, billed: before.billed + 1 });
    await expect(resolveInvocation(ws, env, id, { outcome: "failed", evidence: "x" }, operator)).rejects.toMatchObject({ statusCode: 409 });
  });
});
