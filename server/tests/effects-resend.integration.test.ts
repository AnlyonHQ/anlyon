import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { providerFetch } from "./support/effects/provider-fetch.ts";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});

const { EffectScope, loadEffectModules, RESEND_SIM_DOMAIN, RESEND_SIM_KEY } = await import("./support/effects/fixture.ts");

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("governed effects: Resend email send (real Postgres)", () => {
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

  const sends = () => s.resend.requests.filter((r) => r.method === "POST");
  const emailLimit = (amount: number) => s.limit({ name: "daily emails", dimension: "emails", period: "day", amount });
  const recipients = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}@example.com`);

  it("an emails limit of 10 is shared across two keys: sends run until it is reached and the rest are refused", async () => {
    await s.emailAction();
    const limit = await emailLimit(10);
    expect(limit).toMatchObject({ dimension: "emails", unit: "emails", currency: null, limit: 10, available: 10 });
    const first = await s.apiKey("agent-1");
    const second = await s.apiKey("agent-2");

    const a = await s.invoke("send-receipt", s.mail(recipients(4, "a")), { requestedByKeyId: first.id });
    const b = await s.invoke("send-receipt", s.mail(recipients(4, "b")), { requestedByKeyId: second.id });
    const c = await s.invoke("send-receipt", s.mail(recipients(4, "c")), { requestedByKeyId: second.id });
    const d = await s.invoke("send-receipt", s.mail(recipients(2, "d")), { requestedByKeyId: first.id });
    const e = await s.invoke("send-receipt", s.mail(recipients(1, "e")), { requestedByKeyId: second.id });

    expect([a.status, b.status, c.status, d.status, e.status]).toEqual(["succeeded", "succeeded", "failed", "succeeded", "failed"]);
    expect(c.error).toMatch(/impact_limit_exceeded/);
    expect(e.error).toMatch(/impact_limit_exceeded/);
    expect(sends()).toHaveLength(3);
    expect(s.resend.writes).toBe(3);
    expect(s.resend.recipients()).toBe(10);
    expect(await s.limitView(limit.id)).toMatchObject({ consumed: 10, reserved: 0, available: 0 });

    for (const refused of [c, e]) {
      expect(refused.grade).toBe("refused");
      const effect = await s.effect(refused.effectId!);
      expect(effect).toMatchObject({ stage: "rejected", outcome: "not_dispatched", rejectionReason: "impact_limit_exceeded", grade: "refused" });
      expect(effect.attempts).toHaveLength(0);
    }
    const settled = await s.effect(a.effectId!);
    expect(settled.impact).toEqual([{ dimension: "emails", amount: 4, bound: "exact" }]);
    expect(settled.reservations).toMatchObject([{ dimension: "emails", amount: 4, state: "settled", settled: 4 }]);
  });

  it("an accepted send is graded confirmed after the read-back, and acknowledged when the read-back finds nothing", async () => {
    await s.emailAction();
    const result = await s.invoke("send-receipt", s.mail(["a@example.com", "b@example.com"]));
    expect(result).toMatchObject({ status: "succeeded", grade: "confirmed" });
    const effect = await s.effect(result.effectId!);
    const email = s.resend.emails[0];
    expect(effect).toMatchObject({
      stage: "settled", outcome: "succeeded", grade: "confirmed", verification: "provider",
      adapter: { type: "resend.email_send", version: "1" },
      target: { account: RESEND_SIM_DOMAIN, resourceKey: `resend:${RESEND_SIM_DOMAIN}:from/billing@${RESEND_SIM_DOMAIN}` },
      providerReference: email.id,
    });
    expect(email.tags).toEqual([{ name: "anlyon_effect", value: result.effectId }]);
    expect(effect.evidence.at(-1)).toMatchObject({ source: "provider_lookup", impliedOutcome: "succeeded" });
    expect(effect.evidence.at(-1)!.summary).toMatch(/read-back matched/);
    expect(sends()).toHaveLength(1);
    expect(s.resend.requests.map((r) => `${r.method} ${r.path}`).slice(-2)).toEqual(["POST /emails", `GET /emails/${email.id}`]);
    expect(effect.attempts.map((a) => [a.kind, a.status])).toEqual([["dispatch", "completed"]]);
    expect(JSON.stringify(effect)).not.toContain(RESEND_SIM_KEY);

    s.resend.fault("lookup", "hide_from_read");
    const unread = await s.invoke("send-receipt", s.mail(["c@example.com"], "Second receipt"));
    expect(unread).toMatchObject({ status: "succeeded", grade: "acknowledged" });
    expect((await s.effect(unread.effectId!)).evidence.at(-1)).toMatchObject({ source: "provider_lookup", impliedOutcome: null });
    expect(sends()).toHaveLength(2);
  });

  it("a provider refusal grades failed and releases its allowance", async () => {
    await s.emailAction();
    const limit = await emailLimit(10);
    s.resend.domains.get(RESEND_SIM_DOMAIN)!.status = "pending";
    const result = await s.invoke("send-receipt", s.mail(["a@example.com"]));
    expect(result).toMatchObject({ status: "failed", grade: "failed" });
    expect(await s.effect(result.effectId!)).toMatchObject({ outcome: "failed", partialEffect: "none", grade: "failed" });
    expect(s.resend.writes).toBe(0);
    expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 0, available: 10 });
  });

  describe("a lost response", () => {
    it("is unknown and holds its allowance, then reconciliation finds the email by its tag without a second send", async () => {
      await s.emailAction();
      const limit = await emailLimit(10);
      s.resend.fault("write", "lose_response_after_commit");
      const result = await s.invoke("send-receipt", s.mail(["a@example.com", "b@example.com", "c@example.com"]));
      expect(result).toMatchObject({ status: "unknown", grade: "unknown" });
      expect(s.resend.writes).toBe(1);
      expect(await s.effect(result.effectId!)).toMatchObject({ outcome: "unknown", stage: "reconciling", unresolvedExposure: true, providerReference: null });
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 3, unknownExposure: 3 });
      const blocked = await s.invoke("send-receipt", s.mail(recipients(8, "x"), "Other receipt"));
      expect(blocked.error).toMatch(/impact_limit_exceeded/);

      expect(await s.reconcileNow(result.effectId!)).toBe(true);
      const effect = await s.effect(result.effectId!);
      expect(effect).toMatchObject({
        stage: "settled", outcome: "succeeded", grade: "confirmed", verification: "provider", providerReference: s.resend.emails[0].id,
      });
      expect(effect.attempts.map((a) => a.kind)).toEqual(["dispatch", "reconcile"]);
      expect(effect.evidence.some((e) => e.source === "provider_lookup" && e.impliedOutcome === "succeeded")).toBe(true);
      expect(sends()).toHaveLength(1);
      expect(s.resend.writes).toBe(1);
      expect(s.resend.recipients()).toBe(3);
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 3, reserved: 0, unknownExposure: 0 });
    });

    it("a governed same-key replay recovers it without a second email when the lookup cannot see it", async () => {
      await s.emailAction();
      const limit = await emailLimit(10);
      s.resend.fault("write", "lose_response_after_commit");
      const result = await s.invoke("send-receipt", s.mail(["a@example.com", "b@example.com"]));
      expect(result.status).toBe("unknown");
      s.resend.fault("lookup", "hide_from_list");
      await s.reconcileNow(result.effectId!);
      expect(await s.effect(result.effectId!)).toMatchObject({ outcome: "unknown", grade: "unknown" });
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 2, unknownExposure: 2 });

      await m.effects.replayEffectOperation(s.workspaceId, s.environmentId, result.effectId!, { type: "user", id: s.userId });
      const effect = await s.effect(result.effectId!);
      expect(effect).toMatchObject({ outcome: "succeeded", providerReference: s.resend.emails[0].id });
      expect(effect.attempts.map((a) => a.kind).filter((kind) => kind !== "reconcile")).toEqual(["dispatch", "replay"]);
      expect(sends()).toHaveLength(2);
      expect(new Set(sends().map((r) => r.idempotencyKey)).size).toBe(1);
      expect(s.resend.writes).toBe(1);
      expect(s.resend.emails).toHaveLength(1);
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 2, reserved: 0, unknownExposure: 0 });
    });

    it("a write that never reached Resend stays unknown on every lookup, and nothing is sent", async () => {
      await s.emailAction();
      const limit = await emailLimit(10);
      s.resend.fault("write", "timeout_before_commit");
      const result = await s.invoke("send-receipt", s.mail(["a@example.com"]));
      expect(result.status).toBe("unknown");
      for (let i = 0; i < 3; i++) await s.reconcileNow(result.effectId!);
      expect(await s.effect(result.effectId!)).toMatchObject({ outcome: "unknown", grade: "unknown", unresolvedExposure: true });
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 1, unknownExposure: 1 });
      expect(s.resend.writes).toBe(0);
      expect(sends()).toHaveLength(1);
    });
  });
});
