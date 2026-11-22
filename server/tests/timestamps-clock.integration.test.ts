import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: () => Promise.resolve(new Response("{}", { status: 200 })) };
});

const ready = process.env.ANLYON_TEST_TARGETS === "ok";

describe.runIf(ready)("database clock authority (real Postgres)", () => {
  let pool: Pool;
  let workspaceId: string;
  let environmentId: string;
  let svc: typeof import("../src/core/approvals/service.ts");
  let actions: typeof import("../src/core/actions/service.ts");

  const gated = async (prefix: string) => {
    const name = `${prefix}_${randomUUID().slice(0, 8)}`;
    await actions.createAction(
      workspaceId,
      { name, urlTemplate: "https://shop.test/x", method: "POST", requiresApproval: true },
      actions.UNSCOPED_AUTHORITY,
      environmentId,
    );
    return name;
  };
  const park = async (name: string) =>
    actions.invokeAction(workspaceId, name, {}, { environmentId, requestedByKeyId: randomUUID() });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    svc = await import("../src/core/approvals/service.ts");
    actions = await import("../src/core/actions/service.ts");
    const envSvc = await import("../src/core/environments/service.ts");
    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('Clock', $1, 'enterprise') RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    environmentId = (await envSvc.ensureDefaultEnvironment(workspaceId)).id;
  }, 60_000);

  afterAll(async () => {
    if (workspaceId) await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool?.end().catch(() => {});
  });

  it.each(["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"])(
    "the UTC stamp expression is unaffected by a %s session",
    async (zone) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL TIME ZONE '${zone}'`);
        const { rows } = await client.query(
          `SELECT abs(extract(epoch FROM ((clock_timestamp() at time zone 'utc') - (now() at time zone 'utc')))) AS ours,
                  abs(extract(epoch FROM (clock_timestamp()::timestamp - (now() at time zone 'utc')))) AS bare_cast`,
        );
        await client.query("ROLLBACK");
        expect(Number(rows[0].ours)).toBeLessThan(5);
        if (zone !== "UTC") expect(Number(rows[0].bare_cast)).toBeGreaterThan(3600);
      } finally {
        client.release();
      }
    },
  );

  it("a vote delayed behind a row lock is stamped after the lock is released, not at transaction start", async () => {
    const parked = await park(await gated("lock"));
    const approvalUuid = (await pool.query(`SELECT id FROM approvals WHERE approval_id = $1`, [parked.approvalId])).rows[0].id;

    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM approvals WHERE id = $1 FOR UPDATE`, [approvalUuid]);

    const vote = svc.approveApproval(workspaceId, parked.approvalId!, { deciderKeyId: randomUUID() }, environmentId);
    await new Promise((r) => setTimeout(r, 1500));

    const released = (await holder.query(`SELECT clock_timestamp() at time zone 'utc' AS t`)).rows[0].t as Date;
    await holder.query("COMMIT");
    holder.release();
    await vote;

    const stamp = (await pool.query(`SELECT decided_at FROM approval_decisions WHERE approval_id = $1`, [approvalUuid])).rows[0]
      .decided_at as Date;
    const approved = (await pool.query(`SELECT created_at, decided_at FROM approvals WHERE id = $1`, [approvalUuid])).rows[0];
    expect(stamp.getTime()).toBeGreaterThanOrEqual(released.getTime());
    expect(approved.decided_at.getTime()).toBeGreaterThanOrEqual(stamp.getTime());
    expect(approved.created_at.getTime()).toBeLessThanOrEqual(stamp.getTime());
  }, 60_000);

  it("human denial and expiry settle the invocation atomically with the approval", async () => {
    const name = await gated("atomic");

    const denied = await park(name);
    await svc.denyApproval(workspaceId, denied.approvalId!, { deciderKeyId: randomUUID() }, environmentId);
    const d = (
      await pool.query(
        `SELECT i.status, i.completed_at, i.decision, a.status AS astatus, a.decision_origin
           FROM action_invocations i JOIN approvals a ON a.approval_id = i.approval_id WHERE i.invocation_id = $1`,
        [denied.id],
      )
    ).rows[0];
    expect(d).toMatchObject({ status: "denied", astatus: "denied", decision_origin: "human" });
    expect(d.decision).toMatchObject({ code: "HUMAN_DENIED", source: "human" });
    expect(d.completed_at).not.toBeNull();

    const expiring = await park(name);
    await pool.query(`UPDATE approvals SET expires_at = now() - interval '1 minute' WHERE approval_id = $1`, [expiring.approvalId]);
    expect(await svc.sweepExpiredApprovals(200, { workspaceId })).toBeGreaterThanOrEqual(1);
    const e = (
      await pool.query(
        `SELECT i.status, i.completed_at, i.decision, a.status AS astatus, a.decision_origin
           FROM action_invocations i JOIN approvals a ON a.approval_id = i.approval_id WHERE i.invocation_id = $1`,
        [expiring.id],
      )
    ).rows[0];
    expect(e).toMatchObject({ status: "expired", astatus: "expired", decision_origin: "system" });
    expect(e.decision).toMatchObject({ code: "APPROVAL_EXPIRED", source: "system" });
  }, 60_000);

  it("a dispatched invocation is not released by a later denial", async () => {
    const parked = await park(await gated("claimed"));
    await pool.query(`UPDATE action_invocations SET dispatch_claimed_at = now() WHERE invocation_id = $1`, [parked.id]);
    await svc.denyApproval(workspaceId, parked.approvalId!, { deciderKeyId: randomUUID() }, environmentId);
    const row = (await pool.query(`SELECT status FROM action_invocations WHERE invocation_id = $1`, [parked.id])).rows[0];
    expect(row.status).toBe("pending_approval");
  }, 60_000);
});
