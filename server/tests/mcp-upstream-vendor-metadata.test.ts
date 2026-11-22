import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://api.anlyon.test";
const REDIRECT_URI = "https://connect.anlyon.test/callback";
const CLIENT_METADATA_URL = `${ORIGIN}/api/v2/connection-consent/mcp-client.json`;

interface Capture { endpoint: string; challenge: string; documents: Record<string, Record<string, unknown>> }
const { vendors } = JSON.parse(readFileSync(new URL("./support/effects/mcp-vendor-metadata.2026-11-02.json", import.meta.url), "utf8")) as {
  vendors: Record<"linear" | "atlassian" | "notion" | "stripe" | "supabase" | "supabaseScoped" | "ghub", Capture>;
};

const network = vi.hoisted(() => ({
  posts: [] as Array<{ url: string; body: Record<string, unknown> }>,
  registration: null as null | ((body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }),
  capture: null as null | { endpoint: string; challenge: string; documents: Record<string, Record<string, unknown>> },
  puts: [] as Array<{ name: string; allowedHosts: string[] }>,
  hostChecks: [] as Array<{ names: string[]; url: string }>,
}));

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return {
    ...actual,
    safeFetch: async (url: string, init?: { method?: string; body?: string }) => {
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        if (body.method === "initialize") return json(401, { error: "unauthorized" }, { "www-authenticate": network.capture!.challenge });
        network.posts.push({ url, body });
        if (!network.registration) throw new Error(`Nothing may be posted to ${url}`);
        const answer = network.registration(body);
        return json(answer.status, answer.body);
      }
      const document = network.capture!.documents[url];
      return document ? json(200, document) : json(404, { error: "not_found" });
    },
  };
});
vi.mock("../src/db/index.ts", () => ({ db: {}, pool: { end: async () => {} } }));
vi.mock("../src/core/actions/secrets.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/actions/secrets.ts")>();
  return {
    ...actual,
    putSecret: async (_workspaceId: string, name: string, input: { allowedHosts: string[] }) => {
      network.puts.push({ name, allowedHosts: input.allowedHosts });
    },
    assertSecretsMayReachHost: async (_workspaceId: string, names: string[], url: string) => {
      network.hostChecks.push({ names, url });
    },
    loadSecretPolicies: async (_workspaceId: string, names: string[]) =>
      new Map(names.map((name) => [name, { name, allowedHosts: name === "UNBOUND" ? null : ["github.com"] }])),
  };
});
vi.mock("../src/core/connections/oauth-apps.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/connections/oauth-apps.ts")>()),
  isDeploymentClientId: (clientId: string) => clientId === "this-deployments-github-app",
}));

const { discoverUpstreamOAuth, resolveClient, resourceCovers } = await import("../src/core/mcp-upstreams/oauth.ts");
const { inspectUpstream } = await import("../src/core/mcp-upstreams/inspect.ts");
const { setConnectionProviderForTests } = await import("../src/core/connections/provider.ts");

setConnectionProviderForTests({ redirectUri: () => REDIRECT_URI, clientMetadataUrl: () => CLIENT_METADATA_URL } as never);

const scope = { workspaceId: "w", environmentId: "e" };

function use(capture: Capture) {
  network.capture = capture;
  return discoverUpstreamOAuth(capture.endpoint, capture.challenge);
}

beforeEach(() => {
  network.posts = [];
  network.puts = [];
  network.hostChecks = [];
  network.registration = null;
});

describe.each([
  ["Linear", "linear", "https://mcp.linear.app"],
  ["Atlassian", "atlassian", "https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3"],
  ["Notion", "notion", "https://mcp.notion.com"],
] as const)("%s: this deployment's own client metadata document", (_name, key, issuer) => {
  it("is read, and needs no registration at the vendor", async () => {
    const discovered = await use(vendors[key]);
    expect(discovered.issuer).toBe(issuer);
    expect(discovered.resource).toBe(vendors[key].endpoint);
    expect(discovered.advertised).toMatchObject({ clientIdMetadataDocuments: true, pkceS256: true });
    await expect(resolveClient(scope, {}, discovered, "server")).resolves.toEqual({
      clientId: CLIENT_METADATA_URL, clientSecretName: null, clientRegistration: "client_metadata_document",
    });
    expect(network.posts).toEqual([]);
  });
});

