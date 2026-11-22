import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { messageUsage, resetMessageUsage } from "./support/message-quota-fixture.ts";

const synthetic = vi.hoisted(() => ({ id: "", daily: 100 }));
const FREE_CAPS = {
  maxMonthlyMessages: 25_000,
  usagePolicy: {
    actionInvokes: { kind: "hard-cap", capUnits: 100_000 },
    messages: { kind: "hard-cap", capUnits: 25_000 },
    storage: { kind: "hard-cap", capUnits: 1024 ** 3 },
    bandwidth: { kind: "hard-cap", capUnits: 50 * 1024 ** 3 },
  },
} as const;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";

let available = false;

beforeAll(async () => {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    await probe.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.end().catch(() => {});
  }
});

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("plan quota admission (real Postgres + Redis)", () => {
  let pool: Pool;
  let envSvc: typeof import("../src/core/environments/service.ts");
  let publisher: typeof import("../src/core/messaging/publisher.ts");
  let redisLib: typeof import("../src/lib/redis.ts");
  let pricing: typeof import("../src/core/plans/limits.ts");

  let workspaceId: string;
  let environmentId: string;
  let monthlyCap: number;
  let monthKey: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    envSvc = await import("../src/core/environments/service.ts");
    publisher = await import("../src/core/messaging/publisher.ts");
    redisLib = await import("../src/lib/redis.ts");
    pricing = await import("../src/core/plans/limits.ts");
    const { limitsFrom } = await import("./support/plan-fixture.ts");
    pricing.resetPlanProvider();
    pricing.setPlanProvider({
      limits: (_plan, workspace) => {
        const limits = limitsFrom(FREE_CAPS);
        if (!workspace || !("id" in workspace) || workspace.id !== synthetic.id || !synthetic.id) return limits;
        return { ...limits, maxMessagesPerDay: synthetic.daily, maxMessageSize: 1024,
          usagePolicy: { ...limits.usagePolicy,
            messages: { kind: "hard-cap", capUnits: 1000 },
            bandwidth: { kind: "hard-cap", capUnits: 10_000 },
          } };
      },
      purchasable: () => false,
      epoch: () => 0,
    });

    const free = pricing.getPlanLimits("free");
    expect(free.maxMonthlyMessages).not.toBe("unlimited");
    monthlyCap = free.maxMonthlyMessages as number;

    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('Q', $1, 'free') RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    environmentId = (await envSvc.ensureDefaultEnvironment(workspaceId)).id;

    const now = new Date();
    monthKey = now.toISOString().slice(0, 7);
  }, 60_000);

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await redisLib.redis.del(
        redisLib.RedisKeys.workspaceCache(workspaceId),
        redisLib.RedisKeys.quotaMonthly(workspaceId, monthKey),
      );
    }
    await pool?.end().catch(() => {});
  });

  beforeEach(async () => {
    await resetMessageUsage(pool, workspaceId, monthKey);
    await pool.query("DELETE FROM messages WHERE workspace_id = $1", [workspaceId]);
    await redisLib.redis.del(redisLib.RedisKeys.quotaMonthly(workspaceId, monthKey));
  });

  const monthlyUsage = async () =>
    (await messageUsage(pool, workspaceId, monthKey)).messages;

  const setMonthlyUsage = (value: number) => resetMessageUsage(pool, workspaceId, monthKey, value);

  const publish = (extra: Record<string, unknown> = {}) =>
    publisher.publishMessage({
      workspaceId,
      environmentId,
      url: "https://example.test/hook",
      method: "POST",
      body: { n: 1 },
      ...extra,
    } as Parameters<typeof publisher.publishMessage>[0]);

  it("admits exactly the remaining messages when several publish at once", async () => {
    await publish();
    await pool.query("DELETE FROM messages WHERE workspace_id = $1", [workspaceId]);
    await setMonthlyUsage(monthlyCap - 1);

    const results = await Promise.allSettled([publish(), publish(), publish(), publish(), publish()]);
    const accepted = results.filter((r) => r.status === "fulfilled").length;
    const reasons = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    for (const reason of reasons) expect(reason).toMatch(/limit exceeded|Quota exceeded/i);

    expect(accepted).toBe(1);
    expect(await monthlyUsage()).toBe(monthlyCap);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM messages WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(rows[0].n).toBe(1);
  });

  describe("durable admission rules with synthetic plan limits", () => {

    let cache: typeof import("../src/lib/workspace-cache.ts");
    let cappedId: string;

    beforeAll(async () => {
      cache = await import("../src/lib/workspace-cache.ts");
      cappedId = (await pool.query("INSERT INTO workspaces (name, slug, plan) VALUES ('Capped', $1, 'free') RETURNING id", [`quota-${randomUUID()}`])).rows[0].id;
      synthetic.id = cappedId;
    });

    beforeEach(async () => {
      synthetic.daily = 100;
      await resetMessageUsage(pool, cappedId, monthKey);
    });

    afterAll(async () => {
      synthetic.id = "";
      await pool.query("DELETE FROM workspaces WHERE id = $1", [cappedId]);
    });

    it("refuses a message larger than the plan allows, and reserves nothing", async () => {
      const decision = await cache.reservePlanQuota(cappedId, 1, 2048);

      expect(decision.allowed).toBe(false);
      expect(decision.rejectedDimension).toBe("message_size");
      expect(await messageUsage(pool, cappedId, monthKey)).toEqual({ messages: 0, bandwidth: 0 });
      expect((await pool.query("SELECT id FROM message_quota_reservations WHERE workspace_id = $1", [cappedId])).rows).toHaveLength(0);
    });

    it("refuses the batch that would cross the daily cap, as a whole", async () => {
      synthetic.daily = 10;
      for (let i = 0; i < 9; i++) expect((await cache.reservePlanQuota(cappedId, 1, 0)).allowed).toBe(true);

      const decision = await cache.reservePlanQuota(cappedId, 2, 0);
      expect(decision.allowed).toBe(false);
      expect(decision.rejectedDimension).toBe("messages_daily");

      expect((await cache.reservePlanQuota(cappedId, 1, 0)).allowed).toBe(true);
      expect((await cache.reservePlanQuota(cappedId, 1, 0)).allowed).toBe(false);
    });

    it("counts bandwidth as size times count, and refuses on the total", async () => {
      expect((await cache.reservePlanQuota(cappedId, 1, 1000)).allowed).toBe(true);

      const refused = await cache.reservePlanQuota(cappedId, 10, 1000);
      expect(refused.allowed).toBe(false);
      expect(refused.rejectedDimension).toBe("bandwidth");

      const decision = await cache.reservePlanQuota(cappedId, 2, 1000);
      expect(decision.allowed).toBe(true);
      expect(decision.bandwidthUsage).toBe(1000);
      expect((await messageUsage(pool, cappedId, monthKey)).bandwidth).toBe(3000);
    });

    it("returns the usage the decision was made against, not the usage after it", async () => {
      await cache.reservePlanQuota(cappedId, 3, 100);

      const decision = await cache.reservePlanQuota(cappedId, 1, 100);
      expect(decision.allowed).toBe(true);
      expect(decision.monthlyUsage).toBe(3);
      expect(decision.bandwidthUsage).toBe(300);
    });

    it("releases what it reserved", async () => {
      const reservation = await cache.reservePlanQuota(cappedId, 2, 500);
      expect(reservation.allowed).toBe(true);
      expect(reservation.reservationId).toBeTruthy();
      await cache.releasePlanQuota(cappedId, 2, 500, reservation.reservationId);
      expect(await messageUsage(pool, cappedId, monthKey)).toEqual({ messages: 0, bandwidth: 0 });
      expect((await cache.reservePlanQuota(cappedId, 1, 0)).dailyUsage).toBe(0);

    });

    it("admits freely when the plan sets no caps", async () => {
      const openId = (await pool.query("INSERT INTO workspaces (name, slug, plan) VALUES ('Open', $1, 'enterprise') RETURNING id", [`quota-${randomUUID()}`])).rows[0].id;

      for (let i = 0; i < 20; i++) expect((await cache.reservePlanQuota(openId, 1, 900)).allowed).toBe(true);
      expect((await messageUsage(pool, openId, monthKey)).messages).toBe(20);
      await pool.query("DELETE FROM workspaces WHERE id = $1", [openId]);

    });
  });

  it("refuses every publish once the cap is reached", async () => {
    await setMonthlyUsage(monthlyCap);

    const results = await Promise.allSettled([publish(), publish()]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(await monthlyUsage()).toBe(monthlyCap);
  });

  it("gives the reservation back when the publish is refused after admission", async () => {
    await setMonthlyUsage(10);

    await expect(publish({ queue: "no-such-queue" })).rejects.toThrow(/not found/i);

    expect(await monthlyUsage()).toBe(10);
  });

  it("gives the reservation back when a duplicate is refused", async () => {
    await setMonthlyUsage(10);
    const contentId = `dup-${randomUUID().slice(0, 8)}`;

    await publish({ contentId });
    expect(await monthlyUsage()).toBe(11);

    await expect(publish({ contentId })).rejects.toThrow(/already exists/i);

    expect(await monthlyUsage()).toBe(11);
  });
});
