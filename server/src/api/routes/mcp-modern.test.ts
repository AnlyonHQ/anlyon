import { describe, expect, it } from "vitest";
import { isModernRequest, MODERN_PROTOCOL_VERSION, serveModernMcp } from "./mcp-modern.ts";

const context = { token: "t", cacheScope: "u:c", apiBaseUrl: "http://localhost:4000", serverOptions: {} };

function request(
  method: string,
  { headers = {}, version = MODERN_PROTOCOL_VERSION, meta = true, params = {} }:
    { headers?: Record<string, string>; version?: string; meta?: boolean; params?: Record<string, unknown> } = {},
) {
  return new Request("http://localhost:4000/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "MCP-Protocol-Version": version, "Mcp-Method": method, ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method,
      params: {
        ...params,
        ...(meta
          ? { _meta: { "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientCapabilities": {} } }
          : {}),
      },
    }),
  });
}

describe("which requests are modern", () => {
  const withVersion = (version?: string) =>
    new Request("http://x/mcp", { method: "POST", headers: version ? { "MCP-Protocol-Version": version } : {} });

  it("is 2026-07-28, or a version newer than the SDK knows", () => {
    expect(isModernRequest(withVersion("2026-07-28"))).toBe(true);
    expect(isModernRequest(withVersion("2027-01-01"))).toBe(true);
  });

  it("leaves handshake-era versions, and requests with no version, to the SDK", () => {
    expect(isModernRequest(withVersion("2025-11-25"))).toBe(false);
    expect(isModernRequest(withVersion("2025-03-26"))).toBe(false);
    expect(isModernRequest(withVersion())).toBe(false);
  });
});

describe("server/discover", () => {
  it("advertises events and names every version /mcp answers", async () => {
    const response = await serveModernMcp(request("server/discover"), context);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.result.resultType).toBe("complete");
    expect(body.result.capabilities).toEqual({ tools: {}, events: {} });
    expect(body.result.supportedVersions).toEqual(expect.arrayContaining(["2026-07-28", "2025-11-25"]));
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("anlyon-mcp");
  });
});

describe("request validation", () => {
  it("answers an unknown newer version with the versions it supports", async () => {
    const response = await serveModernMcp(request("server/discover", { version: "2027-01-01" }), context);
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe(-32022);
    expect(body.error.data).toMatchObject({ requested: "2027-01-01", supported: expect.arrayContaining(["2026-07-28"]) });
  });

  it("rejects a method header that disagrees with the body", async () => {
    const response = await serveModernMcp(request("server/discover", { headers: { "Mcp-Method": "tools/list" } }), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32020);
  });

  it("rejects a tools/call whose Mcp-Name disagrees, decoding the base64 form first", async () => {
    const mismatch = await serveModernMcp(
      request("tools/call", { headers: { "Mcp-Name": "list_actions" }, params: { name: "decide_approval" } }),
      context,
    );
    expect((await mismatch.json()).error.code).toBe(-32020);

    const encoded = `=?base64?${Buffer.from("decide_approval").toString("base64")}?=`;
    const matched = await serveModernMcp(
      request("tools/call", { headers: { "Mcp-Name": encoded }, params: { name: "decide_approval" } }),
      context,
    );
    expect((await matched.clone().json()).error?.code).not.toBe(-32020);
  });

  it("requires the per-request _meta fields", async () => {
    const response = await serveModernMcp(request("server/discover", { meta: false }), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32602);
  });

  it("answers an unknown method with 404 and a JSON-RPC error", async () => {
    const response = await serveModernMcp(request("prompts/list"), context);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe(-32601);
  });
});
