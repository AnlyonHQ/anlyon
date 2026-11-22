import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));
const executed = vi.hoisted(() => vi.fn());
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
vi.mock("../src/core/billing/usage-enforcement.ts", async (original) => ({
  ...await original<typeof import("../src/core/billing/usage-enforcement.ts")>(),
  checkActionInvokeQuota: async () => {},
}));
vi.mock("../src/core/actions/execute.ts", async (original) => {
  const real = await original<typeof import("../src/core/actions/execute.ts")>();
  return {
    ...real,
    executeInvocation: async (action: { name: string }, invocation: { id: string }) => {
      executed(invocation.id);
      const { rows } = await state.client!.query(
        "UPDATE action_invocations SET status = 'succeeded', response_status = 200, completed_at = now() WHERE id = $1 RETURNING *",
        [invocation.id],
      );
      return real.toInvocation(camel(rows[0] as Record<string, unknown>) as never, action.name);
    },
  };
});

function camel(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));
}

const { invokeAction, replayInvocationForKey } = await import("../src/core/actions/service.ts");
const { usePlanFixture } = await import("./support/plan-fixture.ts");
usePlanFixture({ "*": { maxPendingApprovals: 200 } });

const ws = "00000000-0000-4000-8000-0000000000c1";
const env = "00000000-0000-4000-8000-0000000000d1";
const otherEnv = "00000000-0000-4000-8000-0000000000d2";
const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);
const idem = (key: string, fingerprint = `fp_${key}`) => ({ environmentId: env, idempotency: { key, fingerprint } });
const invocationsFor = async (key: string) =>
  (await sql("SELECT invocation_id, status FROM action_invocations WHERE idempotency_key = $1", [key])).rows;

beforeAll(async () => {
  const { redis } = await import("../src/lib/redis.ts");
  vi.spyOn(redis, "incr").mockResolvedValue(1);
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', 'ws-idem')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug) VALUES ($1, $3, 'prod', 'prod'), ($2, $3, 'dev', 'dev')", [env, otherEnv, ws]);
  for (const environmentId of [env, otherEnv]) {
    await sql(
      `INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template, input_schema)
       VALUES ($1, $2, $3, 'refund_order', 'https://example.test/refund', $4)`,
      [ws, environmentId, `act_${environmentId.slice(-2)}`, JSON.stringify({ type: "object", required: ["amount"], properties: { amount: { type: "number" } } })],
    );
  }
}, 120_000);
beforeEach(() => executed.mockClear());

