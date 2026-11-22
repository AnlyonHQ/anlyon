import { excerpt, clip, codePoint, textSurfaces, visible, type TextSurface } from "./text.ts";
import type { Finding, McpTool } from "./types.ts";
import { isObject } from "./schema.ts";

const HIDDEN: Array<{ name: string; test: (cp: number) => boolean }> = [
  {
    name: "zero-width",
    test: (cp) => (cp >= 0x200b && cp <= 0x200d) || (cp >= 0x2060 && cp <= 0x2064) || cp === 0xfeff || cp === 0x180e,
  },
  {
    name: "bidirectional control",
    test: (cp) => cp === 0x200e || cp === 0x200f || cp === 0x061c || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069),
  },
  { name: "tag", test: (cp) => cp >= 0xe0000 && cp <= 0xe007f },
];

const ANY_HIDDEN = /[\u200B-\u200F\u2060-\u2064\uFEFF\u180E\u061C\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E007F}]/u;

function hiddenUnicode(tool: McpTool, surfaces: TextSurface[]): Finding[] {
  const out: Finding[] = [];
  for (const surface of surfaces) {
    if (!ANY_HIDDEN.test(surface.text)) continue;
    const found = new Map<string, Set<string>>();
    let count = 0;
    let first = -1;
    let tagText = "";
    let index = 0;
    for (const char of surface.text) {
      const cp = char.codePointAt(0)!;
      const category = HIDDEN.find((c) => c.test(cp));
      if (category) {
        count++;
        if (first === -1) first = index;
        if (!found.has(category.name)) found.set(category.name, new Set());
        found.get(category.name)!.add(codePoint(char));
        if (category.name === "tag" && cp >= 0xe0020 && cp <= 0xe007e) tagText += String.fromCharCode(cp - 0xe0000);
      }
      index += char.length;
    }
    if (count === 0) continue;
    const kinds = [...found.entries()].map(([name, points]) => {
      const list = [...points];
      return `${name} (${list.slice(0, 6).join(", ")}${list.length > 6 ? ", ..." : ""})`;
    });
    const parts = [`${surface.field}: "${excerpt(surface.text, first, 1)}"`];
    if (tagText) parts.push(`the tag characters spell "${clip(tagText, 160)}"`);
    out.push({
      id: "hidden-unicode",
      severity: "high",
      tool: tool.name,
      message: `${surface.label} contains ${count} hidden character${count === 1 ? "" : "s"}: ${joinWords(kinds)}.`,
      evidence: parts.join("; "),
    });
  }
  return out;
}