describe("a server that is not a verified vendor's, with the same metadata", () => {
  const elsewhere = "https://mcp.tenant.example/mcp";

  it("is not lent this deployment's client: with no registration endpoint, a client id is required", async () => {
    const real = await use(vendors.linear);
    const discovered = { ...real, endpoint: elsewhere, registrationEndpoint: null, advertised: { ...real.advertised, dynamicRegistration: false } };
    await expect(resolveClient(scope, {}, discovered, "server")).rejects.toMatchObject({ reason: "client_required" });
  });

  it("registers its own client where it can", async () => {
    const real = await use(vendors.linear);
    const discovered = { ...real, endpoint: elsewhere, registrationEndpoint: "https://mcp.tenant.example/register" };
    network.registration = () => ({ status: 201, body: { client_id: "tenant-client", token_endpoint_auth_method: "none", redirect_uris: [REDIRECT_URI] } });
    await expect(resolveClient(scope, {}, discovered, "server")).resolves.toMatchObject({ clientId: "tenant-client", clientRegistration: "dynamic" });
  });

  it("cannot be handed this deployment's identity by its own registration endpoint", async () => {
    const real = await use(vendors.linear);
    const discovered = { ...real, endpoint: elsewhere, registrationEndpoint: "https://mcp.tenant.example/register" };
    network.registration = () => ({ status: 201, body: { client_id: CLIENT_METADATA_URL, token_endpoint_auth_method: "none", redirect_uris: [REDIRECT_URI] } });
    await expect(resolveClient(scope, {}, discovered, "server")).rejects.toMatchObject({ reason: "dcr_failed" });
  });

  it("only a verified vendor's endpoint reads to the console as one Anlyon can bring its client to", async () => {
    network.capture = vendors.linear;
    const inspected = await inspectUpstream(scope, vendors.linear.endpoint);
    expect(inspected).toMatchObject({ kind: "oauth", signIn: { advertised: { clientIdMetadataDocuments: true } } });
    const { mayLendSharedClient } = await import("../src/core/mcp-upstreams/oauth.ts");
    expect(mayLendSharedClient({ endpoint: elsewhere, advertised: { dynamicRegistration: false, clientIdMetadataDocuments: true, pkceS256: true } })).toBe(false);
  });
});

describe("an operator's own client", () => {
  it("cannot be this deployment's own app for an integration", async () => {
    const discovered = await use(vendors.ghub);
    await expect(resolveClient(scope, { clientId: "this-deployments-github-app" }, discovered, "server")).rejects.toMatchObject({ reason: "client_not_yours" });
  });

  it("cannot have a secret that may go to any host", async () => {
    const discovered = await use(vendors.ghub);
    await expect(resolveClient(scope, { clientId: "c", clientSecret: "{{secret:UNBOUND}}" }, discovered, "server")).rejects.toMatchObject({ reason: "client_secret_unbound" });
  });
});

describe("Stripe: dynamic registration, a resource with no path", () => {
  it("sends the resource exactly as the server names it, with no slash added", async () => {
    const discovered = await use(vendors.stripe);
    expect(discovered.resource).toBe("https://mcp.stripe.com");
  });

  it("names the same resource however the endpoint was typed", async () => {
    network.capture = vendors.stripe;
    const discovered = await discoverUpstreamOAuth("https://mcp.stripe.com/", vendors.stripe.challenge);
    expect(discovered.resource).toBe("https://mcp.stripe.com");
  });

  it("asks for a public client, the only kind it takes", async () => {
    const discovered = await use(vendors.stripe);
    network.registration = () => ({ status: 201, body: { client_id: "stripe-client", token_endpoint_auth_method: "none", redirect_uris: [REDIRECT_URI] } });
    const resolved = await resolveClient(scope, { scopes: ["mcp"] }, discovered, "stripe");
    expect(network.posts).toHaveLength(1);
    expect(network.posts[0]!.url).toBe("https://access.stripe.com/mcp/oauth2/register");
    expect(network.posts[0]!.body).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: [REDIRECT_URI], scope: "mcp" });
    expect(resolved).toMatchObject({ clientId: "stripe-client", clientSecretName: null, clientRegistration: "dynamic", tokenEndpointAuthMethod: "none" });
    expect(network.puts).toEqual([]);
  });
});