describe("durable invocation idempotency", () => {
  it("leaves a session key free when approval admission is refused, then creates one linked approval", async () => {
    await sql("UPDATE actions SET requires_approval = true WHERE environment_id = $1", [env]);
    await sql(`INSERT INTO approvals (workspace_id, environment_id, approval_id, kind, status, title, expires_at)
      SELECT $1, $2, 'apr_quota_' || n, 'custom', 'pending', 'Quota fixture', now() + interval '1 day'
      FROM generate_series(1, 200) n`, [ws, env]);
    try {
      await expect(invokeAction(ws, "refund_order", { amount: 10 }, idem("k_quota")))
        .rejects.toMatchObject({ statusCode: 429 });
      expect(await invocationsFor("k_quota")).toHaveLength(0);
      expect(await replayInvocationForKey(ws, env, "k_quota", "fp_k_quota")).toBeNull();
      await sql("DELETE FROM approvals WHERE approval_id LIKE 'apr_quota_%'");
      const accepted = await invokeAction(ws, "refund_order", { amount: 10 }, idem("k_quota"));
      expect(accepted).toMatchObject({ status: "pending_approval", pendingApproval: true });
      expect(accepted.approvalId).toBeTruthy();
      expect(await replayInvocationForKey(ws, env, "k_quota", "fp_k_quota"))
        .toMatchObject({ id: accepted.id, approvalId: accepted.approvalId, status: "pending_approval" });
      expect(executed).not.toHaveBeenCalled();
      await sql(`INSERT INTO approvals (workspace_id, environment_id, approval_id, kind, status, title, expires_at)
        SELECT $1, $2, 'apr_quota_' || n, 'custom', 'pending', 'Quota fixture', now() + interval '1 day'
        FROM generate_series(1, 198) n`, [ws, env]);
      const concurrent = await Promise.all([1, 2].map(() => invokeAction(ws, "refund_order", { amount: 10 }, idem("k_last_slot"))));
      expect(new Set(concurrent.map((result) => result.id)).size).toBe(1);
      expect(concurrent.filter((result) => result.replayed)).toHaveLength(1);
    } finally {
      await sql("DELETE FROM approvals WHERE approval_id LIKE 'apr_quota_%'");
      await sql("UPDATE actions SET requires_approval = false WHERE environment_id = $1", [env]);
    }
  });

  it("rolls back the invocation and key if the approval write fails after the invocation insert", async () => {
    await sql("UPDATE actions SET requires_approval = true WHERE environment_id = $1", [env]);
    await sql(`CREATE FUNCTION reject_test_approval() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected approval failure'; END; $$`);
    await sql("CREATE TRIGGER reject_test_approval BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION reject_test_approval()");
    try {
      await expect(invokeAction(ws, "refund_order", { amount: 10 }, idem("k_rollback"))).rejects.toThrow();
      expect(await invocationsFor("k_rollback")).toHaveLength(0);
      expect(executed).not.toHaveBeenCalled();
    } finally {
      await sql("DROP TRIGGER reject_test_approval ON approvals");
      await sql("DROP FUNCTION reject_test_approval()");
      await sql("UPDATE actions SET requires_approval = false WHERE environment_id = $1", [env]);
    }
  });

  it("records the key with the invocation and replays its current state without dispatching", async () => {
    const first = await invokeAction(ws, "refund_order", { amount: 10 }, idem("k_replay"));
    expect(first.replayed).toBeUndefined();
    expect(executed).toHaveBeenCalledTimes(1);

    const replay = await replayInvocationForKey(ws, env, "k_replay", "fp_k_replay");
    expect(replay).toMatchObject({ id: first.id, status: "succeeded", pendingApproval: false, replayed: true });
    expect(executed).toHaveBeenCalledTimes(1);
  });

  it("refuses the same key from another caller or body instead of revealing the invocation", async () => {
    await invokeAction(ws, "refund_order", { amount: 10 }, idem("k_owner"));
    await expect(replayInvocationForKey(ws, env, "k_owner", "fp_someone_else"))
      .rejects.toMatchObject({ statusCode: 409, code: "idempotency_key_reuse" });
  });

  it("lets concurrent duplicates that both miss the replay check execute exactly once", async () => {
    const results = await Promise.all([1, 2, 3].map(() => invokeAction(ws, "refund_order", { amount: 10 }, idem("k_race"))));
    expect(executed).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(2);
    expect(await invocationsFor("k_race")).toHaveLength(1);
  });

  it("refuses a concurrent duplicate with a different fingerprint", async () => {
    const outcomes = await Promise.allSettled([
      invokeAction(ws, "refund_order", { amount: 10 }, idem("k_race_mismatch", "fp_a")),
      invokeAction(ws, "refund_order", { amount: 99 }, idem("k_race_mismatch", "fp_b")),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((o) => o.status === "rejected")).toMatchObject({ reason: { statusCode: 409 } });
    expect(executed).toHaveBeenCalledTimes(1);
  });

  it("keeps the key after the invocation fails: a retry sees the failure, not a new execution", async () => {
    const first = await invokeAction(ws, "refund_order", { amount: 10 }, idem("k_failed"));
    await sql("UPDATE action_invocations SET status = 'failed' WHERE invocation_id = $1", [first.id]);
    expect(await replayInvocationForKey(ws, env, "k_failed", "fp_k_failed")).toMatchObject({ id: first.id, status: "failed" });
  });

  it("leaves the key free when the request is refused before the invocation is recorded", async () => {
    await expect(invokeAction(ws, "refund_order", { amount: "ten" }, idem("k_invalid"))).rejects.toMatchObject({ statusCode: 400 });
    expect(await replayInvocationForKey(ws, env, "k_invalid", "fp_k_invalid")).toBeNull();
    expect(await invocationsFor("k_invalid")).toHaveLength(0);
  });

  it("scopes keys to the environment and leaves key-less invocations unaffected", async () => {
    await invokeAction(ws, "refund_order", { amount: 10 }, idem("k_env"));
    await invokeAction(ws, "refund_order", { amount: 10 }, { environmentId: otherEnv, idempotency: { key: "k_env", fingerprint: "fp_k_env" } });
    await invokeAction(ws, "refund_order", { amount: 10 }, { environmentId: env });
    await invokeAction(ws, "refund_order", { amount: 10 }, { environmentId: env });
    expect(executed).toHaveBeenCalledTimes(4);
    expect(await replayInvocationForKey(ws, otherEnv, "k_env", "fp_k_env")).toMatchObject({ replayed: true });
  });
});
