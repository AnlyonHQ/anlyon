import type { McpTool } from "./types.ts";
import { isObject } from "./schema.ts";

export interface TextSurface {
  field: string;
  label: string;
  text: string;
  kind: "prose" | "key";
}

const MAX_DEPTH = 12;
const MAX_SURFACES = 2000;

export function textSurfaces(tool: McpTool): TextSurface[] {
  const out: TextSurface[] = [{ field: "name", label: "The name", text: tool.name, kind: "key" }];
  if (tool.title !== undefined) out.push({ field: "title", label: "The title", text: tool.title, kind: "prose" });
  if (tool.annotations?.title !== undefined) {
    out.push({ field: "annotations.title", label: "The annotations title", text: tool.annotations.title, kind: "prose" });
  }
  if (tool.description !== undefined) {
    out.push({ field: "description", label: "The description", text: tool.description, kind: "prose" });
  }

  const walk = (value: unknown, path: string, depth: number) => {
    if (out.length >= MAX_SURFACES || depth > MAX_DEPTH) return;
    if (typeof value === "string") {
      const at = path || "(root)";
      out.push({ field: `inputSchema.${visible(at)}`, label: `The input schema at ${visible(at)}`, text: value, kind: "prose" });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    if (isObject(value)) {
      for (const [key, sub] of Object.entries(value)) {
        const at = path ? `${path}.${key}` : key;
        if (path === "properties" || path.endsWith(".properties")) {
          out.push({
            field: `inputSchema.${visible(at)}`,
            label: `The input schema property name "${visible(key)}"`,
            text: key,
            kind: "key",
          });
        }
        walk(sub, at, depth + 1);
      }
    }
  };
  walk(tool.inputSchema, "", 0);
  return out;
}

const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

export function codePoint(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function visible(text: string): string {
  return text.replace(INVISIBLE, (char) => `<${codePoint(char)}>`);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function excerpt(text: string, index: number, length: number, context = 40): string {
  let start = Math.max(0, index - context);
  let end = Math.min(text.length, index + length + context);
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start--;
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end++;
  const body = visible(text.slice(start, end)).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "..." : ""}${body}${end < text.length ? "..." : ""}`;
}

export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}...`;
}