const MODEL_DIRECTED: Array<{ pattern: RegExp; gloss: string }> = [
  {
    pattern: /<\s*\/?\s*(?:important|system|instructions?|secret|hidden|admin|override)\s*>/i,
    gloss: "a tag of the kind used to mark instructions for the model",
  },
  {
    pattern:
      /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|system)\b(?:\s+(?:instructions?|prompts?|rules|messages?))?/i,
    gloss: "an instruction to set earlier instructions aside",
  },
  {
    pattern:
      /\b(?:do\s+not|don['\u2019]t|never|without)\s+(?:tell|telling|mention|mentioning|inform|informing|reveal|revealing|notify|notifying|alert|alerting|show|showing|disclose|disclosing)\b[^.!?\n]{0,80}?\buser\b/i,
    gloss: "an instruction to keep something from the user",
  },
  {
    pattern: /\b(?:do\s+not|don['\u2019]t|never)\s+(?:mention|tell|reveal|disclose)\s+(?:this|that|it|anything)\b/i,
    gloss: "an instruction to keep something from the user",
  },
  {
    pattern: /\bthe\s+user\s+(?:must|should|will)\s+(?:not|never)\s+(?:know|see|notice|be\s+told)\b/i,
    gloss: "an instruction to keep something from the user",
  },
  {
    pattern:
      /\bbefore\s+(?:using|calling|invoking|running|executing)\s+(?:this|the|any)\s+tool\b,?\s*(?:you\s+(?:must|should|need\s+to)\s+)?(?:first\s+)?(?:read|open|cat|load|access|fetch)\b/i,
    gloss: "an instruction to read something before the tool is used",
  },
];

export function modelDirectedMatches(text: string): Array<{ match: string; index: number; gloss: string }> {
  const out: Array<{ match: string; index: number; gloss: string }> = [];
  for (const { pattern, gloss } of MODEL_DIRECTED) {
    const m = pattern.exec(text);
    if (m && !out.some((o) => o.index === m.index)) out.push({ match: m[0], index: m.index, gloss });
  }
  return out.sort((a, b) => a.index - b.index);
}

function modelDirected(tool: McpTool, surfaces: TextSurface[]): Finding[] {
  const out: Finding[] = [];
  for (const surface of surfaces) {
    if (surface.kind !== "prose") continue;
    for (const m of modelDirectedMatches(surface.text)) {
      out.push({
        id: "model-directed-text",
        severity: "high",
        tool: tool.name,
        message: `${surface.label} contains "${visible(clip(m.match, 80))}", ${m.gloss}.`,
        evidence: `${surface.field}: "${excerpt(surface.text, m.index, m.match.length)}"`,
      });
    }
  }
  return out;
}

const SENSITIVE: RegExp[] = [
  /(?<![\w.])\.ssh\b/g,
  /\bid_(?:rsa|dsa|ecdsa|ed25519)\b/g,
  /(?<![\w.-])\.env(?:\.[A-Za-z0-9_-]+)?\b/g,
  /(?<![\w.])\.aws\b/g,
  /\baws_(?:secret_access_key|access_key_id|session_token)\b/gi,
  /(?<![\w.])\.git-credentials\b/g,
  /\bcredentials\.(?:json|ya?ml|toml|txt|csv|db)\b/gi,
  /[/\\]credentials\b/gi,
  /\bmcp\.json\b/g,
  /\bclaude_desktop_config\.json\b/g,
  /(?<![\w.])\.cursor[/\\]/g,
  /(?<![\w.])\.(?:netrc|npmrc|pypirc|pgpass|gnupg)\b/g,
  /(?<![\w.])\.docker[/\\]config\.json\b/g,
  /(?<![\w.])\.kube[/\\]config\b/g,
  /\/etc\/(?:passwd|shadow)\b/g,
];

const MAX_MATCHES = 50;

const MAX_TOKEN = 200;

const TOKEN_EDGE = /[\s"'`()<>[\]{},;]/;

function tokenAround(text: string, index: number, length: number): { token: string; start: number } {
  let start = index;
  let end = index + length;
  const floor = Math.max(0, index - MAX_TOKEN);
  const ceiling = Math.min(text.length, index + length + MAX_TOKEN);
  while (start > floor && !TOKEN_EDGE.test(text[start - 1]!)) start--;
  while (end < ceiling && !TOKEN_EDGE.test(text[end]!)) end++;
  return { token: text.slice(start, end).replace(/[.:]+$/, ""), start };
}

function sensitivePaths(tool: McpTool, surfaces: TextSurface[]): Finding[] {
  const out: Finding[] = [];
  for (const surface of surfaces) {
    if (surface.kind !== "prose") continue;
    const tokens: Array<{ token: string; start: number; end: number }> = [];
    let examined = 0;
    for (const pattern of SENSITIVE) {
      pattern.lastIndex = 0;
      for (const m of surface.text.matchAll(pattern)) {
        if (++examined > MAX_MATCHES) break;
        const { token, start } = tokenAround(surface.text, m.index, m[0].length);
        if (!tokens.some((t) => t.token === token)) tokens.push({ token, start, end: start + token.length });
      }
    }
    if (tokens.length > 0) {
      tokens.sort((a, b) => a.start - b.start);
      for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i]!;
        if (tokens.some((o) => o !== t && o.token.length > t.token.length && o.token.endsWith(t.token))) tokens.splice(i, 1);
      }
      const first = tokens[0]!;
      out.push({
        id: "sensitive-path",
        severity: "high",
        tool: tool.name,
        message: `${surface.label} refers to ${joinWords(tokens.slice(0, 5).map((t) => `"${visible(clip(t.token, 80))}"`))}${tokens.length > 5 ? " and more" : ""}.`,
        evidence: `${surface.field}: "${excerpt(surface.text, first.start, first.token.length)}"`,
      });
    }

    const credentials = /\bcredentials?\b/gi;
    for (const m of surface.text.matchAll(credentials)) {
      if (tokens.some((t) => m.index >= t.start && m.index < t.end)) continue;
      out.push({
        id: "credentials-mention",
        severity: "info",
        tool: tool.name,
        message: `${surface.label} mentions "${m[0]}".`,
        evidence: `${surface.field}: "${excerpt(surface.text, m.index, m[0].length)}"`,
      });
      break;
    }
  }
  return out;
}

export function normaliseMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const QUOTED = "[`'\"]([A-Za-z][\\w.-]*)[`'\"]";
const IDENTIFIER = "([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+)";
const TOOL_BEFORE = new RegExp(`(?:${QUOTED}|\\b${IDENTIFIER})\\s+tools?\\b`, "g");
const TOOL_AFTER_QUOTED = new RegExp(`\\btools?\\s+(?:(?:named|called)\\s+)?${QUOTED}`, "gi");
const TOOL_AFTER_NAMED = /\btools?\s+(?:named|called)\s+([A-Za-z][A-Za-z0-9_.-]*[A-Za-z0-9])/gi;
const MCP_PREFIXED = /\bmcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_.-]*[A-Za-z0-9])/g;
const MCP_TOOL_PREFIX = /\bmcp_tool_([A-Za-z0-9_]*[A-Za-z0-9])/g;

