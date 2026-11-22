import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/core/functions/analysis.ts";

const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, "fixtures/functions", name), "utf8");

describe.each([
  ["javascript", "js"],
  ["python", "py"],
] as const)("%s", (language, extension) => {
  it("lists the literal invoke and read calls, whatever the binding is called, and proposes the allow-list", async () => {
    const findings = await analyzeSource(language, fixture(`refund-with-checks.${extension}`));
    expect(findings).toMatchObject({ parsed: true, parseError: null, computedActionNames: [], risky: [], writesInLoop: [] });
    expect(findings.calls).toEqual([
      { kind: "read", action: "lookup-order", line: 3 },
      { kind: "invoke", action: "refund", line: extension === "js" ? 5 : 6 },
      { kind: "invoke", action: "send-email", line: extension === "js" ? 6 : 7 },
    ]);
    expect(findings.proposedAllowedActions).toEqual(["lookup-order", "refund", "send-email"]);
  });

  it("flags computed action names, writes in a loop, and network, file, environment and eval APIs", async () => {
    const findings = await analyzeSource(language, fixture(`risky.${extension}`));
    expect(findings.parsed).toBe(true);
    expect(findings.computedActionNames.map((call) => call.kind)).toEqual(["invoke", "read"]);
    expect(findings.proposedAllowedActions).toEqual(["cancel-order", "refund"]);
    expect(findings.writesInLoop.map((write) => write.action)).toEqual(["refund", "cancel-order"]);
    const categories = new Set(findings.risky.map((risk) => risk.category));
    expect(new Set(findings.risky.map((risk) => `${risk.api}:${risk.line}`)).size).toBe(findings.risky.length);
    for (const category of ["network", "file", "environment", "eval"]) {
      expect(categories, category).toContain(category);
    }
  });

  it("reports source that does not parse, with nothing proposed", async () => {
    const findings = await analyzeSource(language, extension === "js" ? "export default async function run( {" : "def run(input, anlyon:\n  pass");
    expect(findings).toMatchObject({ parsed: false, calls: [], proposedAllowedActions: [] });
    expect(findings.parseError).toBeTruthy();
  });
});

describe("what is not a binding call", () => {
  it("ignores invoke on other objects, and property names that spell a global", async () => {
    const findings = await analyzeSource("javascript", `export default async function run(input, anlyon) {
      const client = { fetch: 1 };
      await other.invoke("refund", {});
      return client.fetch;
    }`);
    expect(findings.calls).toEqual([]);
    expect(findings.risky).toEqual([]);
  });
});

describe("the paths that decide what a run may call", () => {
  it("never read a version's review or the source findings", () => {
    for (const file of ["src/core/functions/calls.ts"]) {
      const text = readFileSync(resolve(import.meta.dirname, "..", file), "utf8");
      expect(text, file).not.toMatch(/\.review\b|analysis\.ts|review\.ts|proposedAllowedActions/);
    }
  });
});
