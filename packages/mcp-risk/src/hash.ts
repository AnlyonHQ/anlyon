import { normaliseTool } from "./parse.ts";
import type { McpTool } from "./types.ts";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined || typeof item === "function" ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && typeof v !== "function")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return "null";
}

export function normaliseTools(tools: McpTool[]): McpTool[] {
  const normal = tools.map((tool, i) => normaliseTool(tool, `tools[${i}]`));
  const keyed = normal.map((tool) => ({ tool, text: canonicalJson(tool) }));
  keyed.sort((a, b) => compare(a.tool.name, b.tool.name) || compare(a.text, b.text));
  return keyed.map((k) => k.tool);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashTools(tools: McpTool[]): Promise<string> {
  return sha256Hex(canonicalJson(normaliseTools(tools)));
}
