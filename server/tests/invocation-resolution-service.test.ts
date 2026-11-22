import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));
const dispatched = vi.hoisted(() => vi.fn());

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client) };
});
vi.mock("../src/core/billing/usage-enforcement.ts", async (original) => ({
  ...await original<typeof import("../src/core/billing/usage-enforcement.ts")>(),
  checkActionInvokeQuota: async () => {},
}));
vi.mock("../src/core/actions/execute.ts", async (original) => {
  const real = await original<typeof import("../src/core/actions/execute.ts")>();
  return {
    ...real,
    executeInvocation: async (action: { name: string }, invocation: { id: string }) => {
      dispatched(invocation.id);
      const { rows } = await state.client!.query("UPDATE action_invocations SET status = 'succeeded' WHERE id = $1 RETURNING *", [invocation.id]);
      const row = Object.fromEntries(Object.entries(rows[0] as Record<string, unknown>).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));
      return real.toInvocation(row as never, action.name);
    },
  };
});

const { resolveInvocation } = await import("../src/core/actions/resolution.ts");
const { getInvocation, invokeAction } = await import("../src/core/actions/service.ts");

const ws = "00000000-0000-4000-8000-00000000a0a1";
const env = "00000000-0000-4000-8000-00000000a0a2";
const agentKey = "00000000-0000-4000-8000-00000000a0a3";
const operatorKey = "00000000-0000-4000-8000-00000000a0a4";
const MONTH = "2026-09";
const operator = { type: "api_key" as const, id: operatorKey };
const evidence = { evidence: "Checked the payment provider dashboard: no charge was created." };
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => state.client!.query<T>(text, params);
let refundAction = "";
let otherAction = "";
let n = 0;

async function unknownInvocation(actionId = refundAction): Promise<string> {
  const id = `inv_unknown_${++n}`;
  const { rows: [reservation] } = await sql<{ id: string }>(
    `INSERT INTO budget_reservations (api_key_id, workspace_id, environment_id, effect_id, fingerprint, dimension, amount, month, cost_microcents)
     VALUES ($1, $2, $3, $4, 'fp', 'actionInvokes', 1, $5, 100) RETURNING id`,
    [agentKey, ws, env, `effect_${id}`, MONTH],
  );
  await sql("UPDATE budget_periods SET action_invokes = action_invokes + 1, cost_microcents = cost_microcents + 100 WHERE api_key_id = $1 AND month = $2", [agentKey, MONTH]);
  await sql("UPDATE workspace_usage_periods SET action_reserved = action_reserved + 1 WHERE workspace_id = $1 AND month = $2", [ws, MONTH]);
  await sql(
    `INSERT INTO action_invocations (workspace_id, environment_id, action_id, invocation_id, status, input, usage_state, usage_month,
       budget_reservation_id, requested_by_key_id, error_message, dispatch_claimed_at)
     VALUES ($1, $2, $3, $4, 'unknown', '{}', 'reserved', $5, $6, $7, 'Timed out after the request was sent', now())`,
    [ws, env, actionId, id, MONTH, reservation.id, agentKey],
  );
  return id;
}
const ledgers = async () => ({
  usage: (await sql<{ action_reserved: string; action_billed: string }>("SELECT action_reserved, action_billed FROM workspace_usage_periods WHERE workspace_id = $1", [ws])).rows[0],
  budget: (await sql<{ action_invokes: string }>("SELECT action_invokes FROM budget_periods WHERE api_key_id = $1", [agentKey])).rows[0],
});
const reservationState = async (invocationId: string) => (await sql<{ state: string }>(
  "SELECT r.state FROM budget_reservations r JOIN action_invocations i ON i.budget_reservation_id = r.id WHERE i.invocation_id = $1", [invocationId],
)).rows[0].state;

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', 'ws-resolve')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug) VALUES ($1, $2, 'prod', 'prod')", [env, ws]);
  for (const [id, name] of [[agentKey, "agent"], [operatorKey, "operator"]]) {
    await sql("INSERT INTO api_keys (id, workspace_id, environment_id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4, $4, $4)", [id, ws, env, name]);
  }
  await sql("INSERT INTO budget_periods (api_key_id, month) VALUES ($1, $2)", [agentKey, MONTH]);
  await sql("INSERT INTO workspace_usage_periods (workspace_id, month) VALUES ($1, $2)", [ws, MONTH]);
  const action = async (name: string) => (await sql<{ id: string }>(
    "INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template) VALUES ($1, $2, $3, $4, 'https://e.test') RETURNING id",
    [ws, env, `act_${name}`, name],
  )).rows[0].id;
  refundAction = await action("refund_order");
  otherAction = await action("send_email");
}, 120_000);
beforeEach(() => dispatched.mockClear());

