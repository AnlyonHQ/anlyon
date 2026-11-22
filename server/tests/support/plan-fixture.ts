import { resetPlanProvider, setPlanProvider, SELF_HOSTED_LIMITS, type PlanId, type PlanLimits, type PlanProvider } from "../../src/core/plans/limits.ts";

type Overrides = {
  [K in keyof PlanLimits]?: PlanLimits[K] extends Record<string, unknown> ? Partial<PlanLimits[K]> : PlanLimits[K];
};

export interface PlanFixture {
  plans: Partial<Record<PlanId | "*", Overrides>>;
  purchasable: boolean;
  epoch: number;
  bumpEpoch(): void;
  set(plan: PlanId | "*", overrides: Overrides): void;
  provider: PlanProvider;
}

export function limitsFrom(overrides: Overrides = {}): PlanLimits {
  const out = { ...SELF_HOSTED_LIMITS } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    const base = (SELF_HOSTED_LIMITS as unknown as Record<string, unknown>)[key];
    out[key] = value && typeof value === "object" && !Array.isArray(value) && base && typeof base === "object"
      ? { ...(base as Record<string, unknown>), ...(value as Record<string, unknown>) }
      : value;
  }
  return out as unknown as PlanLimits;
}

export function usePlanFixture(plans: Partial<Record<PlanId | "*", Overrides>> = {}, options: { purchasable?: boolean } = {}): PlanFixture {
  const fixture: PlanFixture = {
    plans: { ...plans },
    purchasable: options.purchasable ?? false,
    epoch: 0,
    bumpEpoch() { fixture.epoch += 1; },
    set(plan, overrides) { fixture.plans[plan] = overrides; fixture.epoch += 1; },
    provider: {
      limits: (plan) => limitsFrom({ ...fixture.plans["*"], ...fixture.plans[plan] } as Overrides),
      purchasable: () => fixture.purchasable,
      epoch: () => fixture.epoch,
    },
  };
  resetPlanProvider();
  setPlanProvider(fixture.provider);
  return fixture;
}
