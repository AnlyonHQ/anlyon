import { canonicalJson } from "./hash.ts";
import { normaliseTool } from "./parse.ts";
import type { McpTool, ToolsDiff } from "./types.ts";

const FIELDS = ["title", "description", "inputSchema", "annotations"] as const;

function byName(tools: McpTool[], label: string): Map<string, McpTool> {
  const map = new Map<string, McpTool>();
  tools.forEach((tool, i) => {
    const normal = normaliseTool(tool, `${label}[${i}]`);
    if (!map.has(normal.name)) map.set(normal.name, normal);
  });
  return map;
}

function sorted(list: string[]): string[] {
  return [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function diffTools(before: McpTool[], after: McpTool[]): ToolsDiff {
  const old = byName(before, "before");
  const now = byName(after, "after");
  const added = sorted([...now.keys()].filter((name) => !old.has(name)));
  const removed = sorted([...old.keys()].filter((name) => !now.has(name)));
  const changed: ToolsDiff["changed"] = [];
  for (const name of sorted([...now.keys()].filter((n) => old.has(n)))) {
    const a = old.get(name)!;
    const b = now.get(name)!;
    const fields = FIELDS.filter((field) => canonicalJson(a[field]) !== canonicalJson(b[field]));
    if (fields.length > 0) changed.push({ tool: name, fields: [...fields] });
  }
  return { added, removed, changed };
}
