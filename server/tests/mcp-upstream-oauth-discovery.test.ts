import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerFetch, setProviderFetchForHost } from "./support/effects/provider-fetch.ts";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});
vi.mock("../src/db/index.ts", () => ({ db: {}, pool: { end: async () => {} } }));

const { discoverUpstreamOAuth, resourceCovers } = await import("../src/core/mcp-upstreams/oauth.ts");
const { McpOAuthSimulator, MCP_OAUTH_HOST, MCP_OAUTH_URL, AS_HOST, PRM_URL } = await import("./support/effects/mcp-oauth-simulator.ts");

const covers = (resource: string, endpoint: string) => resourceCovers(new URL(resource), new URL(endpoint));

describe("which resource identifies an endpoint", () => {
  it("accepts the endpoint itself and its parents on the same origin, trailing slashes aside", () => {
    expect(covers("https://mcp.example.com/mcp", "https://mcp.example.com/mcp")).toBe(true);
    expect(covers("https://mcp.example.com/mcp/", "https://mcp.example.com/mcp")).toBe(true);
    expect(covers("https://mcp.example.com/mcp", "https://mcp.example.com/mcp/")).toBe(true);
    expect(covers("https://mcp.example.com", "https://mcp.example.com/mcp")).toBe(true);
    expect(covers("https://mcp.example.com/", "https://mcp.example.com/v1/mcp")).toBe(true);
    expect(covers("https://mcp.example.com/v1", "https://mcp.example.com/v1/mcp")).toBe(true);
  });

  it("refuses a sibling path, a longer path, a prefix that is not a segment, and another origin", () => {
    expect(covers("https://mcp.example.com/other", "https://mcp.example.com/mcp")).toBe(false);
    expect(covers("https://mcp.example.com/mcp/admin", "https://mcp.example.com/mcp")).toBe(false);
    expect(covers("https://mcp.example.com/mc", "https://mcp.example.com/mcp")).toBe(false);
    expect(covers("https://other.example.com/mcp", "https://mcp.example.com/mcp")).toBe(false);
    expect(covers("https://mcp.example.com:8443/mcp", "https://mcp.example.com/mcp")).toBe(false);
    expect(covers("https://mcp.example.com/mcp?tenant=a", "https://mcp.example.com/mcp")).toBe(false);
  });
});

describe("discovery", () => {
  let sim: InstanceType<typeof McpOAuthSimulator>;
  const challenge = `Bearer resource_metadata="${PRM_URL}"`;

  beforeEach(() => {
    sim = new McpOAuthSimulator({ clientId: "c", redirectUri: "https://api.anlyon.test/callback" });
    setProviderFetchForHost(MCP_OAUTH_HOST, sim.fetch);
    setProviderFetchForHost(AS_HOST, sim.fetch);
  });

  it("accepts metadata whose resource is the endpoint", async () => {
    expect((await discoverUpstreamOAuth(MCP_OAUTH_URL, challenge)).resource).toBe(MCP_OAUTH_URL);
  });

  it("refuses a same-origin resource on a different path: resource_mismatch", async () => {
    sim.prm = { ...sim.prm, resource: `https://${MCP_OAUTH_HOST}/admin` };
    await expect(discoverUpstreamOAuth(MCP_OAUTH_URL, challenge)).rejects.toMatchObject({ reason: "resource_mismatch" });
    expect(sim.metadataReads).toEqual([PRM_URL]);
  });

  it("cuts a value taken from fetched metadata to 200 characters in its message", async () => {
    sim.prm = { ...sim.prm, resource: `https://${MCP_OAUTH_HOST}/${"a".repeat(1000)}` };
    const refused = await discoverUpstreamOAuth(MCP_OAUTH_URL, challenge).catch((error: Error) => error);
    expect(refused).toMatchObject({ reason: "resource_mismatch" });
    expect((refused as Error).message).not.toContain("a".repeat(201));
    sim.prm = { ...sim.prm, resource: MCP_OAUTH_URL };
    sim.asMetadata = { ...sim.asMetadata, issuer: `https://${"x".repeat(1000)}.example` };
    const mismatch = await discoverUpstreamOAuth(MCP_OAUTH_URL, challenge).catch((error: Error) => error);
    expect(mismatch).toMatchObject({ reason: "issuer_mismatch" });
    expect((mismatch as Error).message).not.toContain("x".repeat(201));
  });
});
