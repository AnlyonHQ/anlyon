import { parseToolsList, scanTools, type McpTool, type ScanResult } from "../src/index.ts";
import github from "./fixtures/github-like.json";
import filesystem from "./fixtures/filesystem-like.json";
import stripe from "./fixtures/stripe-like.json";
import slack from "./fixtures/slack-like.json";

export const FIXTURES = { github, filesystem, stripe, slack } as const;

export function tools(name: keyof typeof FIXTURES): McpTool[] {
  return parseToolsList(FIXTURES[name]);
}

export function classes(result: ScanResult): Record<string, string> {
  return Object.fromEntries(result.tools.map((t) => [t.tool, t.class]));
}

export async function one(tool: McpTool, opts?: Parameters<typeof scanTools>[1]) {
  const result = await scanTools([tool], opts);
  return result.tools[0]!;
}

export async function ids(tool: McpTool, opts?: Parameters<typeof scanTools>[1]): Promise<string[]> {
  return (await one(tool, opts)).findings.map((f) => f.id);
}