const SHADOW_PHRASES: RegExp[] = [
  /\b(?:other|another|different)\s+(?:mcp\s+)?servers?\b/i,
  /\b(?:all|any|every)\s+other\s+tools?\b/i,
  /\bwhen\s+this\s+tool\s+is\s+(?:available|present|installed|loaded|enabled)\b/i,
  /\b(?:overrides?|supersedes?|takes\s+precedence\s+over)\b[^.!?\n]{0,40}\btools?\b/i,
];

function shadowing(tool: McpTool, surfaces: TextSurface[], ownNames: Set<string>, serverName?: string): Finding[] {
  const out: Finding[] = [];
  const own = (name: string) => ownNames.has(name.toLowerCase());
  const self = serverName ? normaliseMcpName(serverName).toLowerCase() : null;
  const reported = new Set<string>();

  for (const surface of surfaces) {
    if (surface.kind !== "prose") continue;
    const text = surface.text;
    const report = (key: string, message: string, index: number, length: number) => {
      if (reported.has(key)) return;
      reported.add(key);
      out.push({
        id: "tool-shadowing",
        severity: "warn",
        tool: tool.name,
        message,
        evidence: `${surface.field}: "${excerpt(text, index, length)}"`,
      });
    };

    for (const m of text.matchAll(MCP_PREFIXED)) {
      const server = m[1]!;
      const name = m[2]!;
      if (self && server.toLowerCase() === self && own(name)) continue;
      const other = !self || server.toLowerCase() !== self;
      report(
        `prefixed:${server}:${name}`,
        other
          ? `${surface.label} names "${m[0]}", a tool on ${self ? "another server" : "the server"} "${server}".`
          : `${surface.label} names "${m[0]}", a tool this server does not list.`,
        m.index,
        m[0].length,
      );
    }

    const names: Array<{ name: string; index: number; length: number }> = [];
    for (const m of text.matchAll(MCP_TOOL_PREFIX)) names.push({ name: m[1]!, index: m.index, length: m[0].length });
    for (const re of [TOOL_BEFORE, TOOL_AFTER_QUOTED, TOOL_AFTER_NAMED]) {
      for (const m of text.matchAll(re)) {
        const raw = m[1] ?? m[2];
        if (!raw) continue;
        names.push({ name: raw.replace(/^mcp_tool_/, ""), index: m.index, length: m[0].length });
      }
    }
    names.sort((a, b) => a.index - b.index);
    for (const { name, index, length } of names) {
      if (name.startsWith("mcp__") || own(name) || name.toLowerCase() === tool.name.toLowerCase()) continue;
      report(`tool:${name.toLowerCase()}`, `${surface.label} names a tool "${visible(name)}" that this server does not list.`, index, length);
    }

    for (const phrase of SHADOW_PHRASES) {
      const m = phrase.exec(text);
      if (!m) continue;
      report(`phrase:${phrase.source}`, `${surface.label} contains "${visible(clip(m[0], 80))}", wording about other tools or servers.`, m.index, m[0].length);
    }
  }
  return out;
}

const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
const MAX_BASE64_FINDINGS = 3;

