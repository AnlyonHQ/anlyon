import type { FunctionBudgetName, FunctionBudgets } from "../../db/schema/functions.ts";

export const DEFAULT_BUDGETS: FunctionBudgets = {
  maxActionCalls: 50,
  maxCpuMs: 1_000,
  maxSubrequests: 100,
  timeoutMs: 30_000,
};

export const BUDGET_CEILINGS: FunctionBudgets = {
  maxActionCalls: 500,
  maxCpuMs: 30_000,
  maxSubrequests: 1_000,
  timeoutMs: 300_000,
};

export const BUDGET_NAMES = Object.keys(DEFAULT_BUDGETS) as FunctionBudgetName[];

export function resolveBudgets(requested: Partial<FunctionBudgets> | undefined): FunctionBudgets {
  return { ...DEFAULT_BUDGETS, ...Object.fromEntries(Object.entries(requested ?? {}).filter(([, value]) => value !== undefined)) };
}
