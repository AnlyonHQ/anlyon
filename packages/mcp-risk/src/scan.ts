import { capabilityTags } from "./capabilities.ts";
import { classifyTool } from "./classify.ts";
import { duplicateNameFindings, installScriptFindings, toolFindings } from "./findings.ts";
import { hashTools } from "./hash.ts";
import { normaliseTool } from "./parse.ts";
import type { McpTool, RiskClass, ScanOptions, ScanResult, ToolRisk } from "./types.ts";

export async function scanTools(tools: McpTool[], opts: ScanOptions = {}): Promise<ScanResult> {
  if (!Array.isArray(tools)) {
    throw new TypeError("scanTools takes an array of tools. Use parseToolsList to read a tools/list capture first.");
  }
  const normal = tools.map((tool, i) => normaliseTool(tool, `tools[${i}]`));
  const ownNames = new Set(normal.map((tool) => tool.name.toLowerCase()));

  const counts: Record<RiskClass, number> = { read: 0, write: 0, irreversible: 0, destructive: 0 };
  const results: ToolRisk[] = normal.map((tool) => {
    const classification = classifyTool(tool);
    counts[classification.class]++;
    return {
      tool: tool.name,
      class: classification.class,
      reasons: classification.reasons,
      tags: capabilityTags(tool, classification.class),
      findings: [...toolFindings(tool, ownNames, opts.serverName), ...classification.findings],
    };
  });

  return {
    version: 1,
    tools: results,
    serverFindings: [...installScriptFindings(opts.packageJson), ...duplicateNameFindings(normal)],
    counts,
    hash: await hashTools(normal),
  };
}

export function withTags(result: ScanResult, tools: McpTool[]): ScanResult {
  if (result.tools.every((t) => Array.isArray(t.tags))) return result;
  const byName = new Map<string, McpTool>();
  tools.forEach((tool, i) => {
    const normal = normaliseTool(tool, `tools[${i}]`);
    if (!byName.has(normal.name)) byName.set(normal.name, normal);
  });
  return {
    ...result,
    tools: result.tools.map((t) => {
      if (Array.isArray(t.tags)) return t;
      const def = byName.get(t.tool);
      return { ...t, tags: def ? capabilityTags(def, t.class) : [] };
    }),
  };
}