describe("Supabase: dynamic registration at a server that advertises only confidential clients", () => {
  it("asks for what the server advertises, not a public client it says it does not take", async () => {
    const discovered = await use(vendors.supabase);
    network.registration = () => ({ status: 201, body: { client_id: "supabase-client", client_secret: "issued-by-the-server", redirect_uris: [REDIRECT_URI] } });
    const resolved = await resolveClient(scope, { scopes: ["projects:read"] }, discovered, "supabase");
    expect(network.posts[0]!.url).toBe("https://api.supabase.com/platform/oauth/apps/register");
    expect(network.posts[0]!.body.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(resolved).toMatchObject({ clientId: "supabase-client", clientRegistration: "dynamic", tokenEndpointAuthMethod: "client_secret_basic" });
    expect(network.puts).toEqual([{ name: resolved.clientSecretName, allowedHosts: ["api.supabase.com"] }]);
  });

  it("keeps the method the server assigned, when it assigns another", async () => {
    const discovered = await use(vendors.supabase);
    network.registration = () => ({ status: 201, body: { client_id: "c", client_secret: "s", token_endpoint_auth_method: "client_secret_post" } });
    expect(await resolveClient(scope, {}, discovered, "supabase")).toMatchObject({ tokenEndpointAuthMethod: "client_secret_post" });
  });

  it("refuses a confidential registration that issued no secret", async () => {
    const discovered = await use(vendors.supabase);
    network.registration = () => ({ status: 201, body: { client_id: "c" } });
    await expect(resolveClient(scope, {}, discovered, "supabase")).rejects.toMatchObject({ reason: "dcr_failed" });
    expect(network.puts).toEqual([]);
  });

  it("still asks for a public client where the metadata does not say", async () => {
    const discovered = { ...(await use(vendors.supabase)), tokenEndpointAuthMethods: [] };
    network.registration = () => ({ status: 201, body: { client_id: "c" } });
    await resolveClient(scope, {}, discovered, "supabase");
    expect(network.posts[0]!.body.token_endpoint_auth_method).toBe("none");
  });
});

describe("Supabase: an endpoint scoped to one project and read-only, the vendor's own advice", () => {
  const scoped = "https://mcp.supabase.com/mcp?project_ref=abcdefghijklmnopqrst&read_only=true";

  it("is accepted: the metadata names that very endpoint", async () => {
    const discovered = await use(vendors.supabaseScoped);
    expect(discovered.resource).toBe(scoped);
    expect(discovered.issuer).toBe("https://api.supabase.com");
  });

  it("inspects as an OAuth server, not a refusal", async () => {
    network.capture = vendors.supabaseScoped;
    await expect(inspectUpstream(scope, scoped)).resolves.toMatchObject({ kind: "oauth", host: "mcp.supabase.com" });
  });

  it("a resource with a query covers only that same path and query", () => {
    const covers = (resource: string, endpoint: string) => resourceCovers(new URL(resource), new URL(endpoint));
    expect(covers(scoped, scoped)).toBe(true);
    expect(covers("https://mcp.supabase.com/mcp?project_ref=other&read_only=true", scoped)).toBe(false);
    expect(covers("https://mcp.supabase.com/mcp?project_ref=abcdefghijklmnopqrst", scoped)).toBe(false);
    expect(covers(scoped, "https://mcp.supabase.com/mcp")).toBe(false);
    expect(covers("https://mcp.supabase.com/?read_only=true", "https://mcp.supabase.com/mcp?read_only=true")).toBe(false);
    expect(covers("https://mcp.supabase.com/admin?read_only=true", "https://mcp.supabase.com/mcp?read_only=true")).toBe(false);
    expect(covers("https://other.supabase.com/mcp?read_only=true", "https://mcp.supabase.com/mcp?read_only=true")).toBe(false);
    expect(covers("https://mcp.supabase.com/mcp", scoped)).toBe(true);
  });
});

describe("GitHub: neither a metadata document nor dynamic registration", () => {
  it("is read, and asks for a client id by name", async () => {
    const discovered = await use(vendors.ghub);
    expect(discovered.resource).toBe("https://api.githubcopilot.com/mcp/");
    expect(discovered.issuer).toBe("https://github.com/login/oauth");
    expect(discovered.registrationEndpoint).toBeNull();
    await expect(resolveClient(scope, {}, discovered, "gh")).rejects.toMatchObject({ reason: "client_required" });
    expect(network.posts).toEqual([]);
  });

  it("takes the operator's OAuth app, its secret checked against github.com", async () => {
    const discovered = await use(vendors.ghub);
    const resolved = await resolveClient(scope, { clientId: "Iv1.operator", clientSecret: "{{secret:GITHUB_MCP_CLIENT_SECRET}}" }, discovered, "gh");
    expect(resolved).toMatchObject({ clientId: "Iv1.operator", clientSecretName: "GITHUB_MCP_CLIENT_SECRET", clientRegistration: "pre_registered" });
    expect(network.hostChecks).toEqual([{ names: ["GITHUB_MCP_CLIENT_SECRET"], url: "https://github.com/login/oauth/access_token" }]);
  });
});

describe.each(["linear", "atlassian", "notion", "stripe", "supabase", "supabaseScoped", "ghub"] as const)("%s, as the console's first check", (key) => {
  it("inspects as an OAuth server, with PKCE S256 and no credential sent", async () => {
    network.capture = vendors[key];
    await expect(inspectUpstream(scope, vendors[key].endpoint)).resolves.toMatchObject({ kind: "oauth", signIn: { advertised: { pkceS256: true } } });
    expect(network.posts).toEqual([]);
  });
});
