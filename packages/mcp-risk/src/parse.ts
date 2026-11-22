import type { McpTool, McpToolAnnotations } from "./types.ts";

export type ToolsListErrorCode =
  | "invalid_json"
  | "jsonrpc_error"
  | "not_a_tools_list"
  | "invalid_tool";

export class ToolsListError extends Error {
  override readonly name = "ToolsListError";
  readonly code: ToolsListErrorCode;
  readonly path: string | undefined;

  constructor(code: ToolsListErrorCode, message: string, path?: string) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function optionalString(tool: Json, key: string, at: string): string | undefined {
  const value = tool[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ToolsListError("invalid_tool", `${at}.${key} must be a string, but it is ${describe(value)}.`, `${at}.${key}`);
  }
  return value;
}

export function normaliseTool(input: unknown, at: string): McpTool {
  if (!isObject(input)) {
    throw new ToolsListError("invalid_tool", `${at} must be a tool object with a "name", but it is ${describe(input)}.`, at);
  }
  const name = input.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new ToolsListError(
      "invalid_tool",
      `${at}.name must be a non-empty string${name === undefined ? ", and it is missing" : `, but it is ${describe(name)}`}.`,
      `${at}.name`,
    );
  }
  const tool: McpTool = { name };
  const title = optionalString(input, "title", at);
  if (title !== undefined) tool.title = title;
  const description = optionalString(input, "description", at);
  if (description !== undefined) tool.description = description;

  if (input.inputSchema !== undefined && input.inputSchema !== null) {
    if (!isObject(input.inputSchema)) {
      throw new ToolsListError(
        "invalid_tool",
        `${at}.inputSchema must be a JSON Schema object, but it is ${describe(input.inputSchema)}.`,
        `${at}.inputSchema`,
      );
    }
    tool.inputSchema = input.inputSchema;
  }

  if (input.annotations !== undefined && input.annotations !== null) {
    const raw = input.annotations;
    if (!isObject(raw)) {
      throw new ToolsListError(
        "invalid_tool",
        `${at}.annotations must be an object, but it is ${describe(raw)}.`,
        `${at}.annotations`,
      );
    }
    const annotations: McpToolAnnotations = {};
    for (const hint of HINTS) {
      const value = raw[hint];
      if (value === undefined || value === null) continue;
      if (typeof value !== "boolean") {
        throw new ToolsListError(
          "invalid_tool",
          `${at}.annotations.${hint} must be true or false, but it is ${describe(value)}.`,
          `${at}.annotations.${hint}`,
        );
      }
      annotations[hint] = value;
    }
    const annotationTitle = optionalString(raw, "title", `${at}.annotations`);
    if (annotationTitle !== undefined) annotations.title = annotationTitle;
    tool.annotations = annotations;
  }
  return tool;
}

function toolsArray(value: unknown[], at: string): McpTool[] {
  return value.map((tool, i) => normaliseTool(tool, `${at}[${i}]`));
}

export function parseToolsList(input: unknown): McpTool[] {
  let value = input;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length === 0) {
      throw new ToolsListError("not_a_tools_list", "The input is empty. Paste the JSON a server returns for tools/list.");
    }
    try {
      value = JSON.parse(text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ToolsListError("invalid_json", `The input is not valid JSON: ${detail}`);
    }
  }

  if (Array.isArray(value)) return toolsArray(value, "tools");

  if (isObject(value)) {
    if ("error" in value && !("result" in value)) {
      const error = value.error;
      const message = isObject(error) && typeof error.message === "string" ? error.message : "no message";
      const code = isObject(error) && typeof error.code === "number" ? ` ${error.code}` : "";
      throw new ToolsListError(
        "jsonrpc_error",
        `The input is a JSON-RPC error response (error${code}: ${message}), not a tools/list result.`,
        "error",
      );
    }
    if ("result" in value) {
      const result = value.result;
      if (isObject(result) && Array.isArray(result.tools)) return toolsArray(result.tools, "result.tools");
      throw new ToolsListError(
        "not_a_tools_list",
        `The input is a JSON-RPC response, but result.tools is ${isObject(result) ? describe(result.tools) : `missing (result is ${describe(result)})`}. Expected a tools/list result with a "tools" array.`,
        "result.tools",
      );
    }
    if (Array.isArray(value.tools)) return toolsArray(value.tools, "tools");
    if ("tools" in value) {
      throw new ToolsListError("not_a_tools_list", `"tools" must be an array, but it is ${describe(value.tools)}.`, "tools");
    }
    if ("method" in value) {
      throw new ToolsListError(
        "not_a_tools_list",
        "The input is a JSON-RPC request. Paste the server's response to tools/list instead.",
      );
    }
    throw new ToolsListError(
      "not_a_tools_list",
      'The input has no "tools" array. Expected a tools/list JSON-RPC response, a {"tools": [...]} object, or an array of tools.',
    );
  }

  throw new ToolsListError(
    "not_a_tools_list",
    `The input is ${describe(value)}. Expected a tools/list JSON-RPC response, a {"tools": [...]} object, or an array of tools.`,
  );
}