describe("resolving an unknown invocation", () => {
  it("keeps evidence append-only while allowing owning-invocation erasure", async () => {
    const id = await unknownInvocation();
    await resolveInvocation(ws, env, id, { outcome: "failed", ...evidence }, operator);
    const where = "WHERE invocation_id = (SELECT id FROM action_invocations WHERE invocation_id = $1)";
    await expect(sql(`UPDATE invocation_resolutions SET evidence = 'replacement' ${where}`, [id])).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM invocation_resolutions ${where}`, [id])).rejects.toThrow(/append-only/);
    await expect(sql("TRUNCATE invocation_resolutions")).rejects.toThrow(/append-only/);
    await sql("DELETE FROM action_invocations WHERE invocation_id = $1", [id]);
    expect((await sql(`SELECT * FROM invocation_resolutions ${where}`, [id])).rows).toEqual([]);
  });
  it("resolved as failed: records evidence, releases usage and refunds the budget, never dispatches", async () => {
    const id = await unknownInvocation();
    const before = await ledgers();
    const result = await resolveInvocation(ws, env, id, { outcome: "failed", ...evidence, externalReference: "ch_none" }, operator);

    expect(result).toMatchObject({ id, status: "failed", resolution: { outcome: "failed", externalReference: "ch_none", resolvedBy: operator } });
    const after = await ledgers();
    expect(Number(after.usage.action_reserved)).toBe(Number(before.usage.action_reserved) - 1);
    expect(after.usage.action_billed).toBe(before.usage.action_billed);
    expect(Number(after.budget.action_invokes)).toBe(Number(before.budget.action_invokes) - 1);
    expect(await reservationState(id)).toBe("refunded");
    expect(dispatched).not.toHaveBeenCalled();
    expect((await getInvocation(ws, id, env)).resolution).toMatchObject({ evidence: evidence.evidence });
  });

  it("resolved as succeeded: bills the reserved usage and settles the budget", async () => {
    const id = await unknownInvocation();
    const before = await ledgers();
    await resolveInvocation(ws, env, id, { outcome: "succeeded", evidence: "Provider shows charge ch_42 captured." }, operator);
    const after = await ledgers();
    expect(Number(after.usage.action_reserved)).toBe(Number(before.usage.action_reserved) - 1);
    expect(Number(after.usage.action_billed)).toBe(Number(before.usage.action_billed) + 1);
    expect(after.budget.action_invokes).toBe(before.budget.action_invokes);
    expect(await reservationState(id)).toBe("settled");
  });

  it("refuses the key that requested the invocation", async () => {
    const id = await unknownInvocation();
    await expect(resolveInvocation(ws, env, id, { outcome: "failed", ...evidence }, { type: "api_key", id: agentKey }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect((await getInvocation(ws, id, env)).status).toBe("unknown");
  });

  it("has one winner under concurrent resolution, and refuses anything not unknown", async () => {
    const id = await unknownInvocation();
    const outcomes = await Promise.allSettled([
      resolveInvocation(ws, env, id, { outcome: "failed", ...evidence }, operator),
      resolveInvocation(ws, env, id, { outcome: "succeeded", evidence: "Provider shows it went through." }, operator),
      resolveInvocation(ws, env, id, { outcome: "failed", ...evidence }, { type: "user", id: "usr_admin" }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected").every((o) => (o as PromiseRejectedResult).reason.statusCode === 409)).toBe(true);
    const { rows } = await sql("SELECT count(*)::int AS n FROM invocation_resolutions r JOIN action_invocations i ON i.id = r.invocation_id WHERE i.invocation_id = $1", [id]);
    expect(rows[0]).toEqual({ n: 1 });
  });

  it("keeps resolutions append-only in the database", async () => {
    const id = await unknownInvocation();
    await resolveInvocation(ws, env, id, { outcome: "failed", ...evidence }, operator);
    await expect(sql("UPDATE invocation_resolutions SET outcome = 'succeeded'")).rejects.toThrow(/append-only/);
  });

  it("requires an identified operator", async () => {
    const id = await unknownInvocation();
    await expect(resolveInvocation(ws, env, id, { outcome: "failed", ...evidence }, undefined)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("deliberate retries", () => {
  const retry = (retryOf: string, key?: string, actionName = "refund_order") => invokeAction(ws, actionName, {}, {
    environmentId: env, retryOf, ...(key ? { idempotency: { key, fingerprint: `fp_${key}` } } : {}),
  });

  it("refuses to retry an unknown invocation until it is resolved", async () => {
    const id = await unknownInvocation();
    await expect(retry(id, "k_retry_unknown")).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/resolve it/) });
    expect(dispatched).not.toHaveBeenCalled();
  });

  it("retries a resolved-failed invocation once, under a new key, linked both ways", async () => {
    const id = await unknownInvocation();
    await resolveInvocation(ws, env, id, { outcome: "failed", ...evidence }, operator);
    await expect(retry(id)).rejects.toMatchObject({ statusCode: 400 });

    const retried = await retry(id, "k_retry_1");
    expect(retried.retryOf).toBe(id);
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect((await getInvocation(ws, id, env)).retriedBy).toBe(retried.id);
    await expect(retry(id, "k_retry_2")).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already been retried/) });
  });

  it("refuses to retry a succeeded invocation or one of another action", async () => {
    const id = await unknownInvocation();
    await resolveInvocation(ws, env, id, { outcome: "succeeded", evidence: "Provider shows it went through." }, operator);
    await expect(retry(id, "k_retry_ok")).rejects.toMatchObject({ statusCode: 409 });

    const other = await unknownInvocation(otherAction);
    await resolveInvocation(ws, env, other, { outcome: "failed", ...evidence }, operator);
    await expect(retry(other, "k_retry_wrong_action")).rejects.toMatchObject({ statusCode: 400 });
  });
});
