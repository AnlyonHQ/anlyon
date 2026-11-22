import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFetch, setProviderFetchForHost } from "./support/effects/provider-fetch.ts";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});
vi.mock("../src/db/index.ts", () => ({ db: {}, pool: { end: async () => {} } }));
vi.mock("../src/lib/redis.ts", () => ({ redis: {} }));

const { inspectUpstream } = await import("../src/core/mcp-upstreams/inspect.ts");
const { setConnectionProviderForTests } = await import("../src/core/connections/provider.ts");
const { McpOAuthSimulator, MCP_OAUTH_HOST, MCP_OAUTH_URL, AS_HOST, AS_ISSUER, PRM_URL } = await import("./support/effects/mcp-oauth-simulator.ts");

const SCOPE = { workspaceId: "ws-1", environmentId: "env-1" };
const CALLBACK = "https://api.anlyon.test/api/v2/connection-consent/callback";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function keyServer(status: number) {
  return async (_url: string) => json(status, { error: "unauthorized" });
}

describe("inspectUpstream", () => {
  let sim: InstanceType<typeof McpOAuthSimulator>;

  beforeEach(() => {
    sim = new McpOAuthSimulator({ clientId: "c", redirectUri: CALLBACK });
    setProviderFetchForHost(MCP_OAUTH_HOST, sim.fetch);
    setProviderFetchForHost(AS_HOST, sim.fetch);
    setConnectionProviderForTests({ redirectUri: () => CALLBACK } as never);
  });
  afterEach(() => setConnectionProviderForTests(undefined));

  it("oauth: names the sign-in server, its token host, scopes, what it advertises and the callback", async () => {
    expect(await inspectUpstream(SCOPE, MCP_OAUTH_URL)).toEqual({
      kind: "oauth",
      host: MCP_OAUTH_HOST,
      signIn: {
        issuer: AS_ISSUER,
        authorizationHost: AS_HOST,
        tokenHost: AS_HOST,
        scopesSupported: ["issues:read", "issues:write"],
        advertised: { dynamicRegistration: true, clientIdMetadataDocuments: false, pkceS256: true },
        redirectUri: CALLBACK,
      },
    });
  });

  it("oauth: the callback is null where this deployment has no connections configured, and it does not fail", async () => {
    setConnectionProviderForTests(null);
    const answer = await inspectUpstream(SCOPE, MCP_OAUTH_URL);
    expect(answer).toMatchObject({ kind: "oauth", signIn: { redirectUri: null, tokenHost: AS_HOST } });
  });

  it("open, with sign-in details: it lists without a sign-in and has metadata for calls", async () => {
    sim.listsAnonymously = true;
    const answer = await inspectUpstream(SCOPE, MCP_OAUTH_URL);
    expect(answer).toMatchObject({
      kind: "open",
      host: MCP_OAUTH_HOST,
      toolCount: 2,
      serverInfo: { name: "sim-tracker", version: "1.0.0" },
      signIn: { tokenHost: AS_HOST },
    });
  });

  it("open, without sign-in details: metadata that is absent or unusable just means none", async () => {
    sim.listsAnonymously = true;
    sim.prm = { ...sim.prm, resource: "https://elsewhere.example/mcp" };
    expect(await inspectUpstream(SCOPE, MCP_OAUTH_URL)).toMatchObject({ kind: "open", toolCount: 2, signIn: null });
  });

  it("a listing holding what Postgres refuses is refused, and a read error is stripped of it", async () => {
    const { parseListedTools } = await import("../src/core/mcp-upstreams/service.ts");
    const { McpReadError } = await import("../src/core/mcp-upstreams/client.ts");
    const tool = (description: string) => ({ name: "a", description, inputSchema: { type: "object", properties: {} } });
    expect(parseListedTools([tool("fine")])).toHaveLength(1);
    expect(() => parseListedTools([tool("a\u0000b")])).toThrow(/NUL/);
    expect(() => parseListedTools([tool("a\ud83d")])).toThrow(/NUL/);
    expect(new McpReadError("tools/list returned error 1: a\u0000b\ud83d").message).toContain("error 1: ab.");
  });

  it("a header named like a credential must carry a secret reference, whatever its spelling", async () => {
    const { isCredentialHeaderName } = await import("../src/core/mcp-upstreams/service.ts");
    for (const name of ["Authorization", "Proxy-Authorization", "X-API-Key", "api-key", "X-Auth-Token", "X-Access-Token", "X-Token", "Cookie", "X-Tracker-Token", "X-Client-Secret", "X-Password", "X-Credential", "X-ApiKey"]) {
      expect(isCredentialHeaderName(name), name).toBe(true);
    }
    for (const name of ["Accept", "Content-Type", "X-Request-Id", "User-Agent", "X-Tenant", "MCP-Protocol-Version"]) {
      expect(isCredentialHeaderName(name), name).toBe(false);
    }
  });

  it("a server that is no verified vendor's does not read as one Anlyon can bring its client to", async () => {
    sim.asMetadata = { ...sim.asMetadata, client_id_metadata_document_supported: true };
    expect(await inspectUpstream(SCOPE, MCP_OAUTH_URL)).toMatchObject({ kind: "oauth", signIn: { advertised: { clientIdMetadataDocuments: false } } });
  });

  it("credential: 401 or 403 and no OAuth metadata", async () => {
    for (const status of [401, 403]) {
      setProviderFetchForHost("keys.example", keyServer(status));
      expect(await inspectUpstream(SCOPE, "https://keys.example/mcp")).toEqual({ kind: "credential", host: "keys.example", status });
    }
  });

  it("credential: a well-known path answering with a web page is not OAuth metadata", async () => {
    setProviderFetchForHost("spa.example", async (url: string) =>
      url.includes(".well-known") ? new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }) : json(401, {}));
    expect(await inspectUpstream(SCOPE, "https://spa.example/mcp")).toMatchObject({ kind: "credential" });
  });

  it("refused: gives the reason and the message, for metadata the challenge pointed to", async () => {
    sim.prm = { ...sim.prm, resource: `https://${MCP_OAUTH_HOST}/admin` };
    expect(await inspectUpstream(SCOPE, MCP_OAUTH_URL)).toMatchObject({ kind: "refused", reason: "resource_mismatch" });
    sim.prm = { ...sim.prm, resource: MCP_OAUTH_URL };
    sim.asMetadata = { ...sim.asMetadata, code_challenge_methods_supported: [] };
    const refused = await inspectUpstream(SCOPE, MCP_OAUTH_URL);
    expect(refused).toMatchObject({ kind: "refused", reason: "pkce_unsupported" });
    expect((refused as { message: string }).message).toContain("PKCE");
  });

  it("refused: a challenge that names metadata no one can read is not mistaken for a stored credential", async () => {
    setProviderFetchForHost("broken.example", async (url: string) =>
      url.includes(".well-known")
        ? new Response("nope", { status: 500 })
        : json(401, {}, { "WWW-Authenticate": `Bearer resource_metadata="https://broken.example/.well-known/oauth-protected-resource"` }));
    expect(await inspectUpstream(SCOPE, "https://broken.example/mcp")).toMatchObject({ kind: "refused", reason: "metadata_invalid" });
  });

  it("refused: a server that lists one tool twice", async () => {
    sim.listsAnonymously = true;
    sim.tools = [sim.tools[0]!, sim.tools[0]!];
    const refused = await inspectUpstream(SCOPE, MCP_OAUTH_URL);
    expect(refused).toMatchObject({ kind: "refused", reason: "tools_invalid" });
  });

  it("unreachable: the server's failure in words, without the dispatch's wording", async () => {
    setProviderFetchForHost("down.example", async () => new Response("bad", { status: 502 }));
    const answer = await inspectUpstream(SCOPE, "https://down.example/mcp");
    expect(answer).toEqual({ kind: "unreachable", host: "down.example", message: "initialize answered HTTP 502." });
  });

  it("refuses an endpoint registration would refuse, before anything is sent", async () => {
    const calls = sim.calls.length;
    for (const url of ["http://mcp.example/mcp", "https://user:pw@mcp.example/mcp", "https://mcp.example/mcp#x", "https://{{secret:X}}.example/mcp"]) {
      await expect(inspectUpstream(SCOPE, url)).rejects.toThrow();
    }
    expect(sim.calls.length).toBe(calls);
  });

  it("only reads, and sends no credential", async () => {
    sim.listsAnonymously = true;
    await inspectUpstream(SCOPE, MCP_OAUTH_URL);
    expect(sim.calls.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(sim.calls.every((call) => call.user === null)).toBe(true);
    expect(sim.tokenRequests).toEqual([]);
    expect(PRM_URL).toContain(MCP_OAUTH_HOST);
  });
});
