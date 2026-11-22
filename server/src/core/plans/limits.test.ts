import { afterEach, describe, expect, it, vi } from "vitest";
import { planEnum } from "../../db/schema/workspaces.ts";
import {
  PLAN_IDS, SELF_HOSTED_LIMITS, actionCapUnits, getPlanLimits, hasPlanProvider, isFeatureAvailable, normalizePlan,
  planLimitsEpoch, resetPlanProvider, setPlanProvider, upgradesPurchasable, usageAllowance, type PlanProvider,
} from "./limits.ts";

afterEach(() => resetPlanProvider());

const capped = { ...SELF_HOSTED_LIMITS, maxActions: 5, features: { ...SELF_HOSTED_LIMITS.features, teamFeatures: false } };

describe("plan limits without a provider", () => {
  it("answer the self-hosted limits for every plan, and nothing can be bought", () => {
    expect(hasPlanProvider()).toBe(false);
    for (const plan of [...PLAN_IDS, "unknown", null, undefined]) expect(getPlanLimits(plan)).toBe(SELF_HOSTED_LIMITS);
    expect(upgradesPurchasable()).toBe(false);
    expect(planLimitsEpoch()).toBe(0);
  });

  it("cap nothing", () => {
    expect(SELF_HOSTED_LIMITS.maxSeats).toBe("unlimited");
    for (const policy of Object.values(SELF_HOSTED_LIMITS.usagePolicy)) expect(policy.kind).toBe("unlimited");
    expect(SELF_HOSTED_LIMITS.auditRetentionMonths).toBe("unlimited");
    expect(SELF_HOSTED_LIMITS.functionRuns.concurrentRuns).toBe("unlimited");
  });
});

describe("a registered plan provider", () => {
  it("answers every question, with the plan normalised and the workspace passed through", () => {
    const limits = vi.fn<PlanProvider["limits"]>(() => capped);
    setPlanProvider({ limits, purchasable: () => true, epoch: () => 7 });
    const workspace = { createdAt: new Date("2026-01-01T00:00:00Z") };
    expect(getPlanLimits("growth", workspace)).toBe(capped);
    expect(limits).toHaveBeenCalledWith("growth", workspace);
    expect(isFeatureAvailable("growth", "teamFeatures")).toBe(false);
    expect(upgradesPurchasable()).toBe(true);
    expect(planLimitsEpoch()).toBe(7);
  });

  it("is one per process", () => {
    const provider: PlanProvider = { limits: () => capped, purchasable: () => false, epoch: () => 0 };
    setPlanProvider(provider);
    setPlanProvider(provider);
    expect(() => setPlanProvider({ ...provider })).toThrow(/already registered/);
  });
});

describe("plan ids", () => {
  it("are the database enum's values", () => {
    expect([...PLAN_IDS].sort()).toEqual([...planEnum.enumValues].sort());
  });

  it("fail closed to free for an unknown value, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(normalizePlan("growth")).toBe("growth");
      expect(normalizePlan("constructor")).toBe("free");
      expect(normalizePlan("constructor")).toBe("free");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("usage policies", () => {
  it("cap actions at the allowance, its grace, or not at all", () => {
    expect(actionCapUnits({ kind: "hard-cap", capUnits: 10 }, 5)).toBe(15);
    expect(actionCapUnits({ kind: "included-with-grace", includedUnits: 10, graceCapUnits: 11 })).toBe(11);
    expect(actionCapUnits({ kind: "payment-required" })).toBe(0);
    expect(actionCapUnits({ kind: "unlimited" })).toBeNull();
    expect(usageAllowance({ kind: "unlimited" }, 3)).toEqual({ includedUnits: null, graceCapUnits: null, usedUnits: 3, overageUnits: 0, projectedOverageCents: 0 });
  });
});
