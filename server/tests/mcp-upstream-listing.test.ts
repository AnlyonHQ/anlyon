import { describe, expect, it } from "vitest";
import { MAX_LISTING_BYTES, MAX_TOOLS, McpReadError, McpSession, sessionIdOf } from "../src/core/mcp-upstreams/client.ts";
import type { ProviderRequest, ProviderResponse, ProviderTransport } from "../src/core/effects/transport.ts";

const URL_ = "https://mcp.example/mcp";
const json = (message: unknown): ProviderResponse => ({
  status: 200, bodyText: JSON.stringify(message), json: message, truncated: false, headers: { "content-type": "application/json" },
});

function listing(pages: unknown[][]): { session: McpSession; sent: string[] } {
  const sent: string[] = [];
  const transport: ProviderTransport = {
    async request(req: ProviderRequest) {
      const body = JSON.parse(req.body ?? "{}") as { id?: number; method: string; params?: { cursor?: string } };
      sent.push(body.method);
      if (body.method === "initialize") {
        return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
      }
      if (body.method === "notifications/initialized") return { status: 202, bodyText: "", json: null, truncated: false, headers: {} };
      const index = body.params?.cursor ? Number(body.params.cursor) : 0;
      const next = index + 1 < pages.length ? { nextCursor: String(index + 1) } : {};
      return json({ jsonrpc: "2.0", id: body.id, result: { tools: pages[index] ?? [], ...next } });
    },
  };
  return { session: new McpSession(transport, URL_, {}), sent };
}

const tool = (name: string, size = 0) => ({ name, description: "x".repeat(size), inputSchema: { type: "object", properties: {} } });

describe("the bounds of a listing", () => {
  it("lists every page, one element at a time", async () => {
    const { session, sent } = listing([[tool("a"), tool("b")], [tool("c")]]);
    await session.initialize();
    expect((await session.listTools()).map((t) => (t as { name: string }).name)).toEqual(["a", "b", "c"]);
    expect(sent).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
  });

  it("refuses a listing larger than MAX_LISTING_BYTES, across pages, before keeping the page that crosses it", async () => {
    const half = Math.ceil(MAX_LISTING_BYTES / 2);
    const { session } = listing([[tool("a", half)], [tool("b", half)]]);
    await session.initialize();
    await expect(session.listTools()).rejects.toThrow(McpReadError);
    await expect(session.listTools()).rejects.toThrow(new RegExp(`larger than ${MAX_LISTING_BYTES} bytes`));
  });

  it("refuses a server that lists more than MAX_TOOLS tools, and reads a long page without spreading it", async () => {
    const page = Array.from({ length: MAX_TOOLS + 1 }, (_, i) => tool(`t${i}`));
    const { session } = listing([page]);
    await session.initialize();
    await expect(session.listTools()).rejects.toThrow(new RegExp(`more than ${MAX_TOOLS} tools`));
  });
});

describe("the session id a server issues", () => {
  it("keeps visible ASCII and nothing else", () => {
    expect(sessionIdOf(undefined)).toBeNull();
    expect(sessionIdOf("sess-1")).toBe("sess-1");
    expect(sessionIdOf("1868a90c-1a2b-4c3d-8e9f-0a1b2c3d4e5f")).toBe("1868a90c-1a2b-4c3d-8e9f-0a1b2c3d4e5f");
    for (const bad of ["", "with space", "tab\there", "séss", "x".repeat(501), "{{secret:TOKEN}}", "a{{b", "a}}b", "cr\r\nlf"]) {
      expect(() => sessionIdOf(bad)).toThrow(McpReadError);
    }
  });
});
