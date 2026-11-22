import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assistantDecision } from "../src/core/approvals/decision.ts";
import { publicModelVersion, VIGIL_MODEL_VERSIONS } from "../src/core/assistant/brand.ts";
import { adviceSummary } from "../src/core/assistant/notification-text.ts";

const UPSTREAM = /typesafe|\bjev\b|jev-/i;

describe("Anlyon Vigil branding", () => {
  it("has a public version for the pinned upstream model", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/config/env.ts"), "utf8");
    const pinned = /TYPESAFE_MODEL: z\.string\(\)\.default\("([^"]+)"\)/.exec(source)?.[1];
    expect(pinned).toBeTruthy();
    expect(VIGIL_MODEL_VERSIONS[pinned as string]).toMatch(/^vigil-/);
  });

  it("never returns the upstream model id", () => {
    expect(publicModelVersion("jev-1.13.0")).toBe("vigil-1");
    expect(publicModelVersion("jev-9.9.9")).toBe("vigil");
    expect(publicModelVersion(null)).toBeNull();
  });

  it("keeps the upstream provider out of decisions and notifications", () => {
    const decision = assistantDecision(publicModelVersion("jev-1.13.0") as string, new Date());
    expect(decision.explanation).toContain("Anlyon Vigil");
    expect(decision.explanation).not.toMatch(UPSTREAM);

    const summary = adviceSummary({ advice: { recommendation: "approve", risk: 0, confidence: 0.9, reasons: ["Risk: routine"] } });
    expect(summary?.headline).toMatch(/^Vigil suggestion \(not a decision\)/);
  });
});
