import { normaliseMcpName } from "./findings.ts";
import type { CapabilityTag, ClaudeCodePermissions, ScanResult, ToolRisk } from "./types.ts";

export type Permission = "allow" | "ask" | "deny";

const STRICTNESS: Record<Permission, number> = { allow: 0, ask: 1, deny: 2 };

export function claudeCodeToolName(serverName: string, toolName: string): string {
  return `mcp__${normaliseMcpName(serverName)}__${normaliseMcpName(toolName)}`;
}

export function toolPermission(tool: Pick<ToolRisk, "class" | "tags">): Permission {
  if (tool.class === "destructive") return "deny";
  if (tool.class !== "read") return "ask";
  return tool.tags?.some((t) => t.tag === "outbound") ? "ask" : "allow";
}

function checkName(serverName: string): string {
  if (typeof serverName !== "string" || serverName.trim().length === 0) {
    throw new TypeError("claudeCodePermissions needs the name the server is installed under, such as \"github\".");
  }
  return serverName.trim();
}

export function claudeCodePermissions(serverName: string, result: ScanResult): ClaudeCodePermissions {
  const server = checkName(serverName);
  const rules = new Map<string, Permission>();
  for (const tool of result.tools) {
    const rule = claudeCodeToolName(server, tool.tool);
    const permission = toolPermission(tool);
    const seen = rules.get(rule);
    if (seen === undefined || STRICTNESS[permission] > STRICTNESS[seen]) rules.set(rule, permission);
  }
  const allow: string[] = [];
  const ask: string[] = [];
  const deny: string[] = [];
  for (const [rule, permission] of rules) {
    (permission === "allow" ? allow : permission === "deny" ? deny : ask).push(rule);
  }
  return { permissions: { allow, ask, deny } };
}

export function permissionTags(serverName: string, result: ScanResult): Record<string, CapabilityTag[]> {
  const server = checkName(serverName);
  const out: Record<string, CapabilityTag[]> = {};
  for (const tool of result.tools) {
    if (!tool.tags?.length) continue;
    const rule = claudeCodeToolName(server, tool.tool);
    const tags = new Set([...(out[rule] ?? []), ...tool.tags.map((t) => t.tag)]);
    out[rule] = (["private-data", "untrusted-input", "outbound"] as const).filter((t) => tags.has(t));
  }
  return out;
}
