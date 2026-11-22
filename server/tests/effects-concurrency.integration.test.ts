import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { providerFetch, setProviderFetchForHost } from "./support/effects/provider-fetch.ts";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const claimGate = vi.hoisted(() => ({
  armed: null as null | { where: "before" | "after"; reached: () => void; release: Promise<void> },
}));
vi.mock("../src/core/billing/action-accounting.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/billing/action-accounting.ts")>();
  return {
    ...actual,
    reserveActionExecution: async (...args: Parameters<typeof actual.reserveActionExecution>) => {
      const gate = claimGate.armed;
      claimGate.armed = null;
      if (gate?.where === "before") { gate.reached(); await gate.release; }
      const claimed = await actual.reserveActionExecution(...args);
      if (gate?.where === "after") { gate.reached(); await gate.release; }
      return claimed;
    },
  };
});

const { EffectScope, loadEffectModules } = await import("./support/effects/fixture.ts");

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("governed effects: live request versus recovery (real Postgres)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let m: Awaited<ReturnType<typeof loadEffectModules>>;
  let accounting: typeof import("../src/core/billing/action-accounting.ts");
  let s: InstanceType<typeof EffectScope>;

  beforeAll(async () => {
    await pool.query("SELECT 1");
    m = await loadEffectModules();
    accounting = await import("../src/core/billing/action-accounting.ts");
  });
  beforeEach(async () => { s = await new EffectScope(pool, m).seed(); });
  afterEach(async () => {
    claimGate.armed = null;
    await s.cleanup();
  });
  afterAll(async () => { await pool.end(); });

  function pauseClaim(where: "before" | "after") {
    const reached = deferred();
    const release = deferred();
    claimGate.armed = { where, reached: reached.resolve, release: release.promise };
    return { reached: reached.promise, release: release.resolve };
  }

  function pauseStripe(match: (method: string, path: string) => boolean) {
    const reached = deferred();
    const release = deferred();
    let used = false;
    setProviderFetchForHost("api.stripe.com", async (url, init) => {
      const path = new URL(url).pathname;
      if (!used && match((init?.method ?? "GET").toUpperCase(), path)) {
        used = true;
        const response = await s.stripe.fetch(url, init);
        reached.resolve();
        await release.promise;
        return response;
      }
      return s.stripe.fetch(url, init);
    });
    return { reached: reached.promise, release: release.resolve };
  }

  async function expectSettledOnce(effectId: string, limitId: string, amount: number) {
    const effect = await s.effect(effectId);
    expect(effect.outcome).toBe("succeeded");
    expect(s.stripe.refunds).toHaveLength(1);
    expect(s.stripe.writes).toBe(1);
    const reservations = await pool.query(
      "SELECT r.state FROM impact_reservations r JOIN action_effects e ON e.id = r.effect_id WHERE e.effect_id = $1", [effectId],
    );
    expect(reservations.rows).toEqual([{ state: "settled" }]);
    expect(await s.limitView(limitId)).toMatchObject({ consumed: amount, reserved: 0, unknownExposure: 0 });
    expect(await accounting.getActionUsage(s.workspaceId)).toEqual({ billed: 1, reserved: 0 });
    return effect;
  }

  it("paused after admission, before the platform claim: the sweeper dispatches once, the original stands down", async () => {
    await s.refundAction();
    const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
    const gate = pauseClaim("before");
    const original = s.invoke("refund", s.refund(1500));
    await gate.reached;

    expect(await m.reconcile.resumeReadyEffects(0)).toBe(1);
    gate.release();
    const result = await original;
    expect(result.status).toBe("succeeded");
    const effect = await expectSettledOnce(result.effectId!, limit.id, 1500);
    expect(effect.attempts.map((a) => a.kind)).toEqual(["dispatch"]);
  });

  it("paused between the platform claim and the effect claim: one dispatch, whichever side takes it", async () => {
    await s.refundAction();
    const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
    const gate = pauseClaim("after");
    const original = s.invoke("refund", s.refund(1600));
    await gate.reached;
    await new Promise((r) => setTimeout(r, 5));

    expect(await m.reconcile.resumeReadyEffects(0)).toBe(1);
    gate.release();
    const result = await original;
    expect(result.status).toBe("succeeded");
    const effect = await expectSettledOnce(result.effectId!, limit.id, 1600);
    expect(effect.attempts.map((a) => a.kind)).toEqual(["dispatch"]);
  });

  it("paused mid-write: an expired dispatch lease becomes unknown, is reconciled, and the late answer changes nothing", async () => {
    await s.refundAction();
    const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
    const provider = pauseStripe((method, path) => method === "POST" && path === "/v1/refunds");
    const original = s.invoke("refund", s.refund(1700));
    await provider.reached;

    await pool.query("UPDATE effect_attempts SET lease_until = now() - interval '1 second' WHERE workspace_id = $1 AND status = 'started'", [s.workspaceId]);
    await m.reconcile.reconcileDueEffects();
    const [{ effect_id: effectId }] = (await pool.query("SELECT effect_id FROM action_effects WHERE workspace_id = $1", [s.workspaceId])).rows;
    expect((await s.effect(effectId)).outcome).toBe("unknown");
    await s.reconcileNow(effectId);
    expect((await s.effect(effectId)).outcome).toBe("succeeded");

    provider.release();
    const result = await original;
    expect(result.status).toBe("succeeded");
    const effect = await expectSettledOnce(effectId, limit.id, 1700);
    expect(effect.attempts.map((a) => [a.kind, a.status])).toEqual([["dispatch", "abandoned"], ["reconcile", "completed"]]);
    expect(effect.evidence.filter((e) => e.source === "provider_response")).toHaveLength(1);
  });

  it("a reconciliation worker whose lease expired answers late: one settlement", async () => {
    await s.refundAction();
    const limit = await s.limit({ name: "refunds", dimension: "money", currency: "usd", period: "month", amount: 10_000 });
    s.stripe.fault("write", "lose_response_after_commit");
    const result = await s.invoke("refund", s.refund(1800));
    expect(result.status).toBe("unknown");

    const lookup = pauseStripe((method, path) => method === "GET" && path === "/v1/refunds");
    const workerA = s.reconcileNow(result.effectId!);
    await lookup.reached;

    await pool.query("UPDATE action_effects SET reconcile_lease_until = now() - interval '1 second' WHERE effect_id = $1", [result.effectId]);
    await pool.query(
      "UPDATE effect_attempts SET lease_until = now() - interval '1 second' FROM action_effects e WHERE e.id = effect_attempts.effect_id AND e.effect_id = $1 AND effect_attempts.status = 'started'",
      [result.effectId],
    );
    await m.reconcile.reconcileDueEffects();
    expect((await s.effect(result.effectId!)).outcome).toBe("succeeded");

    lookup.release();
    await workerA;
    const effect = await expectSettledOnce(result.effectId!, limit.id, 1800);
    expect(effect.attempts.map((a) => [a.kind, a.status])).toEqual([
      ["dispatch", "completed"], ["reconcile", "abandoned"], ["reconcile", "completed"],
    ]);
  });
});
