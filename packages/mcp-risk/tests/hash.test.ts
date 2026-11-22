import { describe, expect, it } from "vitest";
import { canonicalJson, hashTools, scanTools, type McpTool } from "../src/index.ts";
import { tools } from "./helpers.ts";

describe("hash", () => {
  it("is the sha256 hex of the canonical JSON of the sorted definitions", async () => {
    expect(await hashTools([])).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
    expect((await scanTools([])).hash).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
    expect(await hashTools([{ name: "a" }])).toBe(await hashTools([{ name: "a" }]));
    expect(await hashTools([{ name: "a" }])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on tool order, key order or fields outside the contract", async () => {
    const list = tools("github");
    const reverseKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)]))
          : value;
    const reversed = [...list].reverse().map((tool) => reverseKeys(tool) as McpTool);
    expect(Object.keys(reversed[0]!)[0]).toBe("annotations");
    const extra = list.map((tool) => ({ ...tool, outputSchema: { type: "object" }, _meta: { seen: Date.now() } }) as McpTool);
    const hash = await hashTools(list);
    expect(await hashTools(reversed)).toBe(hash);
    expect(await hashTools(extra)).toBe(hash);
  });

  it("changes with any definition field, including an invisible character", async () => {
    const base: McpTool = { name: "get_x", description: "Get x.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
    const hash = await hashTools([base]);
    for (const changed of [
      { ...base, name: "get_y" },
      { ...base, title: "X" },
      { ...base, description: "Get x.\u200B" },
      { ...base, inputSchema: { type: "object", properties: {} } },
      { ...base, annotations: { readOnlyHint: false } },
    ]) {
      expect(await hashTools([changed])).not.toBe(hash);
    }
  });

  it("is a stable value for a fixed list", async () => {
    const one: McpTool = { name: "get_x", description: "Get x." };
    expect(canonicalJson([one])).toBe('[{"description":"Get x.","name":"get_x"}]');
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"e":2,"f":1}]},"b":1}');
  });
});

