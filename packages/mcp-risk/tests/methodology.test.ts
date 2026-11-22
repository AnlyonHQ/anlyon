import { describe, expect, it } from "vitest";
import { METHODOLOGY, scanTools, type McpTool } from "../src/index.ts";
import { poisonedAdd, shadowingAdd } from "./fixtures/invariant-labs.ts";
import { FIXTURES, tools } from "./helpers.ts";

const EM_DASH = new RegExp(String.fromCharCode(0x2014));

const FINDING_IDS = [
  "hidden-unicode",
  "model-directed-text",
  "sensitive-path",
  "credentials-mention",
  "tool-shadowing",
  "base64-blob",
  "long-description",
  "annotation-conflict",
  "install-script-network",
  "install-script",
  "duplicate-tool-name",
];

describe("METHODOLOGY", () => {
  it("has unique ids, each with a title and a description", () => {
    const ids = METHODOLOGY.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of METHODOLOGY) {
      expect(entry.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(entry.title.length).toBeGreaterThan(3);
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it("lists every finding check and every class rule", () => {
    const ids = METHODOLOGY.map((m) => m.id);
    for (const id of FINDING_IDS) expect(ids).toContain(id);
    for (const id of ["class-name-verb", "class-description-verb", "class-annotations", "class-default-write"]) expect(ids).toContain(id);
    for (const id of ["tag-private-data", "tag-untrusted-input", "tag-outbound", "exfil-paths"]) expect(ids).toContain(id);
  });

  it("covers every finding id the engine emits", async () => {
    const ids = new Set(METHODOLOGY.map((m) => m.id));
    const lists: McpTool[][] = [
      [poisonedAdd],
      [shadowingAdd],
      ...Object.keys(FIXTURES).map((name) => tools(name as keyof typeof FIXTURES)),
      [
        { name: "a\u200B", description: `Uses credentials. ${btoa("some hidden text encoded for this test")} ${"x".repeat(2001)}` },
        { name: "delete_x", annotations: { readOnlyHint: true } },
        { name: "delete_x" },
      ],
    ];
    const seen = new Set<string>();
    for (const list of lists) {
      for (const packageJson of [{ scripts: { postinstall: "curl x" } }, { scripts: { install: "node x" } }]) {
        const result = await scanTools(list, { packageJson });
        for (const f of [...result.serverFindings, ...result.tools.flatMap((t) => t.findings)]) {
          expect(ids.has(f.id), f.id).toBe(true);
          seen.add(f.id);
        }
      }
    }
    expect([...seen].sort()).toEqual([...FINDING_IDS].sort());
  });

  it("follows the wording rules: no verdicts, no em dashes, and the scope entry says no finding is not a guarantee", () => {
    const text = METHODOLOGY.map((m) => `${m.title} ${m.description}`).join("\n");
    expect(text).not.toMatch(EM_DASH);
    expect(text).not.toMatch(/\b(secure|verified safe|AI-audited|protected by Anlyon|malicious)\b/i);
    expect(text).not.toMatch(/\bsafe\b/i);
    expect(METHODOLOGY.find((m) => m.id === "scope")!.description).toContain("No finding is not a safety guarantee");
  });
});
