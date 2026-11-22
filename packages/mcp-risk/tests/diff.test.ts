import { describe, expect, it } from "vitest";
import { diffTools, type McpTool } from "../src/index.ts";

describe("diffTools", () => {
  const a: McpTool = { name: "a", description: "A." };
  const b: McpTool = { name: "b", description: "B.", inputSchema: { type: "object", properties: { x: { type: "string" } } } };
  const c: McpTool = { name: "c", annotations: { readOnlyHint: true } };

  it("lists added, removed and changed tools, sorted, with the fields that changed", () => {
    const after: McpTool[] = [
      { name: "d" },
      { ...b, title: "B", inputSchema: { type: "object", properties: { x: { type: "number" } } } },
      { ...c, annotations: { readOnlyHint: false } },
    ];
    expect(diffTools([a, b, c], after)).toEqual({
      added: ["d"],
      removed: ["a"],
      changed: [
        { tool: "b", fields: ["title", "inputSchema"] },
        { tool: "c", fields: ["annotations"] },
      ],
    });
  });

  it("is empty for the same tools in another order or key order", () => {
    const reordered = { inputSchema: { properties: { x: { type: "string" } }, type: "object" }, description: "B.", name: "b" };
    expect(diffTools([a, b], [reordered, a])).toEqual({ added: [], removed: [], changed: [] });
  });

  it("ignores fields outside the contract", () => {
    expect(diffTools([a], [{ ...a, outputSchema: {} } as McpTool])).toEqual({ added: [], removed: [], changed: [] });
  });

  it("shows a rename as one removed and one added", () => {
    expect(diffTools([a], [{ ...a, name: "a2" }])).toEqual({ added: ["a2"], removed: ["a"], changed: [] });
  });
});
