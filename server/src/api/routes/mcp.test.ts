import { describe, expect, it } from "vitest";
import mcpRouter from "./mcp.ts";
import oauthMetadataRouter from "./oauth-metadata.ts";
import { MCP_RESOURCE_URL, OAUTH_ISSUER } from "../../utils/auth.ts";

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  mcpRouter.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

describe("unauthenticated /mcp", () => {
  it("refuses a request with no token", async () => {
    expect((await rpc(initialize)).status).toBe(401);
  });

  it("returns the WWW-Authenticate header that starts the OAuth flow", async () => {
    const response = await rpc(initialize);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata="/);
  });

  it("points that header at a document that is actually served", async () => {
    const header = (await rpc(initialize)).headers.get("www-authenticate") ?? "";
    const url = header.match(/resource_metadata="([^"]+)"/)?.[1];
    expect(url).toBeTruthy();

    const served = await oauthMetadataRouter.request(new URL(url!).pathname);
    expect(served.status).toBe(200);
    expect((await served.json()).resource).toBe(MCP_RESOURCE_URL);
  });

  it("refuses a malformed bearer", async () => {
    const response = await rpc(initialize, { Authorization: "Bearer not-a-real-token" });
    expect(response.status).toBe(401);
  });

  it("refuses a syntactically valid but unsigned JWT", async () => {
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
      JSON.stringify({ sub: "attacker", aud: MCP_RESOURCE_URL, iss: OAUTH_ISSUER }),
    ).toString("base64url")}.`;
    expect((await rpc(initialize, { Authorization: `Bearer ${unsigned}` })).status).toBe(401);
  });
});

describe("unauthenticated /mcp/<pack>", () => {
  it("starts the same OAuth flow as /mcp, for a token /mcp/<pack> accepts", async () => {
    const response = await mcpRouter.request("/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initialize),
    });
    expect(response.status).toBe(401);
    const header = response.headers.get("www-authenticate") ?? "";
    const url = header.match(/resource_metadata="([^"]+)"/)?.[1];
    const served = await oauthMetadataRouter.request(new URL(url!).pathname);
    expect((await served.json()).resource).toBe(MCP_RESOURCE_URL);
  });
});

describe("GET /mcp", () => {
  it("describes the endpoint for anyone eyeballing the deploy", async () => {
    const response = await mcpRouter.request("/");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.resource).toBe(MCP_RESOURCE_URL);
    expect(body.authorization_servers).toEqual([OAUTH_ISSUER]);
    expect(body.transport).toBe("streamable-http");
  });
});
