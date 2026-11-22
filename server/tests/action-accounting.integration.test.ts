import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usePlanFixture } from "./support/plan-fixture.ts";

process.env.REDIS_URL ??= "redis://127.0.0.1:6379";

const INCLUDED = 1_000;
const GRACE_CAP = 1_100;
const MESSAGE_CAP = 1_000;
const FREE_ACTION_CAP = 100;

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("durable action accounting (real Postgres)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 1500 });
  let accounting: typeof import("../src/core/billing/action-accounting.ts");
  let db: typeof import("../src/db/index.ts")["db"];
  let workspaceId: string;
  let environmentId: string;
  let actionId: string;
  let month: string;
  const testRedisKeys: string[] = [];

  beforeAll(async () => {
    usePlanFixture({
      starter: {
        usagePolicy: {
          actionInvokes: { kind: "included-with-grace", includedUnits: INCLUDED, graceCapUnits: GRACE_CAP },
          messages: { kind: "hard-cap", capUnits: MESSAGE_CAP },
        },
      },
      free: {
        maxActions: 5,
        maxEnvironments: 1,
        features: { protectedProduction: false },
        usagePolicy: { actionInvokes: { kind: "hard-cap", capUnits: FREE_ACTION_CAP } },
      },
      production: { maxEnvironments: 2 },
      growth: {
        maxEnvironments: 3,
        usagePolicy: { actionInvokes: { kind: "included-with-grace", includedUnits: 10_000, graceCapUnits: 11_000 } },
      },
    }, { purchasable: true });
    await pool.query("SELECT 1");
    accounting = await import("../src/core/billing/action-accounting.ts");
    ({ db } = await import("../src/db/index.ts"));
  });

  beforeEach(async () => {
    month = new Date().toISOString().slice(0, 7);
    workspaceId = (await pool.query(
      "INSERT INTO workspaces (name, slug, plan) VALUES ('Accounting test', $1, 'starter') RETURNING id",
      [`core-accounting-${randomUUID()}`],
    )).rows[0].id;
    environmentId = (await pool.query(
      "INSERT INTO environments (workspace_id, name, slug, kind, is_default) VALUES ($1, 'Development', 'development', 'development', true) RETURNING id",
      [workspaceId],
    )).rows[0].id;
    actionId = (await pool.query(
      "INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template) VALUES ($1, $2, $3, 'test', 'https://example.com') RETURNING id",
      [workspaceId, environmentId, `act_${randomUUID()}`],
    )).rows[0].id;
  });

  afterEach(async () => {
    if (testRedisKeys.length) {
      const { redis } = await import("../src/lib/redis.ts");
      await redis.del(...testRedisKeys.splice(0));
    }
    if (workspaceId) await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  });
  afterAll(async () => {
    const { resetPlanProvider } = await import("../src/core/plans/limits.ts");
    resetPlanProvider();
    await pool.end();
  });

  async function invocation(status = "running") {
    return (await pool.query(
      "INSERT INTO action_invocations (workspace_id, environment_id, action_id, invocation_id, status, input) VALUES ($1, $2, $3, $4, $5, '{}') RETURNING id",
      [workspaceId, environmentId, actionId, `inv_${randomUUID()}`, status],
    )).rows[0].id as string;
  }

  async function seedUsage(billed: number, reserved = 0, usageMonth = month) {
    await pool.query(
      "INSERT INTO workspace_usage_periods (workspace_id, month, action_billed, action_reserved) VALUES ($1, $2, $3, $4)",
      [workspaceId, usageMonth, billed, reserved],
    );
  }

  it("admits exactly one concurrent invocation into the last slot of the allowance and its buffer", async () => {
    await seedUsage(GRACE_CAP - 1);
    const ids = await Promise.all(Array.from({ length: 8 }, () => invocation()));
    const results = await Promise.allSettled(ids.map(id => accounting.reserveActionExecution(workspaceId, id)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(7);
    expect(await accounting.getActionUsage(workspaceId)).toEqual({ billed: GRACE_CAP - 1, reserved: 1 });
    const states = (await pool.query("SELECT status FROM action_invocations WHERE workspace_id = $1", [workspaceId])).rows;
    expect(states.filter(row => row.status === "failed")).toHaveLength(7);
  });

  it("claims a duplicate invocation once and bills a confirmed non-2xx exactly once", async () => {
    const id = await invocation();
    expect((await Promise.all(Array.from({ length: 8 }, () => accounting.reserveActionExecution(workspaceId, id))))
      .filter(Boolean)).toHaveLength(1);
    await Promise.all(Array.from({ length: 8 }, () => accounting.recordInvocationOutcome(workspaceId, id,
      { status: "failed", responseStatus: 503 }, "billed")));
    expect(await accounting.getActionUsage(workspaceId)).toEqual({ billed: 1, reserved: 0 });
  });

  it("releases a proven no-effect outcome and permits another last-slot admission", async () => {
    await seedUsage(GRACE_CAP - 1);
    const id = await invocation();
    await accounting.reserveActionExecution(workspaceId, id);
    await accounting.recordInvocationOutcome(workspaceId, id, { status: "failed" }, "released");
    expect(await accounting.reserveActionExecution(workspaceId, await invocation())).toBe(true);
    expect(await accounting.getActionUsage(workspaceId)).toEqual({ billed: GRACE_CAP - 1, reserved: 1 });
  });

  it("holds uncertain dispatch without billing or replenishing capacity", async () => {
    await seedUsage(GRACE_CAP - 1);
    const id = await invocation();
    await accounting.reserveActionExecution(workspaceId, id);
    await accounting.recordInvocationOutcome(workspaceId, id, { status: "unknown" }, "unknown");
    expect(await accounting.getActionUsage(workspaceId)).toEqual({ billed: GRACE_CAP - 1, reserved: 1 });
    await expect(accounting.reserveActionExecution(workspaceId, await invocation())).rejects.toThrow("Monthly action limit");
  });

  it("reserves before approval commit without claiming dispatch, then reuses the final slot", async () => {
    await seedUsage(GRACE_CAP - 1);
    const id = await invocation("pending_approval");
    await db.transaction(tx => accounting.reserveApprovalExecution(tx, workspaceId, id));
    expect((await pool.query("SELECT dispatch_claimed_at FROM action_invocations WHERE id = $1", [id])).rows[0].dispatch_claimed_at).toBeNull();
    expect(await accounting.reserveActionExecution(workspaceId, id)).toBe(true);
    expect(await accounting.getActionUsage(workspaceId)).toEqual({ billed: GRACE_CAP - 1, reserved: 1 });
  });

  it("rolls back the reservation when the enclosing approval transaction fails", async () => {
    const id = await invocation("pending_approval");
    await expect(db.transaction(async tx => {
      await accounting.reserveApprovalExecution(tx, workspaceId, id);
      throw new Error("approval failed");
    })).rejects.toThrow("approval failed");
    expect(await accounting.getActionUsage(workspaceId)).toEqual({ billed: 0, reserved: 0 });
  });

  it("rolls back the approving vote when the allowance and its buffer are full", async () => {
    await seedUsage(GRACE_CAP);
    const id = await invocation("pending_approval");
    const approvalId = `apr_${randomUUID()}`;
    await pool.query("INSERT INTO approvals (workspace_id, environment_id, approval_id, kind, title, expires_at) VALUES ($1, $2, $3, 'action', 'Approve', NOW() + INTERVAL '1 hour')",
      [workspaceId, environmentId, approvalId]);
    await pool.query("UPDATE action_invocations SET approval_id = $2 WHERE id = $1", [id, approvalId]);
    const approvals = await import("../src/core/approvals/service.ts");
    await expect(approvals.approveApproval(workspaceId, approvalId, { deciderKeyId: randomUUID() }))
      .rejects.toThrow("Monthly action limit");
    expect((await pool.query("SELECT status FROM approvals WHERE approval_id = $1", [approvalId])).rows[0].status).toBe("pending");
    expect((await pool.query("SELECT count(*) FROM approval_decisions WHERE approval_id = (SELECT id FROM approvals WHERE approval_id = $1)", [approvalId])).rows[0].count).toBe("0");
  });

  it("moves an undispatched prior-month approval reservation into the dispatch month", async () => {
    const previous = new Date();
    previous.setUTCDate(1);
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    const previousMonth = previous.toISOString().slice(0, 7);
    const id = await invocation("pending_approval");
    await seedUsage(0, 1, previousMonth);
    await pool.query("UPDATE action_invocations SET usage_state = 'reserved', usage_month = $2 WHERE id = $1", [id, previousMonth]);
    expect(await accounting.reserveActionExecution(workspaceId, id)).toBe(true);
    expect(await accounting.getActionUsage(workspaceId, previousMonth)).toEqual({ billed: 0, reserved: 0 });
    expect(await accounting.getActionUsage(workspaceId)).toEqual({ billed: 0, reserved: 1 });
  });

  it("refuses at a hard cap from the cap's own count, and never past it", async () => {
    await pool.query("UPDATE workspaces SET plan = 'free' WHERE id = $1", [workspaceId]);
    await seedUsage(FREE_ACTION_CAP - 1);
    expect(await accounting.reserveActionExecution(workspaceId, await invocation())).toBe(true);
    await expect(accounting.reserveActionExecution(workspaceId, await invocation())).rejects.toThrow("Monthly action execution limit");
    expect(await accounting.getActionUsage(workspaceId)).toEqual({ billed: FREE_ACTION_CAP - 1, reserved: 1 });
  });

  it("durably admits exactly one message at the plan's message limit and releases by identity", async () => {
    const messages = await import("../src/core/billing/message-accounting.ts");
    await seedUsage(0);
    await pool.query("UPDATE workspace_usage_periods SET messages_billed = $2 WHERE workspace_id = $1", [workspaceId, MESSAGE_CAP - 1]);
    const results = await Promise.all(Array.from({ length: 8 }, () => messages.reserveMessageQuota(workspaceId, 1, 100)));
    const accepted = results.filter(result => result.allowed);
    expect(accepted).toHaveLength(1);
    await messages.finishMessageQuota(workspaceId, accepted[0].reservationId!, "released");
    await messages.finishMessageQuota(workspaceId, accepted[0].reservationId!, "released");
    expect(await messages.getDurableMessageUsage(workspaceId)).toMatchObject({ messages: MESSAGE_CAP - 1, messagesReserved: 0, bandwidthReserved: 0 });
    expect((await messages.reserveMessageQuota(workspaceId, 1, 100)).allowed).toBe(true);
  });

  it("committed message usage survives cache loss, retained-row deletion, and duplicate settlement", async () => {
    const messages = await import("../src/core/billing/message-accounting.ts");
    const admitted = await messages.reserveMessageQuota(workspaceId, 1, 100);
    await messages.finishMessageQuota(workspaceId, admitted.reservationId!, "billed");
    await messages.finishMessageQuota(workspaceId, admitted.reservationId!, "billed");
    await messages.finishMessageQuota(workspaceId, admitted.reservationId!, "released");
    expect(await messages.getDurableMessageUsage(workspaceId)).toEqual({ messages: 1, bandwidth: 100,
      messagesReserved: 0, bandwidthReserved: 0 });
  });

  async function outboxMessage(status = "pending") {
    const messageId = `msg_test_${randomUUID()}`;
    const stream = `core-accounting-test:${randomUUID()}:stream`;
    const index = `core-accounting-test:${randomUUID()}:index`;
    const marker = `message-enqueued:${messageId}`;
    testRedisKeys.push(stream, index, marker);
    await pool.query("INSERT INTO messages (message_id, workspace_id, environment_id, url, status) VALUES ($1, $2, $3, 'https://example.com', $4)",
      [messageId, workspaceId, environmentId, status]);
    const commands = [["xadd", stream, "*", "messageId", messageId], ["sadd", index, messageId]];
    await pool.query("INSERT INTO message_enqueue_outbox (message_id, commands) VALUES ($1, $2)", [messageId, JSON.stringify(commands)]);
    return { messageId, stream, index, marker, commands };
  }

  it("dispatches a durable outbox exactly once across concurrent retries", async () => {
    const { dispatchMessageOutbox } = await import("../src/core/messaging/enqueue-outbox.ts");
    const { redis } = await import("../src/lib/redis.ts");
    const entry = await outboxMessage();
    await Promise.all(Array.from({ length: 5 }, () => dispatchMessageOutbox(entry.messageId)));
    expect(await redis.xlen(entry.stream)).toBe(1);
    expect((await pool.query("SELECT * FROM message_enqueue_outbox WHERE message_id = $1", [entry.messageId])).rows).toHaveLength(0);
  });

  it("replays an enqueue whose Redis response was lost without duplicating the stream", async () => {
    const { dispatchMessageOutbox, ENQUEUE_ONCE } = await import("../src/core/messaging/enqueue-outbox.ts");
    const { redis } = await import("../src/lib/redis.ts");
    const entry = await outboxMessage();
    await redis.eval(ENQUEUE_ONCE, 1, entry.marker, JSON.stringify(entry.commands));
    expect(await redis.ttl(entry.marker)).toBe(-1);
    await dispatchMessageOutbox(entry.messageId);
    expect(await redis.xlen(entry.stream)).toBe(1);
    expect(await redis.ttl(entry.marker)).toBeGreaterThan(0);
  });

  it("keeps failed enqueue durable and preflights all key types before stream writes", async () => {
    const { dispatchMessageOutbox } = await import("../src/core/messaging/enqueue-outbox.ts");
    const { redis } = await import("../src/lib/redis.ts");
    const entry = await outboxMessage();
    await redis.set(entry.index, "wrong-type");
    await expect(dispatchMessageOutbox(entry.messageId)).rejects.toThrow("Outbox key type mismatch");
    expect(await redis.xlen(entry.stream)).toBe(0);
    expect((await pool.query("SELECT * FROM message_enqueue_outbox WHERE message_id = $1", [entry.messageId])).rows).toHaveLength(1);
    await redis.del(entry.index);
    await dispatchMessageOutbox(entry.messageId);
    expect(await redis.xlen(entry.stream)).toBe(1);
  });

  it("does not dispatch accepted messages cancelled before enqueue recovery", async () => {
    const { dispatchMessageOutbox } = await import("../src/core/messaging/enqueue-outbox.ts");
    const { redis } = await import("../src/lib/redis.ts");
    const entry = await outboxMessage("cancelled");
    await dispatchMessageOutbox(entry.messageId);
    expect(await redis.xlen(entry.stream)).toBe(0);
    expect((await pool.query("SELECT * FROM message_enqueue_outbox WHERE message_id = $1", [entry.messageId])).rows).toHaveLength(0);
  });

  it("admits one concurrent action definition at the plan's definition cap and archives release capacity", async () => {
    const { createAction, UNSCOPED_AUTHORITY } = await import("../src/core/actions/service.ts");
    await pool.query("UPDATE workspaces SET plan = 'free' WHERE id = $1", [workspaceId]);
    for (let i = 0; i < 3; i++) await pool.query(
      "INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template) VALUES ($1, $2, $3, $4, 'https://example.com')",
      [workspaceId, environmentId, `act_${randomUUID()}`, `seed-${i}`]);
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => createAction(workspaceId,
      { name: `concurrent-${i}`, urlTemplate: "https://example.com" }, UNSCOPED_AUTHORITY, environmentId)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(4);
    await pool.query("UPDATE actions SET archived_at = NOW() WHERE id = $1", [actionId]);
    const created = await createAction(workspaceId, { name: "after-archive", urlTemplate: "https://example.com" }, UNSCOPED_AUTHORITY, environmentId);
    expect(created.currentVersionId).toMatch(/^acv_/);
  });

  it("fences resources during a pending downgrade without reducing paid usage early", async () => {
    const { prepareDowngrade, setWorkspacePlan } = await import("../src/core/billing/plan-management.ts");
    const { createEnvironment, updateEnvironment } = await import("../src/core/environments/service.ts");
    const { createAction, UNSCOPED_AUTHORITY } = await import("../src/core/actions/service.ts");
    await pool.query("UPDATE workspaces SET plan = 'growth' WHERE id = $1", [workspaceId]);
    for (let i = 0; i < 4; i++) await pool.query(
      "INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template) VALUES ($1, $2, $3, $4, 'https://example.com')",
      [workspaceId, environmentId, `act_${randomUUID()}`, `seed-${i}`]);
    await prepareDowngrade(workspaceId, "free");
    expect((await pool.query("SELECT plan, pending_plan FROM workspaces WHERE id = $1", [workspaceId])).rows[0]).toEqual({ plan: "growth", pending_plan: "free" });
    await expect(createEnvironment(workspaceId, { name: "Production", slug: "production", kind: "production" })).rejects.toThrow("1 environment");
    await expect(updateEnvironment(workspaceId, environmentId, { isProtected: true })).rejects.toMatchObject({ statusCode: 403, code: "FEATURE_NOT_AVAILABLE" });
    await expect(createAction(workspaceId, { name: "over-cap", urlTemplate: "https://example.com" }, UNSCOPED_AUTHORITY, environmentId)).rejects.toThrow("5 actions");
    await seedUsage(FREE_ACTION_CAP * 50);
    expect(await accounting.reserveActionExecution(workspaceId, await invocation())).toBe(true);
    await setWorkspacePlan(workspaceId, "growth", { pendingPlan: null });
    await expect(createEnvironment(workspaceId, { name: "Production", slug: "production", kind: "production" })).resolves.toMatchObject({ kind: "production" });
  });

  it("lets a paid workspace safely reduce environments before downgrading", async () => {
    const { updateEnvironment, createEnvironment, deleteEmptyEnvironment } = await import("../src/core/environments/service.ts");
    const { prepareDowngrade } = await import("../src/core/billing/plan-management.ts");
    await pool.query("UPDATE workspaces SET plan = 'growth' WHERE id = $1", [workspaceId]);
    const staging = await createEnvironment(workspaceId, { name: "Staging", slug: "staging", kind: "staging" });
    const preview = await createEnvironment(workspaceId, { name: "Preview", slug: "preview", kind: "development" });
    await expect(prepareDowngrade(workspaceId, "production")).rejects.toThrow("reduce environments to 2");
    await pool.query("DELETE FROM environments WHERE id = $1", [preview.id]);
    await expect(deleteEmptyEnvironment(workspaceId, staging.id, "wrong")).rejects.toThrow("slug");
    await expect(deleteEmptyEnvironment(workspaceId, staging.id, "staging")).rejects.toThrow("Halt");
    await pool.query("UPDATE environments SET halted_at = NOW() WHERE id = $1", [staging.id]);
    await updateEnvironment(workspaceId, staging.id, { isDefault: true });
    await expect(deleteEmptyEnvironment(workspaceId, staging.id, "staging")).rejects.toThrow("default");
    await updateEnvironment(workspaceId, environmentId, { isDefault: true });
    await deleteEmptyEnvironment(workspaceId, staging.id, "staging");
    expect((await pool.query("SELECT id FROM environments WHERE id = $1", [staging.id])).rows).toHaveLength(0);
    await updateEnvironment(workspaceId, environmentId, { kind: "production", isProtected: true });
    await expect(updateEnvironment(workspaceId, environmentId, { kind: "development" })).rejects.toThrow("confirmProtected");
    await updateEnvironment(workspaceId, environmentId, { kind: "development", isProtected: false, confirmProtected: true });
    await prepareDowngrade(workspaceId, "free");
  });

  it("never cascades resources when an environment is deleted", async () => {
    const { deleteEmptyEnvironment } = await import("../src/core/environments/service.ts");
    await pool.query("UPDATE environments SET is_default = false, halted_at = NOW() WHERE id = $1", [environmentId]);
    await expect(deleteEmptyEnvironment(workspaceId, environmentId, "development")).rejects.toThrow("not empty");
    expect((await pool.query("SELECT id FROM actions WHERE id = $1", [actionId])).rows).toHaveLength(1);
  });

  it("counts durable trace archives as the workspace's storage", async () => {
    const { getWorkspaceStorageUsage } = await import("../src/core/billing/storage-accounting.ts");
    await pool.query("INSERT INTO trace_archives (workspace_id, r2_key, size_bytes) VALUES ($1, $2, 50)", [workspaceId, `traces/test/${randomUUID()}`]);
    await pool.query("INSERT INTO trace_archives (workspace_id, r2_key, size_bytes) VALUES ($1, $2, 25)", [workspaceId, `traces/test/${randomUUID()}`]);
    expect(await getWorkspaceStorageUsage(workspaceId)).toEqual({ archiveBytes: 75, usedBytes: 75 });
  });
});
