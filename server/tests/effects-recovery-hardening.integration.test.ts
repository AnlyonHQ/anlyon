import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { providerFetch } from "./support/effects/provider-fetch.ts";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});

const clock = vi.hoisted(() => ({ offsetMs: 0 }));
vi.mock("../src/db/clock.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/clock.ts")>();
  return {
    ...actual,
    readDbNow: async (...args: Parameters<typeof actual.readDbNow>) =>
      new Date((await actual.readDbNow(...args)).getTime() + clock.offsetMs),
  };
});

const { EffectScope, loadEffectModules } = await import("./support/effects/fixture.ts");
const { implicitPreviewTtlSeconds } = await import("../src/core/effects/previews.ts");

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("governed effects: recovery hardening (real Postgres)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let m: Awaited<ReturnType<typeof loadEffectModules>>;
  let resolution: typeof import("../src/core/actions/resolution.ts");
  let s: InstanceType<typeof EffectScope>;

  beforeAll(async () => {
    await pool.query("SELECT 1");
    m = await loadEffectModules();
    resolution = await import("../src/core/actions/resolution.ts");
  });
  beforeEach(async () => { s = await new EffectScope(pool, m).seed(); });
  afterEach(async () => {
    clock.offsetMs = 0;
    await s.cleanup();
  });
  afterAll(async () => { await pool.end(); });

  const operator = () => ({ type: "user" as const, id: s.userId });

  async function lostRefund(opts: { requestedByKeyId?: string } = {}) {
    await s.refundAction();
    s.stripe.fault("write", "lose_response_after_commit");
    const result = await s.invoke("refund", s.refund(3000), opts);
    expect(result.status).toBe("unknown");
    expect(s.stripe.refunds).toHaveLength(1);
    return result.effectId!;
  }

  async function expectReplayRefused(effectId: string, reason: string) {
    const refused = await m.effects.replayEffectOperation(s.workspaceId, s.environmentId, effectId, operator())
      .then(() => null, (error: { statusCode?: number; code?: string; details?: { reason?: string } }) => error);
    expect(refused).toMatchObject({ statusCode: 409, code: "REPLAY_REFUSED", details: { reason } });
    const effect = await s.effect(effectId);
    expect(effect.outcome).toBe("unknown");
    expect(effect.attempts.map((a) => a.kind)).toEqual(["dispatch"]);
    expect(effect.evidence.some((e) => e.source === "system" && e.summary.startsWith(`Replay refused (${reason})`))).toBe(true);
    expect(s.stripe.writes).toBe(1);
  }

  async function expectRefusal(effectId: string, reason: string) {
    const refused = await m.effects.replayEffectOperation(s.workspaceId, s.environmentId, effectId, operator())
      .then(() => null, (error: { statusCode?: number; code?: string; details?: { reason?: string } }) => error);
    expect(refused, reason).toMatchObject({ statusCode: 409, code: "REPLAY_REFUSED", details: { reason } });
    const effect = await s.effect(effectId);
    expect(effect.evidence.some((e) => e.summary.startsWith(`Replay refused (${reason})`)), reason).toBe(true);
    expect(effect.attempts.filter((a) => a.kind === "replay"), reason).toHaveLength(0);
  }

  describe("replay passes the same controls as a first dispatch", () => {
    it("is refused when current policy denies the operation", async () => {
      const effectId = await lostRefund();
      await m.policies.createPolicy(s.workspaceId, {
        environmentId: s.environmentId, name: "no refunds", matchKind: "action", matchActionName: "refund", effect: "auto_deny",
      });
      await expectReplayRefused(effectId, "policy_denies");
    });

    it("is refused when the credential that requested it was revoked", async () => {
      const agent = await s.apiKey("agent");
      const effectId = await lostRefund({ requestedByKeyId: agent.id });
      await m.keys.revokeApiKey(agent.id, s.workspaceId);
      await expectReplayRefused(effectId, "authority_revoked");
    });

    it("is refused once the reviewed preview has expired", async () => {
      const effectId = await lostRefund();
      clock.offsetMs = (implicitPreviewTtlSeconds() + 3600) * 1000;
      await expectReplayRefused(effectId, "preview_expired");
    });

    it("is refused when the action now resolves to a different version", async () => {
      const effectId = await lostRefund();
      await m.secrets.putSecret(s.workspaceId, "STRIPE_ROTATED_KEY", { value: "sk_test_simulator_key_0000000000", allowedHosts: ["api.stripe.com"] }, s.environmentId);
      await m.actions.updateAction(s.workspaceId, "refund", {
        adapter: { type: "stripe.refund", config: { account: s.stripe.accountId, mode: "test", currency: "usd" }, credentialSecret: "STRIPE_ROTATED_KEY" },
      }, m.actions.UNSCOPED_AUTHORITY, s.environmentId);
      await expectReplayRefused(effectId, "action_changed");
    });

    it("still recovers the lost write when every control holds", async () => {
      const effectId = await lostRefund();
      await m.effects.replayEffectOperation(s.workspaceId, s.environmentId, effectId, operator());
      const effect = await s.effect(effectId);
      expect(effect.outcome).toBe("succeeded");
      expect(effect.attempts.map((a) => a.kind)).toEqual(["dispatch", "replay"]);
      expect(s.stripe.refunds).toHaveLength(1);
    });

    it("a replay that never sends preserves the original uncertainty and its allowance", async () => {
      const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
      const effectId = await lostRefund();
      s.stripe.fault("preflight", "account_unreachable");
      const replayed = await m.effects.replayEffectOperation(s.workspaceId, s.environmentId, effectId, operator());
      expect(replayed.outcome).toBe("unknown");
      expect(replayed.attempts.map((a) => [a.kind, a.status])).toEqual([["dispatch", "completed"], ["replay", "completed"]]);
      expect(replayed.evidence.some((e) => e.summary.startsWith("The replay attempt failed, which says nothing about the original write"))).toBe(true);
      expect(s.stripe.refunds).toHaveLength(1);
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 3000, unknownExposure: 3000 });
      const [{ status }] = (await pool.query(
        "SELECT i.status FROM action_invocations i JOIN action_effects e ON e.invocation_id = i.id WHERE e.effect_id = $1", [effectId],
      )).rows;
      expect(status).toBe("unknown");

      await s.reconcileNow(effectId);
      expect((await s.effect(effectId)).outcome).toBe("succeeded");
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 3000, reserved: 0, unknownExposure: 0 });
      expect(s.stripe.refunds).toHaveLength(1);
    });

    it("a replay the provider refuses does not finalize the original as failed", async () => {
      const effectId = await lostRefund();
      s.stripe.idempotency.clear();
      s.stripe.paymentIntents.get("pi_order1")!.amount_received = 3000;
      const replayed = await m.effects.replayEffectOperation(s.workspaceId, s.environmentId, effectId, operator());
      expect(replayed.outcome).toBe("unknown");
      expect(s.stripe.refunds).toHaveLength(1);
      await s.reconcileNow(effectId);
      expect((await s.effect(effectId)).outcome).toBe("succeeded");
    });

    it("every refusal has the same shape: REPLAY_REFUSED with a reason, recorded, nothing sent", async () => {
      await s.fileAction();
      s.github.fault("write", "lose_response_after_commit");
      const file = await s.invoke("update-file", s.file("a.txt", "changed\n"));
      await expectRefusal(file.effectId!, "replay_unsupported");

      const settled = await (async () => { await s.refundAction("refund-ok"); return s.invoke("refund-ok", s.refund(100, "pi_order2")); })();
      await expectRefusal(settled.effectId!, "not_unknown");

      s.stripe.fault("write", "lose_response_after_commit");
      const lost = await s.invoke("refund-ok", s.refund(200, "pi_order3"));
      await pool.query("UPDATE action_effects SET first_dispatched_at = now() - interval '2 days' WHERE effect_id = $1", [lost.effectId]);
      await expectRefusal(lost.effectId!, "replay_window_passed");
      expect(s.stripe.refunds).toHaveLength(2);
      expect(s.github.writes).toBe(1);
    });

    it("is not offered for GitHub file updates", async () => {
      await s.fileAction();
      s.github.fault("write", "lose_response_after_commit");
      const result = await s.invoke("update-file", s.file("a.txt", "changed\n"));
      await expectRefusal(result.effectId!, "replay_unsupported");
      expect(s.github.writes).toBe(1);
    });
  });

  describe("crash windows", () => {
    async function withTrigger(table: string, when: string, fn: () => Promise<void>) {
      await pool.query(`CREATE OR REPLACE FUNCTION anlyon_test_crash() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF ${when} THEN RAISE EXCEPTION 'simulated crash'; END IF; RETURN NEW; END; $$`);
      await pool.query(`CREATE TRIGGER anlyon_test_crash BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION anlyon_test_crash()`);
      try {
        await fn();
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS anlyon_test_crash ON ${table}`);
        await pool.query("DROP FUNCTION IF EXISTS anlyon_test_crash()");
      }
    }

    it("a reconciliation claim never commits without its attempt, so a crash there cannot strand the effect", async () => {
      const effectId = await lostRefund();
      await s.due(effectId);
      await withTrigger("effect_attempts", "TG_OP = 'INSERT' AND NEW.kind = 'reconcile'", async () => {
        await expect(m.reconcile.reconcileDueEffects()).rejects.toThrow();
      });
      const row = await s.row(effectId);
      expect(row.reconcileLeaseOwner).toBeNull();
      expect(row.nextReconcileAt).not.toBeNull();
      await pool.query("UPDATE action_effects SET reconcile_lease_until = NULL, next_reconcile_at = now() - interval '1 second' WHERE effect_id = $1", [effectId]);
      await m.reconcile.reconcileDueEffects();
      expect((await s.effect(effectId)).outcome).toBe("succeeded");
      expect(s.stripe.writes).toBe(1);
    });

    it("a lease orphaned by earlier code (no schedule, no attempt) is recovered once it expires", async () => {
      const effectId = await lostRefund();
      await pool.query(
        `UPDATE action_effects SET reconcile_lease_owner = 'dead:worker', reconcile_lease_until = now() - interval '1 minute',
           next_reconcile_at = NULL WHERE effect_id = $1`, [effectId],
      );
      await m.reconcile.reconcileDueEffects();
      expect((await s.effect(effectId)).outcome).toBe("succeeded");
    });

    it("a claimed reconciliation whose worker died is due again after its lease", async () => {
      const effectId = await lostRefund();
      await s.due(effectId);
      await withTrigger("effect_attempts", "TG_OP = 'UPDATE' AND NEW.kind = 'reconcile' AND NEW.status = 'completed'", async () => {
        await m.reconcile.reconcileDueEffects();
      });
      const claimed = await pool.query(
        "SELECT a.status FROM effect_attempts a JOIN action_effects e ON e.id = a.effect_id WHERE e.effect_id = $1 AND a.kind = 'reconcile'", [effectId],
      );
      expect(claimed.rows.map((r) => r.status)).toEqual(["started"]);
      await pool.query(
        "UPDATE effect_attempts SET lease_until = now() - interval '1 second' FROM action_effects e WHERE e.id = effect_attempts.effect_id AND e.effect_id = $1", [effectId],
      );
      await pool.query("UPDATE action_effects SET reconcile_lease_until = now() - interval '1 second' WHERE effect_id = $1", [effectId]);
      await m.reconcile.reconcileDueEffects();
      await m.reconcile.reconcileDueEffects();
      expect((await s.effect(effectId)).outcome).toBe("succeeded");
      expect(s.stripe.writes).toBe(1);
    });

    it("an effect admitted but never platform-claimed is resumed through the normal claims, once", async () => {
      await s.refundAction();
      await withTrigger("action_invocations",
        "TG_OP = 'UPDATE' AND OLD.dispatch_claimed_at IS NULL AND NEW.dispatch_claimed_at IS NOT NULL", async () => {
          await expect(s.invoke("refund", s.refund(1200))).rejects.toThrow();
        });
      const stranded = await pool.query(
        `SELECT e.effect_id, e.stage, i.status, i.dispatch_claimed_at FROM action_effects e
           JOIN action_invocations i ON i.id = e.invocation_id WHERE e.workspace_id = $1`, [s.workspaceId],
      );
      expect(stranded.rows).toHaveLength(1);
      const { effect_id: effectId } = stranded.rows[0];
      expect(stranded.rows[0]).toMatchObject({ stage: "ready", status: "running", dispatch_claimed_at: null });
      expect(s.stripe.writes).toBe(0);

      expect(await m.reconcile.resumeReadyEffects()).toBe(0);
      const [first, second] = await Promise.all([m.reconcile.resumeReadyEffects(0), m.reconcile.resumeReadyEffects(0)]);
      expect(first + second).toBe(1);
      const effect = await s.effect(effectId);
      expect(effect.outcome).toBe("succeeded");
      expect(s.stripe.refunds).toHaveLength(1);
      const invocation = await pool.query(
        "SELECT i.status, i.usage_state, i.dispatch_claimed_at FROM action_invocations i JOIN action_effects e ON e.invocation_id = i.id WHERE e.effect_id = $1", [effectId],
      );
      expect(invocation.rows[0]).toMatchObject({ status: "succeeded", usage_state: "billed" });
      expect(invocation.rows[0].dispatch_claimed_at).not.toBeNull();
      expect(await m.reconcile.resumeReadyEffects(0)).toBe(0);
    });
  });

  it("the invocation resolve endpoint refuses a governed invocation and points at the effect", async () => {
    const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
    const effectId = await lostRefund();
    const [invocation] = (await pool.query(
      "SELECT i.invocation_id FROM action_invocations i JOIN action_effects e ON e.invocation_id = i.id WHERE e.effect_id = $1", [effectId],
    )).rows;
    const refused = await resolution.resolveInvocation(s.workspaceId, s.environmentId, invocation.invocation_id,
      { outcome: "failed", evidence: "Checked the dashboard." }, operator())
      .then(() => null, (error: { statusCode?: number; code?: string; details?: unknown }) => error);
    expect(refused).toMatchObject({ statusCode: 409, code: "EFFECT_RESOLUTION_REQUIRED", details: { effectId } });
    const after = await m.actions.getInvocation(s.workspaceId, invocation.invocation_id, s.environmentId);
    expect(after.status).toBe("unknown");
    expect((await s.effect(effectId)).outcome).toBe("unknown");
    expect(await s.limitView(limit.id)).toMatchObject({ reserved: 3000, unknownExposure: 3000 });
  });

  it("a governed effect records its action_call span, which settles in place when the outcome does", async () => {
    const runs = await import("../src/core/runs/service.ts");
    const scope = { workspaceId: s.workspaceId, environmentId: s.environmentId };
    const run = await runs.startRun(scope, { name: "agent" });
    await s.refundAction();
    s.stripe.fault("write", "lose_response_after_commit");
    const result = await s.invoke("refund", s.refund(2200), { traceRunId: run.id });
    const spanOf = async () => (await runs.getRunWithTree(scope, run.id)).spans.find((span) => span.type === "action_call");

    const unknown = await spanOf();
    expect(unknown).toMatchObject({ name: "refund", status: "running" });
    expect(unknown!.attributes).toMatchObject({ invocationId: result.id, effectId: result.effectId, outcome: "unknown" });

    await s.reconcileNow(result.effectId!);
    const settled = await spanOf();
    expect(settled).toMatchObject({ id: unknown!.id, status: "succeeded" });
    expect(settled!.attributes).toMatchObject({ outcome: "succeeded", verification: "provider" });
    expect((await runs.getRunWithTree(scope, run.id)).spans.filter((span) => span.type === "action_call")).toHaveLength(1);
  });
});