export function decodeBase64Text(run: string): string | null {
  const body = run.replace(/=+$/, "");
  if (body.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(body + "=".repeat((4 - (body.length % 4)) % 4));
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const chars = Array.from(text);
  const readable = chars.filter((c) => /[\p{L}\p{N}\p{P}\p{S}\s]/u.test(c)).length;
  return chars.length > 0 && readable / chars.length >= 0.9 ? text : null;
}

function base64Blobs(tool: McpTool, surfaces: TextSurface[]): Finding[] {
  const out: Finding[] = [];
  for (const surface of surfaces) {
    if (surface.kind !== "prose") continue;
    let examined = 0;
    for (const m of surface.text.matchAll(BASE64_RUN)) {
      if (out.length >= MAX_BASE64_FINDINGS) return out;
      if (++examined > MAX_MATCHES) break;
      const run = m[0];
      const looksEncoded = (/[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)) || run.endsWith("=");
      if (!looksEncoded) continue;
      const { token } = tokenAround(surface.text, m.index, run.length);
      if (token.includes("://")) continue;
      const decoded = decodeBase64Text(run);
      const directed = decoded ? modelDirectedMatches(decoded) : [];
      let message = `${surface.label} contains a ${formatNumber(run.length)}-character base64 string.`;
      if (decoded) message += ` It decodes to text: "${visible(clip(decoded.replace(/\s+/g, " ").trim(), 120))}".`;
      if (directed.length > 0) message += ` The decoded text contains "${visible(clip(directed[0]!.match, 60))}".`;
      out.push({
        id: "base64-blob",
        severity: directed.length > 0 ? "high" : "warn",
        tool: tool.name,
        message,
        evidence: `${surface.field}: "${excerpt(surface.text, m.index, Math.min(run.length, 48), 20)}"`,
      });
    }
  }
  return out;
}

export const LONG_DESCRIPTION = 2000;

function longDescription(tool: McpTool): Finding[] {
  if (tool.description === undefined) return [];
  const length = Array.from(tool.description).length;
  if (length <= LONG_DESCRIPTION) return [];
  return [
    {
      id: "long-description",
      severity: "info",
      tool: tool.name,
      message: `The description is ${formatNumber(length)} characters long, over the ${formatNumber(LONG_DESCRIPTION)} this check looks for.`,
      evidence: `description ends: "${excerpt(tool.description, tool.description.length - 1, 1, 80)}"`,
    },
  ];
}

export function toolFindings(tool: McpTool, ownNames: Set<string>, serverName?: string): Finding[] {
  const surfaces = textSurfaces(tool);
  return [
    ...hiddenUnicode(tool, surfaces),
    ...modelDirected(tool, surfaces),
    ...sensitivePaths(tool, surfaces),
    ...shadowing(tool, surfaces, ownNames, serverName),
    ...base64Blobs(tool, surfaces),
    ...longDescription(tool),
  ];
}

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"] as const;
const NETWORK = /\b(?:curl|wget|fetch)\b|https?:\/\/|\bhttps?\b/i;

export function installScriptFindings(packageJson: unknown): Finding[] {
  if (!isObject(packageJson) || !isObject(packageJson.scripts)) return [];
  const scripts = packageJson.scripts;
  const out: Finding[] = [];
  for (const name of INSTALL_SCRIPTS) {
    const script = scripts[name];
    if (typeof script !== "string") continue;
    const evidence = `scripts.${name}: "${visible(clip(script, 200))}"`;
    const network = NETWORK.exec(script);
    out.push(
      network
        ? {
            id: "install-script-network",
            severity: "high",
            message: `The package.json "${name}" script contains "${network[0]}", and npm runs it on install.`,
            evidence,
          }
        : {
            id: "install-script",
            severity: "info",
            message: `The package.json has a "${name}" script, which npm runs on install.`,
            evidence,
          },
    );
  }
  return out;
}

export function duplicateNameFindings(tools: McpTool[]): Finding[] {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  const out: Finding[] = [];
  for (const [name, count] of counts) {
    if (count < 2) continue;
    out.push({
      id: "duplicate-tool-name",
      severity: "warn",
      tool: name,
      message: `The server lists ${count} tools named "${visible(name)}".`,
      evidence: `tools/list contains "${visible(name)}" ${count} times`,
    });
  }
  return out;
}

function joinWords(list: string[]): string {
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

export function formatNumber(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
