import { describe, expect, it } from "vitest";
import { parseToolsList, ToolsListError } from "../src/index.ts";

const tool = { name: "get_issue", description: "Get an issue.", inputSchema: { type: "object", properties: {} } };

function error(input: unknown): ToolsListError {
  try {
    parseToolsList(input);
  } catch (e) {
    expect(e).toBeInstanceOf(ToolsListError);
    return e as ToolsListError;
  }
  throw new Error("expected parseToolsList to throw");
}

describe("parseToolsList accepts", () => {
  it("a tools/list JSON-RPC response", () => {
    expect(parseToolsList({ jsonrpc: "2.0", id: 1, result: { tools: [tool] } })).toEqual([tool]);
  });

  it("a {tools} result, ignoring nextCursor", () => {
    expect(parseToolsList({ tools: [tool], nextCursor: "abc" })).toEqual([tool]);
  });

  it("a bare array", () => {
    expect(parseToolsList([tool])).toEqual([tool]);
  });

  it("any of them as a JSON string, with surrounding whitespace", () => {
    expect(parseToolsList(`\n  ${JSON.stringify({ result: { tools: [tool] } })}  \n`)).toEqual([tool]);
    expect(parseToolsList(JSON.stringify([tool]))).toEqual([tool]);
  });

  it("an empty list", () => {
    expect(parseToolsList({ tools: [] })).toEqual([]);
  });
});

describe("parseToolsList normalises", () => {
  it("keeps only the contract's fields and the five known annotation keys", () => {
    const [parsed] = parseToolsList([
      {
        ...tool,
        title: "Get issue",
        outputSchema: { type: "object" },
        _meta: { x: 1 },
        annotations: { readOnlyHint: true, openWorldHint: false, title: "Issue", vendorHint: "x" },
      },
    ]);
    expect(parsed).toEqual({
      ...tool,
      title: "Get issue",
      annotations: { readOnlyHint: true, openWorldHint: false, title: "Issue" },
    });
  });

  it("drops null optional fields", () => {
    expect(parseToolsList([{ name: "x", description: null, inputSchema: null, annotations: { readOnlyHint: null } }])).toEqual([
      { name: "x", annotations: {} },
    ]);
  });

  it("keeps duplicate names (the scan reports them)", () => {
    expect(parseToolsList([tool, tool])).toHaveLength(2);
  });
});

describe("parseToolsList rejects, with a typed error that says where", () => {
  it("invalid JSON text", () => {
    const e = error("{ tools: [");
    expect(e.code).toBe("invalid_json");
    expect(e.message).toMatch(/not valid JSON/);
  });

  it("an empty string", () => {
    expect(error("   ").code).toBe("not_a_tools_list");
  });

  it("a JSON-RPC error response, quoting its message", () => {
    const e = error({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
    expect(e.code).toBe("jsonrpc_error");
    expect(e.message).toContain("-32601: Method not found");
  });

  it("a JSON-RPC request pasted by mistake", () => {
    expect(error({ jsonrpc: "2.0", id: 1, method: "tools/list" }).message).toMatch(/request/);
  });

  it("a response whose result has no tools", () => {
    const e = error({ jsonrpc: "2.0", id: 1, result: { resources: [] } });
    expect(e.code).toBe("not_a_tools_list");
    expect(e.path).toBe("result.tools");
  });

  it("an object without tools, a non-array tools, and a scalar", () => {
    expect(error({ servers: [] }).message).toMatch(/no "tools" array/);
    expect(error({ tools: {} }).message).toMatch(/"tools" must be an array, but it is an object/);
    expect(error(42).message).toMatch(/a number/);
    expect(error(null).message).toMatch(/null/);
  });

  it("a tool without a name", () => {
    const e = error({ tools: [tool, { description: "x" }] });
    expect(e.code).toBe("invalid_tool");
    expect(e.path).toBe("tools[1].name");
    expect(e.message).toBe("tools[1].name must be a non-empty string, and it is missing.");
  });

  it("a tool that is not an object", () => {
    expect(error(["get_issue"]).message).toMatch(/tools\[0\] must be a tool object/);
  });

  it("wrongly typed fields", () => {
    expect(error([{ name: "x", description: 3 }]).path).toBe("tools[0].description");
    expect(error([{ name: "x", inputSchema: "object" }]).message).toMatch(/must be a JSON Schema object, but it is a string/);
    expect(error([{ name: "x", annotations: [] }]).path).toBe("tools[0].annotations");
    expect(error({ result: { tools: [{ name: "x", annotations: { readOnlyHint: "true" } }] } }).message).toBe(
      "result.tools[0].annotations.readOnlyHint must be true or false, but it is a string.",
    );
  });
});
