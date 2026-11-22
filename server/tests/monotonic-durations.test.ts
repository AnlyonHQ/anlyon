import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("action execution durations", () => {
  const source = readFileSync(new URL("../src/core/actions/execute.ts", import.meta.url), "utf8");

  it("measures elapsed time with performance.now()", () => {
    expect(source).toMatch(/const started = performance\.now\(\)/);
    expect(source.match(/Math\.round\(performance\.now\(\) - started\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("never subtracts wall-clock reads to get a duration", () => {
    expect(source).not.toMatch(/Date\.now\(\)\s*-\s*started/);
    expect(source).not.toMatch(/new Date\(\)\.getTime\(\)\s*-/);
  });

  it("stamps completion from the database clock, not the process clock", () => {
    expect(source).not.toMatch(/completedAt:\s*new Date\(\)/);
    expect(source.match(/completedAt:\s*dbUtcNow\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
