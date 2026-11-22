import { claudeCodeToolName } from "./permissions.ts";
import type { CapabilityTag, ExfilPath, ExfilReport, ExfilTool, ToolRisk } from "./types.ts";

export interface ExfilServer {
  key: string;
  tools: Pick<ToolRisk, "tool" | "tags">[];
}

const CUT_ORDER: CapabilityTag[] = ["outbound", "untrusted-input", "private-data"];

export const MAX_EXFIL_PATHS = 200;

function compare(a: ExfilTool, b: ExfilTool): number {
  return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
}

export function exfilPaths(servers: ExfilServer[], limit = MAX_EXFIL_PATHS): ExfilReport {
  const tools: Record<CapabilityTag, ExfilTool[]> = { "private-data": [], "untrusted-input": [], outbound: [] };
  const seen: Record<CapabilityTag, Set<string>> = {
    "private-data": new Set(),
    "untrusted-input": new Set(),
    outbound: new Set(),
  };
  for (const server of servers) {
    for (const tool of server.tools) {
      const rule = claudeCodeToolName(server.key, tool.tool);
      for (const { tag } of tool.tags ?? []) {
        if (seen[tag].has(rule)) continue;
        seen[tag].add(rule);
        tools[tag].push({ server: server.key, tool: tool.tool, rule });
      }
    }
  }
  for (const list of Object.values(tools)) list.sort(compare);

  const p = tools["private-data"];
  const u = tools["untrusted-input"];
  const o = tools.outbound;
  const pathCount = p.length * u.length * o.length;
  const paths: ExfilPath[] = [];
  outer: for (const privateData of p) {
    for (const untrustedInput of u) {
      for (const out of o) {
        if (paths.length >= limit) break outer;
        paths.push({ privateData, untrustedInput, outbound: out });
      }
    }
  }

  let breakWith: ExfilReport["breakWith"] = null;
  if (pathCount > 0) {
    for (const tag of CUT_ORDER) {
      if (!breakWith || tools[tag].length < breakWith.tools.length) breakWith = { tag, tools: tools[tag] };
    }
  }
  return { tools, pathCount, paths, truncated: pathCount > paths.length, breakWith };
}
