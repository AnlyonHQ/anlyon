import { describe, expect, it } from "vitest";
import { hashTools, scanTools, type McpTool } from "../src/index.ts";
import { FIXTURES, tools } from "./helpers.ts";

const EDGE_CASES: Record<string, McpTool[]> = {
  empty: [],
  "names nothing": [{ name: "do_the_thing" }],
  "read-only hint never lowers a delete": [
    { name: "delete_record", description: "Deletes a record.", annotations: { readOnlyHint: true } },
  ],
  "destructive hint raises a read": [{ name: "get_item", annotations: { destructiveHint: true } }],
  "money in the input": [
    {
      name: "create_payment",
      inputSchema: {
        type: "object",
        properties: { amount: { type: "integer" }, currency: { type: "string" } },
      },
    },
  ],
  "an invisible character in a description": [{ name: "list_items", description: "Lists items.\u200b" }],
};

async function entry(list: McpTool[]) {
  const result = await scanTools(list);
  return {
    hash: await hashTools(list),
    counts: result.counts,
    classes: Object.fromEntries(result.tools.map((t) => [t.tool, t.class])),
  };
}

describe("parity with the Anlyon platform", () => {
  it("gives the golden class and hash for every case", async () => {
    const golden: Record<string, Awaited<ReturnType<typeof entry>>> = {};
    for (const name of Object.keys(FIXTURES) as (keyof typeof FIXTURES)[]) {
      golden[`${name}-like`] = await entry(tools(name));
    }
    for (const [name, list] of Object.entries(EDGE_CASES)) {
      golden[name] = await entry(list);
    }
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot("./fixtures/parity.golden.json");
  });

  it("hashes as scanTools does", async () => {
    for (const list of Object.values(EDGE_CASES)) {
      expect((await scanTools(list)).hash).toBe(await hashTools(list));
    }
  });
});
