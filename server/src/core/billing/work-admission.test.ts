import { afterEach, describe, expect, it } from "vitest";
import { expensiveWorkPaused, modelCallsPaused, resetWorkAdmission, setWorkAdmission } from "./work-admission.ts";
import { assertMemoryProcessingAllowed } from "./memory-admission.ts";

afterEach(() => resetWorkAdmission());

describe("work admission", () => {
  it("pauses nothing without a registered brake", () => {
    expect(expensiveWorkPaused()).toBe(false);
    expect(modelCallsPaused()).toBe(false);
    expect(() => assertMemoryProcessingAllowed()).not.toThrow();
  });

  it("asks the registered brake every time", () => {
    const state = { work: false, models: false };
    setWorkAdmission({ expensiveWorkPaused: () => state.work, modelCallsPaused: () => state.models });
    expect(expensiveWorkPaused()).toBe(false);
    state.work = true;
    expect(expensiveWorkPaused()).toBe(true);
    state.models = true;
    expect(modelCallsPaused()).toBe(true);
    expect(() => assertMemoryProcessingAllowed()).toThrow(expect.objectContaining({ statusCode: 503, code: "EXPENSIVE_WORK_PAUSED" }));
  });

  it("is one per process", () => {
    setWorkAdmission({ expensiveWorkPaused: () => false, modelCallsPaused: () => false });
    expect(() => setWorkAdmission({ expensiveWorkPaused: () => true, modelCallsPaused: () => true })).toThrow(/already registered/);
  });
});
