import { describe, expect, it } from "vitest";
import oauthMetadataRouter from "./oauth-metadata.ts";
import { AUTH_BASE_PATH, MCP_RESOURCE_URL, OAUTH_ISSUER } from "../../utils/auth.ts";
import { LEGACY_OAUTH_SCOPE_GROUPS } from "../../core/auth/oauth-scopes.ts";

const get = (path: string) => oauthMetadataRouter.request(path);

describe("protected-resource metadata (RFC 9728)", () => {
  it("is served where the WWW-Authenticate header points", async () => {
    expect((await get("/.well-known/oauth-protected-resource/mcp")).status).toBe(200);
  });

  it("names a resource identical to the token audience", async () => {
    const body = await (await get("/.well-known/oauth-protected-resource/mcp")).json();
    expect(body.resource).toBe(MCP_RESOURCE_URL);
  });

  it("points at the authorization server", async () => {
    const body = await (await get("/.well-known/oauth-protected-resource/mcp")).json();
    expect(body.authorization_servers).toEqual([OAUTH_ISSUER]);
  });

  it("advertises the consent groups a client may ask for", async () => {
    const body = await (await get("/.well-known/oauth-protected-resource/mcp")).json();
    expect(body.scopes_supported).toContain("anlyon:actions");
    expect(body.scopes_supported).toContain("offline_access");
  });

  it("does not advertise the legacy consent groups", async () => {
    const body = await (await get("/.well-known/oauth-protected-resource/mcp")).json();
    for (const group of LEGACY_OAUTH_SCOPE_GROUPS) expect(body.scopes_supported).not.toContain(group);
  });

  it("accepts bearer tokens in the header", async () => {
    const body = await (await get("/.well-known/oauth-protected-resource/mcp")).json();
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  it("is also served at the bare path, for clients that look there", async () => {
    expect((await get("/.well-known/oauth-protected-resource")).status).toBe(200);
  });
});

describe("authorization-server metadata (RFC 8414)", () => {
  const pathInserted = `/.well-known/oauth-authorization-server${AUTH_BASE_PATH}`;

  it("is served at the path-inserted location the spec requires", async () => {
    expect((await get(pathInserted)).status).toBe(200);
  });

  it("is also served bare and as openid-configuration", async () => {
    expect((await get("/.well-known/oauth-authorization-server")).status).toBe(200);
    expect((await get(`/.well-known/openid-configuration${AUTH_BASE_PATH}`)).status).toBe(200);
  });

  it("advertises dynamic client registration", async () => {
    const body = await (await get(pathInserted)).json();
    expect(body.registration_endpoint).toBeTruthy();
  });

  it("requires PKCE with S256", async () => {
    const body = await (await get(pathInserted)).json();
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.code_challenge_methods_supported).not.toContain("plain");
  });

  it("advertises the same scopes as the protected-resource document", async () => {
    const body = await (await get(pathInserted)).json();
    const resource = await (await get("/.well-known/oauth-protected-resource/mcp")).json();
    expect(body.scopes_supported).toEqual(resource.scopes_supported);
    for (const group of LEGACY_OAUTH_SCOPE_GROUPS) expect(body.scopes_supported).not.toContain(group);
  });

  it("supports the refresh_token grant", async () => {
    const body = await (await get(pathInserted)).json();
    expect(body.grant_types_supported).toContain("refresh_token");
  });

  it("publishes a JWKS uri, which is how /mcp verifies tokens", async () => {
    const body = await (await get(pathInserted)).json();
    expect(body.jwks_uri).toBe(`${OAUTH_ISSUER}/jwks`);
  });

  it("declares itself as the issuer the tokens will carry", async () => {
    const body = await (await get(pathInserted)).json();
    expect(body.issuer).toBe(OAUTH_ISSUER);
  });

  it("does not require clients to validate an authorization-response issuer", async () => {
    const body = await (await get(pathInserted)).json();

    expect(body.authorization_response_iss_parameter_supported).toBe(false);
  });
});
