import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { providerFetch } from "./support/effects/provider-fetch.ts";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});

const { EffectScope, loadEffectModules, REPO, BRANCH } = await import("./support/effects/fixture.ts");

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("governed effects: verified outcomes and recovery (real Postgres)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let m: Awaited<ReturnType<typeof loadEffectModules>>;
  let s: InstanceType<typeof EffectScope>;

  beforeAll(async () => {
    await pool.query("SELECT 1");
    m = await loadEffectModules();
  });
  beforeEach(async () => { s = await new EffectScope(pool, m).seed(); });
  afterEach(async () => { await s.cleanup(); });
  afterAll(async () => { await pool.end(); });

  it("records a confirmed refund with provider evidence, identity, and the reviewed binding", async () => {
    await s.refundAction();
    const result = await s.invoke("refund", s.refund(2500));
    expect(result.status).toBe("succeeded");
    expect(result.effectId).toMatch(/^eff_/);
    const effect = await s.effect(result.effectId!);
    expect(effect).toMatchObject({ stage: "settled", outcome: "succeeded", verification: "provider", partialEffect: "none" });
    expect(effect.providerReference).toMatch(/^re_/);
    expect(effect.evidence.map((e) => e.source)).toEqual(["preview", "system", "provider_response"]);
    expect(effect.preview?.bindingDigest).toBe(effect.bindingDigest);
    expect(s.stripe.refunds[0].metadata.anlyon_effect).toBe(effect.id);
    expect(s.stripe.idempotency.has(`anlyon-${effect.id}`)).toBe(true);
  });

  it("both adapters run through the same lifecycle", async () => {
    await s.refundAction();
    await s.fileAction();
    const refund = await s.effect((await s.invoke("refund", s.refund(100))).effectId!);
    const file = await s.effect((await s.invoke("update-file", s.file("a.txt", "a.txt v2\n"))).effectId!);
    for (const effect of [refund, file]) {
      expect(effect.outcome).toBe("succeeded");
      expect(effect.attempts.map((a) => [a.kind, a.status])).toEqual([["dispatch", "completed"]]);
      expect(effect.evidence[0].source).toBe("preview");
    }
    expect(file.providerReference).toMatch(/^[0-9a-f]{40}$/);
    expect(s.github.file(REPO, BRANCH, "fixtures/a.txt")!.content).toBe("a.txt v2\n");
  });

  describe("provider accepts the write, but the response is lost", () => {
    it("Stripe: unknown, never failed, then recovered by lookup without repeating the refund", async () => {
      await s.refundAction();
      s.stripe.fault("write", "lose_response_after_commit");
      const result = await s.invoke("refund", s.refund(8000));
      expect(result.status).toBe("unknown");
      expect(s.stripe.writes).toBe(1);
      let effect = await s.effect(result.effectId!);
      expect(effect).toMatchObject({ outcome: "unknown", stage: "reconciling", verification: "unverified", unresolvedExposure: true });
      expect(effect.reconciliation.nextAt).not.toBeNull();

      await s.due(effect.id);
      await m.reconcile.reconcileDueEffects();
      effect = await s.effect(effect.id);
      expect(effect).toMatchObject({ outcome: "succeeded", verification: "provider", providerReference: s.stripe.refunds[0].id });
      expect(effect.evidence.some((e) => e.source === "provider_lookup" && e.impliedOutcome === "succeeded")).toBe(true);
      expect(s.stripe.writes).toBe(1);
      const invocation = await m.actions.getInvocation(s.workspaceId, result.id, s.environmentId);
      expect(invocation.status).toBe("succeeded");
    });

    it("GitHub: recovered from commit history carrying the effect trailer", async () => {
      await s.fileAction();
      s.github.fault("write", "lose_response_after_commit");
      const result = await s.invoke("update-file", s.file("b.txt", "b.txt v2\n"));
      expect(result.status).toBe("unknown");
      await s.reconcileNow(result.effectId!);
      const effect = await s.effect(result.effectId!);
      expect(effect.outcome).toBe("succeeded");
      expect(effect.providerReference).toBe(s.github.commits.at(-1)!.sha);
      expect(s.github.writes).toBe(1);
    });

    it("a governed same-key replay recovers a lost Stripe write without a second refund", async () => {
      await s.refundAction();
      s.stripe.fault("write", "lose_response_after_commit");
      const result = await s.invoke("refund", s.refund(3000));
      await m.effects.replayEffectOperation(s.workspaceId, s.environmentId, result.effectId!, { type: "user", id: s.userId });
      const effect = await s.effect(result.effectId!);
      expect(effect.outcome).toBe("succeeded");
      expect(effect.attempts.map((a) => a.kind)).toEqual(["dispatch", "replay"]);
      expect(s.stripe.refunds).toHaveLength(1);
    });

    it("a replay is refused while the environment is halted, and by the key that requested it", async () => {
      await s.refundAction();
      const key = await s.apiKey("agent");
      s.stripe.fault("write", "lose_response_after_commit");
      const result = await s.invoke("refund", s.refund(3000), { requestedByKeyId: key.id });
      await expect(m.effects.replayEffectOperation(s.workspaceId, s.environmentId, result.effectId!, { type: "api_key", id: key.id }))
        .rejects.toThrow(/cannot replay/);
      await m.halt.haltEnvironment(s.workspaceId, s.environmentId, { reason: "test" });
      try {
        await expect(m.effects.replayEffectOperation(s.workspaceId, s.environmentId, result.effectId!, { type: "user", id: s.userId }))
          .rejects.toThrow(/halted/);
        await s.reconcileNow(result.effectId!);
        expect((await s.effect(result.effectId!)).outcome).toBe("succeeded");
      } finally {
        await m.halt.resumeEnvironment(s.workspaceId, s.environmentId, {});
      }
      expect(s.stripe.refunds).toHaveLength(1);
    });
  });

  it("a test-mode fault drill sends once, records unknown, holds the allowance, and settles from Stripe's record", async () => {
    await m.actions.createAction(s.workspaceId, {
      name: "refund-drill",
      urlTemplate: "",
      requiresApproval: false,
      adapter: { type: "stripe.refund", config: { account: s.stripe.accountId, mode: "test", currency: "usd", faultDrill: "drop_response_after_send" }, credentialSecret: "STRIPE_TEST_KEY" },
    }, m.actions.UNSCOPED_AUTHORITY, s.environmentId);
    const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "day", amount: 100_000 });
    const result = await s.invoke("refund-drill", s.refund(5400));
    expect(result.status).toBe("unknown");
    expect(s.stripe.writes).toBe(1);
    let effect = await s.effect(result.effectId!);
    expect(effect).toMatchObject({ outcome: "unknown", verification: "unverified", unresolvedExposure: true });
    expect(effect.preview?.blocks.some((b) => b.type === "fields" && b.fields.some((f) => f.label === "Fault drill"))).toBe(true);
    expect(await s.limitView(limit.id)).toMatchObject({ reserved: 5400, unknownExposure: 5400 });

    await s.due(effect.id);
    await m.reconcile.reconcileDueEffects();
    effect = await s.effect(effect.id);
    expect(effect).toMatchObject({ outcome: "succeeded", verification: "provider", providerReference: s.stripe.refunds[0].id });
    expect(s.stripe.writes).toBe(1);
    expect(await s.limitView(limit.id)).toMatchObject({ consumed: 5400, reserved: 0, unknownExposure: 0 });
  });

  it("a worker that crashes between dispatch and outcome persistence leaves unknown, reconciled, never re-sent", async () => {
    await s.refundAction();
    await pool.query(`CREATE OR REPLACE FUNCTION anlyon_test_crash() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'completed' THEN RAISE EXCEPTION 'simulated crash'; END IF; RETURN NEW; END; $$`);
    await pool.query("CREATE TRIGGER anlyon_test_crash BEFORE UPDATE ON effect_attempts FOR EACH ROW EXECUTE FUNCTION anlyon_test_crash()");
    try {
      const crashed = await s.invoke("refund", s.refund(4200)).then(() => null, (error: unknown) => error as Error & { cause?: Error });
      expect(String(crashed?.cause?.message ?? crashed?.message)).toMatch(/simulated crash/);
    } finally {
      await pool.query("DROP TRIGGER anlyon_test_crash ON effect_attempts");
      await pool.query("DROP FUNCTION anlyon_test_crash()");
    }
    expect(s.stripe.writes).toBe(1);
    const [{ effect_id: effectId }] = (await pool.query("SELECT effect_id FROM action_effects WHERE workspace_id = $1", [s.workspaceId])).rows;
    let effect = await s.effect(effectId);
    expect(effect).toMatchObject({ stage: "dispatching", outcome: "not_dispatched" });
    expect(effect.attempts[0].status).toBe("started");

    await pool.query("UPDATE effect_attempts SET lease_until = now() - interval '1 second' WHERE workspace_id = $1", [s.workspaceId]);
    const sweep = await m.reconcile.reconcileDueEffects();
    expect(sweep.abandoned).toBe(1);
    effect = await s.effect(effectId);
    expect(effect.attempts[0].status).toBe("abandoned");
    expect(effect.outcome).toBe("unknown");
    expect(effect.evidence.some((e) => /stopped before recording an outcome/.test(e.summary))).toBe(true);

    await s.reconcileNow(effectId);
    effect = await s.effect(effectId);
    expect(effect.outcome).toBe("succeeded");
    expect(s.stripe.writes).toBe(1);
  });

  it("multiple workers reconciling the same operation run one lookup and settle once", async () => {
    await s.refundAction();
    const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "month", amount: 100_000 });
    s.stripe.fault("write", "lose_response_after_commit");
    const result = await s.invoke("refund", s.refund(8000));
    await s.due(result.effectId!);
    await Promise.all(Array.from({ length: 6 }, () => m.reconcile.reconcileDueEffects()));
    const effect = await s.effect(result.effectId!);
    expect(effect.outcome).toBe("succeeded");
    expect(effect.attempts.filter((a) => a.kind === "reconcile")).toHaveLength(1);
    expect(await s.limitView(limit.id)).toMatchObject({ consumed: 8000, reserved: 0, unknownExposure: 0 });

    const other = await s.invoke("refund", s.refund(1000, "pi_order2"), {});
    const settled = await Promise.allSettled(Array.from({ length: 4 }, () =>
      m.effects.requestReconciliation(s.workspaceId, s.environmentId, other.effectId!)));
    expect(settled.every((r) => r.status === "rejected")).toBe(true);
    expect(await s.limitView(limit.id)).toMatchObject({ consumed: 9000, reserved: 0 });
  });

  it("a pending refund holds its exposure until the provider reports a final result", async () => {
    await s.refundAction();
    const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
    s.stripe.fault("write", "pending");
    const result = await s.invoke("refund", s.refund(6000));
    expect(result.status).toBe("running");
    let effect = await s.effect(result.effectId!);
    expect(effect).toMatchObject({ outcome: "pending", stage: "reconciling" });
    expect(await s.limitView(limit.id)).toMatchObject({ reserved: 6000, unknownExposure: 0, available: 4000 });

    await s.reconcileNow(effect.id);
    expect((await s.effect(effect.id)).outcome).toBe("pending");

    s.stripe.settle(effect.providerReference!, "failed");
    await s.reconcileNow(effect.id);
    effect = await s.effect(effect.id);
    expect(effect).toMatchObject({ outcome: "failed", partialEffect: "none", verification: "provider" });
    expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 0, available: 10_000 });
  });

  describe("evidence that is missing, contradictory, or eventually consistent", () => {
    it("eventually consistent: a refund not yet listed stays unknown, then is found", async () => {
      await s.refundAction();
      s.stripe.fault("write", "lose_response_after_commit").fault("lookup", "hide_from_list");
      const result = await s.invoke("refund", s.refund(500));
      await s.reconcileNow(result.effectId!);
      expect((await s.effect(result.effectId!)).outcome).toBe("unknown");
      await s.reconcileNow(result.effectId!);
      expect((await s.effect(result.effectId!)).outcome).toBe("succeeded");
    });

    it("missing marker: a committed refund whose metadata was removed stays unknown, allowance held", async () => {
      await s.refundAction();
      const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
      s.stripe.fault("write", "lose_response_after_commit");
      const result = await s.invoke("refund", s.refund(700));
      expect(result.status).toBe("unknown");
      expect(s.stripe.refunds).toHaveLength(1);
      s.stripe.refunds[0].metadata = {};

      await s.backdateDispatch(result.effectId!, 10 * 60_000);
      for (let i = 0; i < 4; i++) await s.reconcileNow(result.effectId!);
      const effect = await s.effect(result.effectId!);
      expect(effect).toMatchObject({ outcome: "unknown", unresolvedExposure: true });
      expect(effect.evidence.some((e) => e.summary.includes("does not prove none was made"))).toBe(true);
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 700, unknownExposure: 700 });
      const invocation = await m.actions.getInvocation(s.workspaceId, result.id, s.environmentId);
      expect(invocation.status).toBe("unknown");
      expect(s.stripe.refunds).toHaveLength(1);
    });

    it("a refund Stripe reports failed settles failed on the provider's proof and releases its allowance", async () => {
      await s.refundAction();
      const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
      s.stripe.fault("write", "pending");
      const result = await s.invoke("refund", s.refund(900));
      s.stripe.settle(s.stripe.refunds[0].id, "failed");
      await s.reconcileNow(result.effectId!);
      expect(await s.effect(result.effectId!)).toMatchObject({ outcome: "failed", verification: "provider" });
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 0, unknownExposure: 0 });
    });

    it("contradictory: matching file content without an attributable commit is not success", async () => {
      await s.fileAction();
      s.github.fault("write", "http_502_before_commit");
      const result = await s.invoke("update-file", s.file("c.txt", "c.txt v2\n"));
      expect(result.status).toBe("unknown");
      s.github.externalWrite(REPO, BRANCH, "fixtures/c.txt", "c.txt v2\n");
      await s.backdateDispatch(result.effectId!, 10 * 60_000);
      await s.reconcileNow(result.effectId!);
      await s.reconcileNow(result.effectId!);
      const effect = await s.effect(result.effectId!);
      expect(effect.outcome).toBe("unknown");
      expect(effect.partialEffect).toBe("possible");
      expect(effect.evidence.some((e) => /does not prove Anlyon made the change/.test(e.summary))).toBe(true);
    });

    it("reconciliation is bounded: it stops, visibly, after its attempt limit", async () => {
      await s.refundAction();
      s.stripe.fault("write", "timeout_before_commit");
      const result = await s.invoke("refund", s.refund(100));
      await pool.query("UPDATE action_effects SET reconcile_attempts = $2 WHERE effect_id = $1", [result.effectId, m.lifecycle.MAX_RECONCILE_ATTEMPTS]);
      await s.due(result.effectId!);
      await m.reconcile.reconcileDueEffects();
      const effect = await s.effect(result.effectId!);
      expect(effect.reconciliation).toMatchObject({ exhausted: true, nextAt: null });
      expect(effect.evidence.some((e) => /Automatic reconciliation stopped/.test(e.summary))).toBe(true);
      const alerts = await pool.query(
        "SELECT title, action_url FROM notifications WHERE workspace_id = $1 AND type = 'outcome_unknown'", [s.workspaceId],
      );
      expect(alerts.rows).toHaveLength(1);
      expect(alerts.rows[0].action_url).toContain(`effect=${result.effectId}`);
    });
  });

  describe("duplicate attempts preserve one effect identity", () => {
    it("the same operation key and request returns the existing operation, concurrently too", async () => {
      await s.refundAction();
      const results = await Promise.all(Array.from({ length: 5 }, () =>
        s.invoke("refund", s.refund(1200), { effect: { operationKey: "order-1-refund" } })));
      expect(new Set(results.map((r) => r.effectId)).size).toBe(1);
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(s.stripe.writes).toBe(1);
      const again = await s.invoke("refund", s.refund(1200), { effect: { operationKey: "order-1-refund" } });
      expect(again).toMatchObject({ effectId: results[0].effectId, replayed: true });
    });

    it("the same key with a different request is refused", async () => {
      await s.refundAction();
      await s.invoke("refund", s.refund(1200), { effect: { operationKey: "order-2-refund" } });
      await expect(s.invoke("refund", s.refund(1300), { effect: { operationKey: "order-2-refund" } }))
        .rejects.toMatchObject({ code: "OPERATION_KEY_REUSE", statusCode: 409 });
    });

    it("different keys do NOT establish different intent: they are two operations", async () => {
      await s.refundAction();
      const a = await s.invoke("refund", s.refund(100), { effect: { operationKey: "k1" } });
      const b = await s.invoke("refund", s.refund(100), { effect: { operationKey: "k2" } });
      expect(a.effectId).not.toBe(b.effectId);
      expect(s.stripe.refunds).toHaveLength(2);
    });

    it("the database refuses a second dispatch attempt for one effect", async () => {
      await s.refundAction();
      const result = await s.invoke("refund", s.refund(100));
      const row = await s.row(result.effectId!);
      await expect(pool.query(
        "INSERT INTO effect_attempts (workspace_id, environment_id, effect_id, attempt_no, kind, lease_owner, lease_until) VALUES ($1, $2, $3, 99, 'dispatch', 'x', now())",
        [row.workspaceId, row.environmentId, row.id],
      )).rejects.toThrow(/effect_attempts_one_dispatch/);
    });
  });

  describe("isolation", () => {
    it("cross-workspace and cross-environment recovery is denied", async () => {
      await s.refundAction();
      s.stripe.fault("write", "lose_response_after_commit");
      const result = await s.invoke("refund", s.refund(100));
      const staging = (await pool.query(
        "INSERT INTO environments (workspace_id, name, slug, kind, is_default) VALUES ($1, 'Staging', 'staging', 'staging', false) RETURNING id",
        [s.workspaceId],
      )).rows[0] as { id: string };
      const other = await new EffectScope(pool, m).seed();
      try {
        const actor = { type: "user" as const, id: s.userId };
        for (const [ws, env] of [[s.workspaceId, staging.id], [other.workspaceId, other.environmentId]]) {
          await expect(m.effects.getEffect(ws, env, result.effectId!)).rejects.toThrow(/not found/i);
          await expect(m.effects.requestReconciliation(ws, env, result.effectId!)).rejects.toThrow(/not found/i);
          await expect(m.effects.resolveEffectManually(ws, env, result.effectId!, { outcome: "failed", reason: "not mine to resolve" }, actor)).rejects.toThrow(/not found/i);
          await expect(m.effects.replayEffectOperation(ws, env, result.effectId!, actor)).rejects.toThrow(/not found/i);
          await expect(m.effects.addEffectNote(ws, env, result.effectId!, "peeking", actor)).rejects.toThrow(/not found/i);
        }
        const row = await s.row(result.effectId!);
        await expect(pool.query(
          "INSERT INTO effect_evidence (workspace_id, environment_id, effect_id, source, observed_at, summary) VALUES ($1, $2, $3, 'system', now(), 'x')",
          [s.workspaceId, staging.id, row.id],
        )).rejects.toThrow(/effect_evidence_effect_scope_fk/);
      } finally {
        await other.cleanup();
      }
    });
  });

  it("a later external change does not rewrite the historical execution result", async () => {
    await s.fileAction();
    const result = await s.invoke("update-file", s.file("d.txt", "d.txt v2\n"));
    const before = await s.effect(result.effectId!);
    expect(before.outcome).toBe("succeeded");
    s.github.externalWrite(REPO, BRANCH, "fixtures/d.txt", "d.txt reverted\n");
    await expect(m.effects.requestReconciliation(s.workspaceId, s.environmentId, before.id)).rejects.toThrow(/succeeded/);
    await expect(pool.query("UPDATE action_effects SET outcome = 'failed' WHERE effect_id = $1", [before.id]))
      .rejects.toThrow(/never rewritten/);
    await expect(pool.query("UPDATE effect_evidence SET summary = 'edited' WHERE effect_id = (SELECT id FROM action_effects WHERE effect_id = $1)", [before.id]))
      .rejects.toThrow(/append-only/);
    await expect(pool.query("UPDATE action_effects SET request = '{}'::jsonb WHERE effect_id = $1", [before.id]))
      .rejects.toThrow(/immutable/);
    const after = await s.effect(result.effectId!);
    expect(after).toMatchObject({ outcome: "succeeded", providerReference: before.providerReference });
    expect(after.evidence).toHaveLength(before.evidence.length);
  });

  describe("operator recovery", () => {
    it("notes and a reasoned manual resolution are recorded as manual, never as provider verification", async () => {
      await s.refundAction();
      const key = await s.apiKey("agent");
      const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
      s.stripe.fault("write", "timeout_before_commit");
      const result = await s.invoke("refund", s.refund(900), { requestedByKeyId: key.id });
      await expect(m.effects.resolveEffectManually(s.workspaceId, s.environmentId, result.effectId!,
        { outcome: "failed", reason: "agent says it did not happen" }, { type: "api_key", id: key.id })).rejects.toThrow(/cannot resolve/);
      await m.effects.addEffectNote(s.workspaceId, s.environmentId, result.effectId!, "Checked the dashboard: no refund.", { type: "user", id: s.userId });
      const effect = await m.effects.resolveEffectManually(s.workspaceId, s.environmentId, result.effectId!,
        { outcome: "failed", reason: "No refund exists for the order in the Stripe dashboard.", externalReference: "pi_order1" },
        { type: "user", id: s.userId });
      expect(effect).toMatchObject({ outcome: "failed", verification: "manual" });
      expect(effect.evidence.map((e) => e.source)).toEqual(expect.arrayContaining(["operator_note", "manual_resolution"]));
      expect(effect.evidence.find((e) => e.source === "manual_resolution")!.actor).toEqual({ type: "user", id: s.userId });
      expect(await s.limitView(limit.id)).toMatchObject({ reserved: 0, consumed: 0 });
      await expect(m.effects.resolveEffectManually(s.workspaceId, s.environmentId, result.effectId!,
        { outcome: "succeeded", reason: "changed my mind about it" }, { type: "user", id: s.userId })).rejects.toThrow(/not rewritten/);
    });

    it("a failed operation with possible partial impact keeps its exposure until resolved", async () => {
      await s.refundAction();
      const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
      s.stripe.fault("write", "timeout_before_commit");
      const result = await s.invoke("refund", s.refund(4000));
      await m.effects.resolveEffectManually(s.workspaceId, s.environmentId, result.effectId!,
        { outcome: "failed", partialEffect: "possible", reason: "Provider support is still investigating." }, { type: "user", id: s.userId });
      expect(await s.limitView(limit.id)).toMatchObject({ reserved: 4000, unknownExposure: 4000, consumed: 0 });
      const effect = await m.effects.resolveEffectManually(s.workspaceId, s.environmentId, result.effectId!,
        { outcome: "failed", partialEffect: "confirmed", actualImpact: [{ dimension: "money", currency: "usd", amount: 1500, bound: "exact" }], reason: "Support confirmed 15.00 was refunded." },
        { type: "user", id: s.userId });
      expect(effect).toMatchObject({ outcome: "failed", partialEffect: "confirmed", stage: "settled" });
      expect(await s.limitView(limit.id)).toMatchObject({ reserved: 0, unknownExposure: 0, consumed: 1500 });
    });
  });

  describe("policy amounts", () => {
    it("a minAmount policy compares an adapter refund in minor units and the approval says so", async () => {
      await s.refundAction();
      await m.policies.createPolicy(s.workspaceId, {
        environmentId: s.environmentId, name: "refunds over 10.00", matchKind: "action", matchActionName: "refund", minAmount: 1000, effect: "require_approval",
      } as never, { actor: { type: "user", id: s.userId } } as never);
      const parked = await s.invoke("refund", s.refund(1250));
      expect(parked.pendingApproval).toBe(true);
      const [{ policy_explanation }] = (await pool.query("SELECT policy_explanation FROM approvals WHERE approval_id = $1", [parked.approvalId])).rows;
      expect(policy_explanation).toContain("Compared the policy's minimum amount with 1250 USD minor units");
    });
  });

  describe("manual resolution quantities", () => {
    it("actualImpact in another currency, an undeclared dimension, or a repeated dimension is refused and releases nothing", async () => {
      await s.refundAction();
      const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
      s.stripe.fault("write", "timeout_before_commit");
      const result = await s.invoke("refund", s.refund(4000));
      const operator = { type: "user" as const, id: s.userId };
      const resolve = (actualImpact: Array<Record<string, unknown>>) => m.effects.resolveEffectManually(s.workspaceId, s.environmentId, result.effectId!,
        { outcome: "failed", partialEffect: "confirmed", actualImpact: actualImpact as never, reason: "Support confirmed part of it was refunded." }, operator);
      await expect(resolve([{ dimension: "money", currency: "eur", amount: 1500, bound: "exact" }]))
        .rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
      await expect(resolve([{ dimension: "money", currency: "usd", amount: 1500, bound: "exact" }, { dimension: "money", currency: "usd", amount: 0, bound: "exact" }]))
        .rejects.toMatchObject({ statusCode: 400 });
      await s.fileAction();
      s.github.fault("write", "lose_response_after_commit");
      const file = await s.invoke("update-file", s.file("a.txt", "changed\n"));
      await expect(m.effects.resolveEffectManually(s.workspaceId, s.environmentId, file.effectId!,
        { outcome: "succeeded", actualImpact: [{ dimension: "money", currency: "usd", amount: 0, bound: "exact" }], reason: "The commit is on the branch." }, operator))
        .rejects.toMatchObject({ statusCode: 400 });
      expect((await s.effect(result.effectId!)).outcome).toBe("unknown");
      expect(await s.limitView(limit.id)).toMatchObject({ reserved: 4000, unknownExposure: 4000, consumed: 0 });
    });

    it("a dimension actualImpact leaves out settles its reservation in full rather than releasing it", async () => {
      await s.refundAction();
      const mutations = await s.limit({ name: "refund count", dimension: "resource_mutations", period: "month", amount: 10, actionName: "refund" });
      s.stripe.fault("write", "timeout_before_commit");
      const result = await s.invoke("refund", s.refund(4000));
      await m.effects.resolveEffectManually(s.workspaceId, s.environmentId, result.effectId!,
        { outcome: "failed", partialEffect: "confirmed", actualImpact: [{ dimension: "money", currency: "usd", amount: 1500, bound: "exact" }], reason: "Support confirmed 15.00 was refunded." },
        { type: "user", id: s.userId });
      expect(await s.limitView(mutations.id)).toMatchObject({ reserved: 0, consumed: 1 });
    });
  });

  describe("dependent work requires a declared outcome", () => {
    it("unknown and pending outcomes never unlock a dependent effect", async () => {
      await s.refundAction();
      await s.fileAction();
      s.stripe.fault("write", "lose_response_after_commit");
      const refund = await s.invoke("refund", s.refund(100));
      await expect(s.invoke("update-file", s.file("e.txt", "refunded\n"), { effect: { dependsOn: [{ effect: refund.effectId!, outcome: "succeeded" }] } }))
        .rejects.toMatchObject({ code: "DEPENDENCY_UNRESOLVED" });
      await s.reconcileNow(refund.effectId!);
      const dependent = await s.invoke("update-file", s.file("e.txt", "refunded\n"), { effect: { dependsOn: [{ effect: refund.effectId!, outcome: "succeeded" }] } });
      expect(dependent.status).toBe("succeeded");
    });
  });
});
