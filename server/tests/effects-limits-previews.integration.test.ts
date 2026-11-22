import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { providerFetch } from "./support/effects/provider-fetch.ts";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});

const { EffectScope, loadEffectModules, REPO, BRANCH } = await import("./support/effects/fixture.ts");

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("governed effects: impact limits and bound previews (real Postgres)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let m: Awaited<ReturnType<typeof loadEffectModules>>;
  let s: InstanceType<typeof EffectScope>;

  beforeAll(async () => {
    await pool.query("SELECT 1");
    const { usePlanFixture } = await import("./support/plan-fixture.ts");
    usePlanFixture({ free: { usagePolicy: { actionInvokes: { kind: "hard-cap", capUnits: 100_000 } } } });
    m = await loadEffectModules();
  });
  beforeEach(async () => { s = await new EffectScope(pool, m).seed(); });
  afterEach(async () => { await s.cleanup(); });
  afterAll(async () => { await pool.end(); });

  const approve = (approvalId: string) =>
    m.approvals.approveApproval(s.workspaceId, approvalId, { deciderKeyId: randomUUID() }, s.environmentId);

  describe("shared impact limits", () => {
    it("two concurrent $80 refunds with $100 remaining: at most one dispatches", async () => {
      await s.refundAction();
      const limit = await s.limit({ name: "daily refunds", dimension: "money", currency: "usd", period: "day", amount: 10_000 });
      const results = await Promise.all([
        s.invoke("refund", s.refund(8000, "pi_order1")),
        s.invoke("refund", s.refund(8000, "pi_order2")),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["failed", "succeeded"]);
      expect(s.stripe.refunds).toHaveLength(1);
      const refused = results.find((r) => r.status === "failed")!;
      expect(refused.error).toMatch(/impact_limit_exceeded/);
      const effect = await s.effect(refused.effectId!);
      expect(effect).toMatchObject({ stage: "rejected", outcome: "not_dispatched", verification: "not_dispatched", rejectionReason: "impact_limit_exceeded" });
      expect(effect.attempts).toHaveLength(0);
      expect(await s.limitView(limit.id)).toMatchObject({ limit: 10_000, consumed: 8000, reserved: 0, available: 2000 });
    });

    it("concurrent file updates cannot exceed the shared mutation allowance", async () => {
      await s.fileAction();
      const limit = await s.limit({ name: "file changes", dimension: "resource_mutations", period: "day", amount: 3, resourcePrefix: `github:${REPO}@` });
      const results = await Promise.all(["a", "b", "c", "d", "e"].map((f) => s.invoke("update-file", s.file(`${f}.txt`, `${f} changed\n`))));
      expect(results.filter((r) => r.status === "succeeded")).toHaveLength(3);
      expect(results.filter((r) => r.status === "failed")).toHaveLength(2);
      expect(s.github.writes).toBe(3);
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 3, reserved: 0, available: 0 });
    });

    it("50 parallel sends against a cap of 20 emails a day: exactly 20 leave, 30 are refused for the limit, and none errors", async () => {
      await s.declaredAction("send-email");
      const limit = await s.limit({ name: "emails a day", dimension: "emails", period: "day", amount: 20 });
      const settled = await Promise.allSettled(
        Array.from({ length: 50 }, (_, i) => s.invoke("send-email", s.email(`burst-${i}`, [`user${i}@example.com`]))),
      );
      const errored = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(errored.map((r) => String((r.reason as Error)?.message).slice(0, 200))).toEqual([]);
      const results = settled.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof s.invoke>>>).value);
      const refused = results.filter((r) => r.status !== "succeeded");
      expect(results.filter((r) => r.status === "succeeded")).toHaveLength(20);
      expect(refused).toHaveLength(30);
      for (const result of refused) expect(result.error).toMatch(/impact_limit_exceeded/);
      expect(s.http.writes).toBe(20);
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 20, reserved: 0, available: 0 });
      expect((await s.invoke("send-email", s.email("one-too-many", ["x@example.com"]))).status).toBe("failed");
      expect(s.http.writes).toBe(20);
    });

    it("repeated legitimate changes to the same resource count separately; one effect's attempts count once", async () => {
      await s.fileAction();
      const limit = await s.limit({ name: "file changes", dimension: "resource_mutations", period: "day", amount: 10 });
      await s.invoke("update-file", s.file("a.txt", "one\n"));
      await s.invoke("update-file", s.file("a.txt", "two\n"));
      expect((await s.limitView(limit.id)).consumed).toBe(2);
      s.github.fault("write", "lose_response_after_commit");
      const lost = await s.invoke("update-file", s.file("a.txt", "three\n"));
      await s.reconcileNow(lost.effectId!);
      await s.reconcileNow(lost.effectId!);
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 3, reserved: 0 });
    });

    it("failure to reserve one dimension rolls back every reservation", async () => {
      await s.refundAction();
      const money = await s.limit({ name: "money", dimension: "money", currency: "usd", period: "month", amount: 1_000_000 });
      const count = await s.limit({ name: "no refunds", dimension: "resource_mutations", period: "month", amount: 0, actionName: "refund" });
      const result = await s.invoke("refund", s.refund(500));
      expect(result.status).toBe("failed");
      expect(s.stripe.writes).toBe(0);
      expect(await s.limitView(money.id)).toMatchObject({ reserved: 0, consumed: 0 });
      expect(await s.limitView(count.id)).toMatchObject({ reserved: 0, consumed: 0 });
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM impact_reservations WHERE workspace_id = $1", [s.workspaceId]);
      expect(rows[0].n).toBe(0);
    });

    it("an operation with unbounded impact cannot execute under a hard cap", async () => {
      await s.refundAction();
      await s.limit({ name: "money", dimension: "money", currency: "usd", period: "month", amount: 1_000_000 });
      const reject = m.impact.quantityFor({ dimension: "money", currency: "usd" }, { impact: [], dimensions: ["money"] });
      expect(reject).toBeNull();
      expect(m.impact.quantityFor({ dimension: "money", currency: "eur" }, {
        impact: [{ dimension: "money", currency: "usd", amount: 5, bound: "exact" }], dimensions: ["money"],
      })).toBeUndefined();
    });

    it("unknown effects retain capacity across restarts and period changes, and settle into their original period", async () => {
      await s.refundAction();
      const limit = await s.limit({ name: "daily", dimension: "money", currency: "usd", period: "day", amount: 10_000 });
      s.stripe.fault("write", "lose_response_after_commit");
      const unknown = await s.invoke("refund", s.refund(8000));
      expect(unknown.status).toBe("unknown");
      const yesterday = `day:${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}`;
      const row = await s.row(unknown.effectId!);
      const today = (await pool.query("SELECT period_key FROM impact_reservations WHERE effect_id = $1", [row.id])).rows[0].period_key;
      await pool.query("UPDATE impact_limit_periods SET period_key = $2 WHERE period_key = $3 AND limit_id = (SELECT id FROM impact_limits WHERE limit_id = $1)", [limit.id, yesterday, today]);
      await pool.query("UPDATE impact_reservations SET period_key = $2 WHERE effect_id = $1", [row.id, yesterday]);

      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 8000, unknownExposure: 8000, available: 2000 });
      const blocked = await s.invoke("refund", s.refund(3000, "pi_order2"));
      expect(blocked.error).toMatch(/impact_limit_exceeded/);

      await s.reconcileNow(unknown.effectId!);
      const periods = (await pool.query(
        "SELECT period_key, consumed::int, reserved::int FROM impact_limit_periods WHERE limit_id = (SELECT id FROM impact_limits WHERE limit_id = $1) ORDER BY period_key",
        [limit.id],
      )).rows;
      expect(periods.find((p) => p.period_key === yesterday)).toMatchObject({ consumed: 8000, reserved: 0 });
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 0, available: 10_000 });
    });

    it("duplicate settlement cannot double-count", async () => {
      await s.refundAction();
      const limit = await s.limit({ name: "m", dimension: "money", currency: "usd", period: "month", amount: 100_000 });
      s.stripe.fault("write", "lose_response_after_commit");
      const result = await s.invoke("refund", s.refund(2500));
      const row = await s.row(result.effectId!);
      const { db } = await import("../src/db/index.ts");
      await Promise.all(Array.from({ length: 5 }, () =>
        db.transaction((tx) => m.impact.applyOutcomeToImpactIn(tx, row.id, "succeeded", "none"))));
      await s.reconcileNow(result.effectId!);
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 2500, reserved: 0 });
    });

    it("new sessions or credentials cannot replenish a shared allowance", async () => {
      await s.refundAction();
      const limit = await s.limit({ name: "shared", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
      const first = await s.apiKey("agent-1");
      const second = await s.apiKey("agent-2");
      const a = await s.invoke("refund", s.refund(7000), { requestedByKeyId: first.id });
      const b = await s.invoke("refund", s.refund(7000, "pi_order2"), { requestedByKeyId: second.id });
      const c = await s.invoke("refund", s.refund(7000, "pi_order3"));
      expect([a.status, b.status, c.status]).toEqual(["succeeded", "failed", "failed"]);
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 7000, available: 3000 });
    });

    it("lowering a limit preserves existing exposure and blocks additional work", async () => {
      await s.refundAction();
      const limit = await s.limit({ name: "m", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
      s.stripe.fault("write", "timeout_before_commit");
      const unknown = await s.invoke("refund", s.refund(8000));
      const lowered = await m.impact.updateLimit(s.workspaceId, s.environmentId, limit.id, { amount: 5000 });
      expect(lowered).toMatchObject({ limit: 5000, reserved: 8000, unknownExposure: 8000, available: 0 });
      expect((await s.invoke("refund", s.refund(10, "pi_order2"))).error).toMatch(/impact_limit_exceeded/);
      await m.effects.resolveEffectManually(s.workspaceId, s.environmentId, unknown.effectId!,
        { outcome: "failed", reason: "Confirmed in Stripe: no refund was created." }, { type: "user", id: s.userId });
      expect(await s.limitView(limit.id)).toMatchObject({ reserved: 0, available: 5000 });
    });

    it("archiving a limit keeps its reservations settling", async () => {
      await s.refundAction();
      const limit = await s.limit({ name: "m", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
      s.stripe.fault("write", "lose_response_after_commit");
      const unknown = await s.invoke("refund", s.refund(4000));
      await m.impact.archiveLimit(s.workspaceId, s.environmentId, limit.id);
      await s.reconcileNow(unknown.effectId!);
      expect(await s.limitView(limit.id)).toMatchObject({ archived: true, consumed: 4000, reserved: 0 });
    });
  });

  describe("execution-bound previews", () => {
    it("an invoke without previewId keeps the full approval window: the implicit preview does not shorten it", async () => {
      await s.refundAction("refund", { requiresApproval: true });
      const parked = await s.invoke("refund", s.refund(5000));
      expect(parked.pendingApproval).toBe(true);
      const [{ approval_ms, preview_ms, now_ms }] = (await pool.query(
        `SELECT extract(epoch FROM a.expires_at) * 1000 AS approval_ms, extract(epoch FROM p.expires_at) * 1000 AS preview_ms,
                extract(epoch FROM now()) * 1000 AS now_ms
           FROM approvals a JOIN action_effects e ON e.approval_id = a.approval_id JOIN effect_previews p ON p.id = e.preview_id
          WHERE e.effect_id = $1`, [parked.effectId],
      )).rows;
      const window = Number(approval_ms) - Number(now_ms);
      expect(window).toBeGreaterThan(24 * 3600_000 - 60_000);
      expect(Number(approval_ms)).toBeLessThanOrEqual(Number(preview_ms));
      const decided = await approve(parked.approvalId!);
      expect(decided.invocation?.status).toBe("succeeded");
    });

    it("a preview carries environment, target, exact change, allowances, preconditions, expiry and labelled guarantees", async () => {
      await s.refundAction();
      await s.fileAction();
      await s.limit({ name: "m", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
      const refund = await m.effects.createPreviewForAction(s.workspaceId, s.environmentId, "refund", s.refund(1234));
      const head = refund.blocks[0] as { type: string; fields: Array<{ label: string; value: string }> };
      expect(head.fields.find((f) => f.label === "Environment")!.value).toMatch(/\(production\)$/);
      expect(head.fields.find((f) => f.label === "Target account")!.value).toBe(s.stripe.accountId);
      expect(refund.allowances[0]).toMatchObject({ requested: 1234, available: 10_000, sufficient: true });
      expect(refund.preconditions).toMatchObject({ account: s.stripe.accountId, currency: "usd" });
      expect(refund.expired).toBe(false);
      const limitations = refund.blocks.find((b) => b.type === "limitations") as { items: Array<{ kind: string; text: string }> };
      expect(limitations.items.some((i) => i.kind === "freshness" && /No atomic stale-state protection/.test(i.text))).toBe(true);
      expect(limitations.items.some((i) => i.kind === "irreversible")).toBe(true);

      const file = await m.effects.createPreviewForAction(s.workspaceId, s.environmentId, "update-file", s.file("a.txt", "new\n"));
      const diff = file.blocks.find((b) => b.type === "text_diff") as { before: string; after: string };
      expect(diff).toMatchObject({ before: "a.txt v1\n", after: "new\n" });
      const fileLimits = file.blocks.find((b) => b.type === "limitations") as { items: Array<{ kind: string; text: string }> };
      expect(fileLimits.items.some((i) => i.kind === "guarantee" && /Stale-state protection/.test(i.text))).toBe(true);
      expect(JSON.stringify([refund, file])).not.toContain("sk_test_");
    });

    it("a changed amount, resource, content or action version invalidates the reviewed preview", async () => {
      await s.refundAction();
      await s.fileAction();
      const refund = await m.effects.createPreviewForAction(s.workspaceId, s.environmentId, "refund", s.refund(5000));
      await expect(s.invoke("refund", s.refund(6000), { effect: { previewId: refund.id } })).rejects.toMatchObject({ code: "PREVIEW_MISMATCH" });
      await expect(s.invoke("refund", s.refund(5000, "pi_order2"), { effect: { previewId: refund.id } })).rejects.toMatchObject({ code: "PREVIEW_MISMATCH" });
      const file = await m.effects.createPreviewForAction(s.workspaceId, s.environmentId, "update-file", s.file("a.txt", "x\n"));
      await expect(s.invoke("update-file", s.file("a.txt", "y\n"), { effect: { previewId: file.id } })).rejects.toMatchObject({ code: "PREVIEW_MISMATCH" });

      await m.actions.updateAction(s.workspaceId, "refund", {
        adapter: { type: "stripe.refund", config: { account: "acct_otherAccount1", mode: "test", currency: "usd" }, credentialSecret: "STRIPE_TEST_KEY" },
      }, m.actions.UNSCOPED_AUTHORITY, s.environmentId);
      await expect(s.invoke("refund", s.refund(5000), { effect: { previewId: refund.id } }))
        .rejects.toMatchObject({ code: "PREVIEW_MISMATCH", details: { field: "actionVersion" } });
      expect(s.stripe.writes).toBe(0);
    });

    it("an action edited after approval was requested cannot run under that approval", async () => {
      await s.refundAction("refund", { requiresApproval: true });
      const parked = await s.invoke("refund", s.refund(5000));
      expect(parked.pendingApproval).toBe(true);
      await m.actions.updateAction(s.workspaceId, "refund", {
        adapter: { type: "stripe.refund", config: { account: s.stripe.accountId, mode: "test", currency: "eur" }, credentialSecret: "STRIPE_TEST_KEY" },
      }, m.actions.UNSCOPED_AUTHORITY, s.environmentId);
      const decided = await approve(parked.approvalId!);
      expect(decided.invocation?.status).toBe("failed");
      const effect = await s.effect(parked.effectId!);
      expect(effect.rejectionReason).toBe("action_changed");
      expect(s.stripe.writes).toBe(0);
    });

    it("an expired preview cannot execute", async () => {
      await s.refundAction("refund", { requiresApproval: true });
      const parked = await s.invoke("refund", s.refund(5000));
      await pool.query("UPDATE approvals SET status = 'approved', decided_at = now() - interval '5 minutes' WHERE approval_id = $1", [parked.approvalId]);
      await pool.query(
        "UPDATE effect_previews SET expires_at = now() - interval '1 minute' WHERE id = (SELECT preview_id FROM action_effects WHERE effect_id = $1)",
        [parked.effectId],
      );
      await m.approvals.resumeApprovedInvocations(50, 0, { workspaceId: s.workspaceId });
      const effect = await s.effect(parked.effectId!);
      expect(effect.stage).toBe("rejected");
      expect(["binding_mismatch", "preview_expired"]).toContain(effect.rejectionReason);
      expect(s.stripe.writes).toBe(0);
    });

    it("a genuinely expired preview is refused at admission", async () => {
      await s.refundAction();
      const preview = await m.effects.createPreviewForAction(s.workspaceId, s.environmentId, "refund", s.refund(5000), { ttlSeconds: 60 });
      const row = (await pool.query("SELECT * FROM effect_previews WHERE preview_id = $1", [preview.id])).rows[0];
      const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
      const digest = m.binding.bindingDigest({
        workspaceId: row.workspace_id, environmentId: row.environment_id, requestDigest: row.request_digest, target: row.target,
        actionVersionId: row.action_version_id, adapterType: row.adapter_type, adapterVersion: row.adapter_version,
        preconditions: row.preconditions, expiresAt,
      });
      await pool.query("UPDATE effect_previews SET expires_at = $2, binding_digest = $3 WHERE id = $1", [row.id, expiresAt, digest]);
      await expect(s.invoke("refund", s.refund(5000), { effect: { previewId: preview.id } })).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
      expect(s.stripe.writes).toBe(0);
    });

    it("duplicate approval callbacks do not duplicate the effect", async () => {
      await s.refundAction("refund", { requiresApproval: true });
      const parked = await s.invoke("refund", s.refund(5000));
      const [{ row: invocation }] = (await pool.query("SELECT row_to_json(i) AS row FROM action_invocations i WHERE invocation_id = $1", [parked.id])).rows;
      const action = (await m.actions.resolveActionRow(s.workspaceId, "refund", s.environmentId));
      const stale = { ...invocation, id: invocation.id, workspaceId: s.workspaceId, status: "pending_approval", effectId: parked.effectId } as never;
      await m.execute.executeInvocation(action, stale);
      expect(s.stripe.refunds).toHaveLength(0);
      expect((await s.effect(parked.effectId!)).stage).toBe("awaiting_approval");
      expect((await m.actions.getInvocation(s.workspaceId, parked.id, s.environmentId)).status).toBe("pending_approval");
      await Promise.allSettled([
        approve(parked.approvalId!),
        approve(parked.approvalId!),
        m.approvals.resumeApprovedInvocations(50, 0, { workspaceId: s.workspaceId }),
        m.execute.executeInvocation(action, stale),
        m.execute.executeInvocation(action, stale),
      ]);
      await Promise.allSettled([m.reconcile.reconcileDueEffects(), m.reconcile.reconcileDueEffects()]);
      await m.approvals.resumeApprovedInvocations(50, 0, { workspaceId: s.workspaceId });
      expect(s.stripe.refunds).toHaveLength(1);
      const effect = await s.effect(parked.effectId!);
      expect(effect.outcome).toBe("succeeded");
      expect(effect.attempts.filter((a) => a.kind === "dispatch")).toHaveLength(1);
      const [row] = (await pool.query("SELECT approval_consumed_at FROM action_effects WHERE effect_id = $1", [parked.effectId])).rows;
      expect(row.approval_consumed_at).not.toBeNull();
    });

    it("an approval bound to another digest is refused at dispatch", async () => {
      await s.refundAction("refund", { requiresApproval: true });
      const parked = await s.invoke("refund", s.refund(5000));
      expect(parked.pendingApproval).toBe(true);
      await pool.query("UPDATE approvals SET binding_digest = $2 WHERE approval_id = $1", [parked.approvalId, "0".repeat(64)]);
      const decided = await approve(parked.approvalId!);
      expect(decided.invocation?.status).toBe("failed");
      const effect = await s.effect(parked.effectId!);
      expect(effect).toMatchObject({ stage: "rejected", outcome: "not_dispatched", rejectionReason: "binding_mismatch", grade: "refused" });
      expect(effect.evidence.some((e) => /approval was given for a different operation/.test(e.summary))).toBe(true);
      expect(effect.attempts).toHaveLength(0);
      expect(s.stripe.writes).toBe(0);
    });

    it("a GitHub file changed between review and execution is refused by the provider as stale", async () => {
      await s.fileAction("update-file", { requiresApproval: true });
      const parked = await s.invoke("update-file", s.file("status.txt", "reviewed change\n"));
      s.github.externalWrite(REPO, BRANCH, "fixtures/status.txt", "someone else's change\n");
      const decided = await approve(parked.approvalId!);
      expect(decided.invocation?.status).toBe("failed");
      const effect = await s.effect(parked.effectId!);
      expect(effect).toMatchObject({ outcome: "failed", partialEffect: "none", verification: "provider" });
      expect(effect.evidence.some((e) => (e.details as { staleVersion?: boolean }).staleVersion === true)).toBe(true);
      expect(s.github.file(REPO, BRANCH, "fixtures/status.txt")!.content).toBe("someone else's change\n");
    });

    it("budget exhaustion after review blocks dispatch", async () => {
      await s.refundAction("refund", { requiresApproval: true });
      await s.refundAction("small-refund");
      const limit = await s.limit({ name: "m", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
      const parked = await s.invoke("refund", s.refund(8000));
      const preview = await m.effects.getPreview(s.workspaceId, s.environmentId, (await s.effect(parked.effectId!)).previewId!);
      expect(preview.allowances[0]).toMatchObject({ available: 10_000, sufficient: true });
      await s.invoke("small-refund", s.refund(5000, "pi_order2"));
      const decided = await approve(parked.approvalId!);
      expect(decided.invocation?.status).toBe("failed");
      expect((await s.effect(parked.effectId!)).rejectionReason).toBe("impact_limit_exceeded");
      expect(s.stripe.refunds).toHaveLength(1);
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 5000, reserved: 0 });
    });

    it("a policy that now denies, a halt, or revoked authority blocks an approved dispatch", async () => {
      await s.refundAction("refund", { requiresApproval: true });
      const key = await s.apiKey("agent");
      const first = await s.invoke("refund", s.refund(100), { requestedByKeyId: key.id });
      await pool.query("UPDATE api_keys SET is_active = 'false' WHERE id = $1", [key.id]);
      await approve(first.approvalId!);
      expect((await s.effect(first.effectId!)).rejectionReason).toBe("authority_revoked");

      const second = await s.invoke("refund", s.refund(100));
      await m.halt.haltEnvironment(s.workspaceId, s.environmentId, { reason: "incident" });
      try {
        await approve(second.approvalId!);
      } finally {
        await m.halt.resumeEnvironment(s.workspaceId, s.environmentId, {});
      }
      expect((await s.effect(second.effectId!)).rejectionReason).toBe("environment_halted");

      const third = await s.invoke("refund", s.refund(100));
      await m.policies.createPolicy(s.workspaceId, {
        environmentId: s.environmentId, name: "deny refunds", matchKind: "action", matchActionName: "refund", effect: "auto_deny",
      } as never, { actor: { type: "user", id: s.userId } } as never);
      await approve(third.approvalId!);
      expect((await s.effect(third.effectId!)).rejectionReason).toBe("policy_denies");
      expect(s.stripe.writes).toBe(0);
    });

    it("an over-quota invoke is refused before any provider read and leaves no preview", async () => {
      await s.refundAction();
      await pool.query("UPDATE workspaces SET plan = 'free' WHERE id = $1", [s.workspaceId]);
      await pool.query(
        "INSERT INTO workspace_usage_periods (workspace_id, month, action_billed) VALUES ($1, $2, 1000000000)",
        [s.workspaceId, new Date().toISOString().slice(0, 7)],
      );
      await expect(s.invoke("refund", s.refund(500))).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
      expect(s.stripe.hosts).toHaveLength(0);
      const [{ n }] = (await pool.query("SELECT count(*)::int AS n FROM effect_previews WHERE workspace_id = $1", [s.workspaceId])).rows;
      expect(n).toBe(0);
    });

    it("concurrent invokes of one operation key leave exactly one preview, bound to the one effect", async () => {
      await s.refundAction();
      const results = await Promise.all([1, 2, 3].map(() => s.invoke("refund", s.refund(500), { effect: { operationKey: "op-concurrent-1" } })));
      expect(new Set(results.map((r) => r.effectId)).size).toBe(1);
      expect(s.stripe.refunds).toHaveLength(1);
      const [{ n }] = (await pool.query("SELECT count(*)::int AS n FROM effect_previews WHERE workspace_id = $1", [s.workspaceId])).rows;
      expect(n).toBe(1);
    });

    it("refreshing evidence creates a new preview; an approval of the old one never carries over", async () => {
      await s.fileAction();
      const first = await m.effects.createPreviewForAction(s.workspaceId, s.environmentId, "update-file", s.file("a.txt", "z\n"));
      s.github.externalWrite(REPO, BRANCH, "fixtures/a.txt", "moved on\n");
      const refreshed = await m.effects.refreshPreview(s.workspaceId, s.environmentId, first.id);
      expect(refreshed.id).not.toBe(first.id);
      expect(refreshed.supersedes).toBe(first.id);
      expect(refreshed.bindingDigest).not.toBe(first.bindingDigest);
      expect(refreshed.preconditions.blobSha).not.toBe(first.preconditions.blobSha);
      const stale = await s.invoke("update-file", s.file("a.txt", "z\n"), { effect: { previewId: first.id } });
      expect(stale.status).toBe("failed");
      const fresh = await s.invoke("update-file", s.file("a.txt", "z\n"), { effect: { previewId: refreshed.id } });
      expect(fresh.status).toBe("succeeded");
      await expect(s.invoke("update-file", s.file("a.txt", "z\n"), { effect: { previewId: refreshed.id } }))
        .rejects.toMatchObject({ code: "PREVIEW_ALREADY_USED" });
    });

    it("a refresh keeps the action version the preview reviewed, even after the action changed", async () => {
      await s.refundAction();
      const first = await m.effects.createPreviewForAction(s.workspaceId, s.environmentId, "refund", s.refund(500));
      await m.actions.updateAction(s.workspaceId, "refund", {
        adapter: { type: "stripe.refund", config: { account: "acct_otherAccount1", mode: "test", currency: "usd" }, credentialSecret: "STRIPE_TEST_KEY" },
      }, m.actions.UNSCOPED_AUTHORITY, s.environmentId);
      const refreshed = await m.effects.refreshPreview(s.workspaceId, s.environmentId, first.id);
      expect(refreshed.supersedes).toBe(first.id);
      expect(refreshed.action.versionId).toBe(first.action.versionId);
      await expect(s.invoke("refund", s.refund(500), { effect: { previewId: refreshed.id } }))
        .rejects.toMatchObject({ code: "PREVIEW_MISMATCH", details: { field: "actionVersion" } });
      expect(s.stripe.writes).toBe(0);
    });

    it("the receipt identifies the reviewed operation that ran", async () => {
      await s.refundAction("refund", { requiresApproval: true });
      const parked = await s.invoke("refund", s.refund(4321));
      await approve(parked.approvalId!);
      const effect = await s.effect(parked.effectId!);
      const [approval] = (await pool.query("SELECT binding_digest, preview_id, payload FROM approvals WHERE approval_id = $1", [parked.approvalId])).rows;
      expect(approval.binding_digest).toBe(effect.bindingDigest);
      expect(approval.preview_id).toBe(effect.previewId);
      expect(approval.payload).toMatchObject({ effectId: effect.id, previewId: effect.previewId });
      expect(effect.preview!.request).toEqual(effect.request);
      expect(s.stripe.refunds[0]).toMatchObject({ amount: 4321, payment_intent: "pi_order1" });
    });
  });
});
