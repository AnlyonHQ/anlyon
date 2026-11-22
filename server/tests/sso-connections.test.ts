import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));
const safeFetch = vi.hoisted(() => vi.fn());
const registerSSOProvider = vi.hoisted(() => vi.fn());
const audit = vi.hoisted(() => vi.fn());
const edition = vi.hoisted(() => ({ sso: true }));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client) };
});
const memory = vi.hoisted(() => new Map<string, string>());
vi.mock("../src/lib/redis.ts", () => ({
  redis: {
    get: async (key: string) => memory.get(key) ?? null,
    setex: async (key: string, _ttl: number, value: string) => void memory.set(key, value),
    del: async (key: string) => (memory.delete(key) ? 1 : 0),
  },
  RedisKeys: {},
}));
vi.mock("../src/lib/safe-http.ts", () => ({ safeFetch }));
vi.mock("../src/utils/auth.ts", () => ({
  auth: { api: { registerSSOProvider } },
  OAUTH_ISSUER: "http://localhost:4000/api/auth",
  MCP_RESOURCE_URL: "http://localhost:4000/mcp",
}));
vi.mock("../src/core/workspace/membership-audit.ts", () => ({ logMembershipEvent: audit }));
vi.mock("../src/core/edition/features.ts", () => ({ isFeatureEnabled: (feature: string) => feature !== "sso" || edition.sso }));

const sso = await import("../src/core/sso/service.ts");
const sessions = await import("../src/core/sso/sessions.ts");
const { provisionSsoUser, ssoLinkRefusal, ssoSignupRefusal, SSO_DOMAIN_REFUSED_MESSAGE } = await import("../src/core/sso/provisioning.ts");
const oauthTokens = await import("../src/core/auth/oauth-tokens.ts");
const { discoverOidcEndpoints } = await import("../src/core/sso/oidc-discovery.ts");

const ws = "00000000-0000-4000-8000-0000000a5101";
const other = "00000000-0000-4000-8000-0000000a5102";
const owner = "user_owner_sso";
const admin = "user_admin_sso";
const member = "user_member_sso";
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  state.client!.query<T>(text, params).then((r) => r.rows);

const OKTA_ISSUER = "https://acme.okta.com";
const oktaDiscovery = {
  issuer: OKTA_ISSUER,
  authorization_endpoint: `${OKTA_ISSUER}/oauth2/v1/authorize`,
  token_endpoint: `${OKTA_ISSUER}/oauth2/v1/token`,
  userinfo_endpoint: `${OKTA_ISSUER}/oauth2/v1/userinfo`,
  jwks_uri: `${OKTA_ISSUER}/oauth2/v1/keys`,
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "private_key_jwt"],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function addUser(id: string, email: string, workspaceId?: string, role?: string, emergencyAccess = false) {
  await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $1, $2, true, now(), now())`, [id, email]);
  if (workspaceId) {
    await sql("INSERT INTO workspace_members (workspace_id, user_id, role, emergency_access) VALUES ($1, $2, $3, $4)", [workspaceId, id, role, emergencyAccess]);
  }
}
async function addSession(id: string, userId: string, providerId?: string) {
  await sql(`INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES ($1, now() + interval '1 day', $1, now(), now(), $2)`, [id, userId]);
  if (providerId) await sql("INSERT INTO sso_sessions (session_id, provider_id) VALUES ($1, $2)", [id, providerId]);
}
const isMember = async (userId: string) =>
  (await sql("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [ws, userId])).length > 0;

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Acme', 'acme-sso'), ($2, 'Other', 'other-sso')", [ws, other]);
  await addUser(owner, "owner@acme.com", ws, "admin", true);
  await addUser(admin, "admin@acme.com", ws, "admin");
  await addUser(member, "member@acme.com", ws, "member");
  registerSSOProvider.mockImplementation(async ({ body }: { body: Record<string, unknown> }) => {
    await sql("INSERT INTO sso_provider (id, issuer, provider_id, domain, user_id, oidc_config, saml_config, domain_verified) VALUES ($1, $2, $3, $4, $5, $6, $7, false)", [
      `row-${body.providerId}`,
      body.issuer,
      body.providerId,
      body.domain,
      admin,
      body.oidcConfig ? JSON.stringify(body.oidcConfig) : null,
      body.samlConfig ? JSON.stringify(body.samlConfig) : null,
    ]);
    return {};
  });
}, 120_000);

describe("OIDC discovery against a mocked identity provider", () => {
  it("reads the endpoints and prefers client_secret_basic", async () => {
    safeFetch.mockResolvedValueOnce(json(oktaDiscovery));
    const found = await discoverOidcEndpoints(`${OKTA_ISSUER}/`);
    expect(safeFetch).toHaveBeenCalledWith(`${OKTA_ISSUER}/.well-known/openid-configuration`, expect.anything());
    expect(found).toMatchObject({
      issuer: OKTA_ISSUER,
      tokenEndpoint: oktaDiscovery.token_endpoint,
      jwksEndpoint: oktaDiscovery.jwks_uri,
      tokenEndpointAuthentication: "client_secret_basic",
    });
  });

  it("refuses an issuer mismatch, a plain-http endpoint, an http issuer and an unreachable host", async () => {
    safeFetch.mockResolvedValueOnce(json({ ...oktaDiscovery, issuer: "https://evil.example" }));
    await expect(discoverOidcEndpoints(OKTA_ISSUER)).rejects.toThrow(/names issuer/);
    safeFetch.mockResolvedValueOnce(json({ ...oktaDiscovery, token_endpoint: "http://acme.okta.com/token" }));
    await expect(discoverOidcEndpoints(OKTA_ISSUER)).rejects.toThrow(/https/);
    await expect(discoverOidcEndpoints("http://acme.okta.com")).rejects.toThrow(/https/);
    safeFetch.mockRejectedValueOnce(new Error("SSRF blocked"));
    await expect(discoverOidcEndpoints(OKTA_ISSUER)).rejects.toThrow(/Could not fetch/);
    safeFetch.mockResolvedValueOnce(json({}, 404));
    await expect(discoverOidcEndpoints(OKTA_ISSUER)).rejects.toThrow(/404/);
  });

  it("uses client_secret_post when the provider offers only that", async () => {
    safeFetch.mockResolvedValueOnce(json({ ...oktaDiscovery, token_endpoint_auth_methods_supported: ["client_secret_post"] }));
    expect((await discoverOidcEndpoints(OKTA_ISSUER)).tokenEndpointAuthentication).toBe("client_secret_post");
  });
});

describe("a workspace's identity provider", () => {
  let providerId = "";

  it("registers an OIDC provider through the plugin with explicit, discovered endpoints", async () => {
    safeFetch.mockResolvedValueOnce(json(oktaDiscovery));
    const view = await sso.createSsoConnection(ws, admin, new Headers(), {
      protocol: "oidc",
      domains: ["Acme.com", "acme.io."],
      defaultRole: "member",
      oidc: { issuer: OKTA_ISSUER, clientId: "client-id", clientSecret: "<your-client-secret>" },
    });
    providerId = view.providerId;
    const { body } = registerSSOProvider.mock.calls[0][0];
    expect(body).toMatchObject({
      issuer: OKTA_ISSUER,
      domain: "acme.com,acme.io",
      oidcConfig: { skipDiscovery: true, pkce: true, tokenEndpoint: oktaDiscovery.token_endpoint, jwksEndpoint: oktaDiscovery.jwks_uri },
    });
    expect(view).toMatchObject({ protocol: "oidc", domains: ["acme.com", "acme.io"], domainsVerified: false, enforced: false });
    expect(view.serviceProvider.oidcRedirectUri).toMatch(new RegExp(`/api/auth/sso/callback/${providerId}$`));
    expect(view.verificationRecords[0]).toMatchObject({ name: "_anlyon-sso.acme.com", type: "TXT" });
    expect(JSON.stringify(view)).not.toContain("<your-client-secret>");
    expect(await sql("SELECT organization_id FROM sso_provider WHERE provider_id = $1", [providerId])).toEqual([{ organization_id: ws }]);
    expect(audit).toHaveBeenCalledWith("sso.connection_created", expect.objectContaining({ workspaceId: ws }));
  });

  it("refuses a second provider; an unverified claim by another workspace does not reserve the domain", async () => {
    await expect(
      sso.createSsoConnection(ws, admin, new Headers(), { protocol: "oidc", domains: ["x.com"], defaultRole: "member", oidc: { issuer: OKTA_ISSUER, clientId: "a", clientSecret: "b" } }),
    ).rejects.toThrow(/already has an identity provider/);
    const squat = await sso.createSsoConnection(other, admin, new Headers(), {
      protocol: "saml",
      domains: ["acme.com"],
      defaultRole: "member",
      saml: { entityId: "https://idp.example/entity", ssoUrl: "https://idp.example/sso", certificate: "MIIC-placeholder-certificate" },
    });
    expect(squat.domainsVerified).toBe(false);
  });

  it("does not let anyone sign in until every domain publishes the TXT record", async () => {
    const view = await sso.getSsoConnection(ws);
    const record = view!.verificationRecords[0].value;
    const onlyFirst = async (name: string) => (name === "_anlyon-sso.acme.com" ? [[record]] : []);
    await expect(sso.verifySsoDomains(ws, admin, onlyFirst)).rejects.toMatchObject({ code: "DOMAIN_NOT_VERIFIED", details: { domains: ["acme.io"] } });
    expect(await sql("SELECT domain_verified FROM sso_provider WHERE provider_id = $1", [providerId])).toEqual([{ domain_verified: false }]);

    const both = async () => [["unrelated"], [record]];
    const verified = await sso.verifySsoDomains(ws, admin, both);
    expect(verified.domainsVerified).toBe(true);
    expect(await sql("SELECT domain_verified FROM sso_provider WHERE provider_id = $1", [providerId])).toEqual([{ domain_verified: true }]);

    expect(await sso.getSsoConnection(other)).toBeNull();
    await expect(
      sso.createSsoConnection(other, admin, new Headers(), {
        protocol: "saml",
        domains: ["acme.com"],
        defaultRole: "member",
        saml: { entityId: "https://idp.example/entity", ssoUrl: "https://idp.example/sso", certificate: "MIIC-placeholder-certificate" },
      }),
    ).rejects.toThrow(/Another workspace/);
  });

  it("re-checks a claim under the domain lock: a verification that lands mid-registration wins", async () => {
    const third = "00000000-0000-4000-8000-0000000a5103";
    await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Third', 'third-sso')", [third]);
    registerSSOProvider.mockImplementationOnce(async ({ body }: { body: Record<string, unknown> }) => {
      await sql("INSERT INTO sso_provider (id, issuer, provider_id, domain, user_id, domain_verified) VALUES ($1, 'https://idp.example/entity', $2, 'racing.com', $3, false)", [`row-${body.providerId}`, body.providerId, admin]);
      await sql("INSERT INTO sso_provider (id, issuer, provider_id, domain, user_id, domain_verified) VALUES ('row-third', 'https://idp.third', 'third-provider', 'racing.com', $1, true)", [admin]);
      await sql(
        `INSERT INTO workspace_sso_connections (workspace_id, provider_id, protocol, domains, domain_verification_token, domains_verified_at)
         VALUES ($1, 'third-provider', 'oidc', '["racing.com"]', 'token', now())`,
        [third],
      );
      return {};
    });
    await expect(
      sso.createSsoConnection(other, admin, new Headers(), {
        protocol: "saml",
        domains: ["racing.com"],
        defaultRole: "member",
        saml: { entityId: "https://idp.example/entity", ssoUrl: "https://idp.example/sso", certificate: "MIIC-placeholder-certificate" },
      }),
    ).rejects.toThrow(/Another workspace already uses single sign-on for racing.com/);
    expect(await sso.getSsoConnection(other)).toBeNull();
    expect(await sql("SELECT provider_id FROM sso_provider WHERE domain = 'racing.com'")).toEqual([{ provider_id: "third-provider" }]);
  });

  it("adds a first-time SSO user on a verified domain as a member, and no one else", async () => {
    await addUser("user_new_sso", "new@acme.io");
    await addUser("user_gmail_sso", "someone@gmail.com");
    await provisionSsoUser({ user: { id: "user_new_sso", email: "new@acme.io" }, provider: { providerId } });
    await provisionSsoUser({ user: { id: "user_gmail_sso", email: "someone@gmail.com" }, provider: { providerId } });
    expect(await isMember("user_new_sso")).toBe(true);
    expect(await isMember("user_gmail_sso")).toBe(false);
    expect(audit).toHaveBeenCalledWith("member.provisioned", expect.objectContaining({ userId: "user_new_sso", source: "sso", role: "member" }));
  });

  it("links an SSO identity to an existing account only on the exact verified domain", async () => {
    await addUser("user_subdomain", "cto@mail.acme.com");
    await addUser("user_exact", "cfo@acme.com");
    const ctx = { path: `/sso/callback/${providerId}`, params: { providerId } };
    expect(await ssoLinkRefusal({ userId: "user_subdomain", providerId }, ctx)).toBe(SSO_DOMAIN_REFUSED_MESSAGE);
    expect(await ssoLinkRefusal({ userId: "user_exact", providerId }, ctx)).toBeNull();
    expect(await ssoLinkRefusal({ userId: "user_subdomain", providerId }, { path: "/sign-in/email" })).toBeNull();
    expect(await ssoLinkRefusal({ userId: "user_exact", providerId: "anlyon-unknown" }, { path: "/sso/callback/anlyon-unknown", params: { providerId: "anlyon-unknown" } })).toBe(SSO_DOMAIN_REFUSED_MESSAGE);
  });

  it("leaves membership to the directory when SCIM is connected", async () => {
    await addUser("user_scim_only", "late@acme.com");
    await sql("INSERT INTO workspace_scim_configs (workspace_id, token_hash, token_prefix) VALUES ($1, 'h-sso', 'anlyon_scim_x')", [ws]);
    await provisionSsoUser({ user: { id: "user_scim_only", email: "late@acme.com" }, provider: { providerId } });
    expect(await isMember("user_scim_only")).toBe(false);
    await sql("DELETE FROM workspace_scim_configs WHERE workspace_id = $1", [ws]);
  });

  describe("enforced", () => {
    it("ends no session when switched on, and refuses a member's non-SSO session at this workspace only", async () => {
      await addSession("s-member-password", member);
      await addSession("s-member-sso", member, providerId);
      await addSession("s-owner-password", owner);
      await sql("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [other, member]);
      await sso.updateSsoConnection(ws, owner, { enforced: true });
      const left = (await sql<{ id: string }>("SELECT id FROM session ORDER BY id")).map((r) => r.id);
      expect(left).toEqual(["s-member-password", "s-member-sso", "s-owner-password"]);
      await expect(sessions.assertSsoSessionForWorkspace(ws, member, "s-member-password")).rejects.toMatchObject({ code: "SSO_REQUIRED" });
      await expect(sessions.assertSsoSessionForWorkspace(other, member, "s-member-password")).resolves.toBeUndefined();
    });

    it("stops enforcing when the edition no longer includes SSO", async () => {
      edition.sso = false;
      try {
        await expect(sessions.beforeSessionCreate({ userId: member }, { path: "/sign-in/email" })).resolves.toBeUndefined();
        await expect(sessions.assertSsoSessionForWorkspace(ws, member, "s-member-password")).resolves.toBeUndefined();
      } finally {
        edition.sso = true;
      }
      await expect(sessions.assertSsoSessionForWorkspace(ws, member, "s-member-password")).rejects.toMatchObject({ code: "SSO_REQUIRED" });
    });

    it("refuses a password or social sign-in by a member or an admin, not by an emergency-access admin", async () => {
      for (const path of ["/sign-in/email", "/callback/:id", "/one-tap/callback", "/two-factor/verify-totp"]) {
        await expect(sessions.beforeSessionCreate({ userId: member }, { path })).rejects.toMatchObject({ body: { code: "SSO_REQUIRED" } });
        await expect(sessions.beforeSessionCreate({ userId: admin }, { path })).rejects.toMatchObject({ body: { code: "SSO_REQUIRED" } });
      }
      for (const path of ["/sign-in/email", "/two-factor/verify-totp"]) {
        await expect(sessions.beforeSessionCreate({ userId: owner }, { path })).resolves.toBeUndefined();
      }
      await expect(
        sessions.beforeSessionCreate({ userId: member }, { path: "/sso/callback/:providerId", params: { providerId } }),
      ).resolves.toBeUndefined();
    });

    it("records the provider of an SSO session and carries it to a re-issued session", async () => {
      await addSession("s-new-sso", member);
      await sessions.afterSessionCreate({ id: "s-new-sso" }, { path: "/sso/saml2/sp/acs/:providerId", params: { providerId } });
      await addSession("s-reissued", member);
      await sessions.afterSessionCreate({ id: "s-reissued" }, { path: "/change-password", context: { session: { session: { id: "s-new-sso" } } } });
      await addSession("s-unrelated", member);
      await sessions.afterSessionCreate({ id: "s-unrelated" }, { path: "/sign-in/email" });
      const rows = await sql<{ session_id: string }>("SELECT session_id FROM sso_sessions WHERE session_id IN ('s-new-sso','s-reissued','s-unrelated') ORDER BY 1");
      expect(rows.map((r) => r.session_id)).toEqual(["s-new-sso", "s-reissued"]);
    });

    it("lets a session reach the workspace only through its own provider, an emergency-access admin always", async () => {
      await expect(sessions.assertSsoSessionForWorkspace(ws, member, "s-member-sso")).resolves.toBeUndefined();
      await expect(sessions.assertSsoSessionForWorkspace(ws, owner, "s-owner-password")).resolves.toBeUndefined();
      await addSession("s-other-idp", admin, "anlyon-someone-else");
      await expect(sessions.assertSsoSessionForWorkspace(ws, admin, "s-other-idp")).rejects.toMatchObject({ statusCode: 403, code: "SSO_REQUIRED" });
      await expect(sessions.assertSsoSessionForWorkspace(ws, admin, undefined)).rejects.toMatchObject({ code: "SSO_REQUIRED" });
      await expect(sessions.assertSsoSessionForWorkspace(other, admin, "s-other-idp")).resolves.toBeUndefined();
    });

    it("refuses an SSO sign-up for an email outside the verified domains, and only on SSO callbacks", async () => {
      const callback = { path: "/sso/callback/:providerId", params: { providerId } };
      await expect(ssoSignupRefusal("new.person@acme.io", callback)).resolves.toBeNull();
      await expect(ssoSignupRefusal("someone@gmail.com", callback)).resolves.toBe(SSO_DOMAIN_REFUSED_MESSAGE);
      await expect(ssoSignupRefusal("x@eu.acme.com", callback)).resolves.toBe(SSO_DOMAIN_REFUSED_MESSAGE);
      await expect(
        ssoSignupRefusal("someone@gmail.com", { path: "/sso/saml2/sp/acs/:providerId", params: { providerId } }),
      ).resolves.toBe(SSO_DOMAIN_REFUSED_MESSAGE);
      await expect(ssoSignupRefusal("a@acme.com", { path: "/sso/callback/:providerId", params: { providerId: "nobody" } })).resolves.toBe(
        SSO_DOMAIN_REFUSED_MESSAGE,
      );
      await expect(ssoSignupRefusal("a@acme.com", { path: "/sso/callback" })).resolves.toBe(SSO_DOMAIN_REFUSED_MESSAGE);
      await expect(ssoSignupRefusal("someone@gmail.com", { path: "/sign-up/email" })).resolves.toBeNull();
      await expect(ssoSignupRefusal("someone@gmail.com", { path: "/callback/:id" })).resolves.toBeNull();
    });

    it("binds an app to the workspace only from a session through its provider, and never by token", async () => {
      const [{ id: envId }] = await sql<{ id: string }>(
        "INSERT INTO environments (workspace_id, name, slug, is_default) VALUES ($1, 'Production', 'production-sso', true) RETURNING id",
        [ws],
      );
      await sql(
        "INSERT INTO oauth_client (id, client_id, redirect_uris) VALUES ('oc-sso', 'client-sso', ARRAY['https://example.com/cb']), ('oc-owner', 'client-owner', ARRAY['https://example.com/cb'])",
      );
      await expect(oauthTokens.setWorkspaceBinding(member, "client-sso", ws, envId, { sessionId: "s-member-password" })).rejects.toMatchObject({
        code: "SSO_REQUIRED",
      });
      await expect(oauthTokens.setWorkspaceBinding(member, "client-sso", ws, envId)).rejects.toMatchObject({ code: "SSO_REQUIRED" });
      expect(await sql("SELECT 1 FROM oauth_workspace_binding WHERE client_id = 'client-sso'")).toEqual([]);

      await expect(oauthTokens.setWorkspaceBinding(member, "client-sso", ws, envId, { sessionId: "s-member-sso" })).resolves.toBeUndefined();
      await expect(oauthTokens.setWorkspaceBinding(owner, "client-owner", ws, envId, { sessionId: "s-owner-password" })).resolves.toBeUndefined();
    });

    it("issues no app grant for the workspace from a session that did not come through its provider", async () => {
      await oauthTokens.setPendingBindingReference(member, ws);
      await expect(oauthTokens.assertSsoForOAuthGrant(member, "s-member-password")).rejects.toMatchObject({ code: "SSO_REQUIRED" });
      await expect(oauthTokens.assertSsoForOAuthGrant(member, "s-member-sso")).resolves.toBeUndefined();
      memory.clear();
      await addUser("user_solo_sso", "solo@acme.com", ws, "member");
      await addSession("s-solo-password", "user_solo_sso");
      await expect(oauthTokens.assertSsoForOAuthGrant("user_solo_sso", "s-solo-password")).rejects.toMatchObject({ code: "SSO_REQUIRED" });
      await expect(oauthTokens.assertSsoForOAuthGrant(owner, "s-owner-password")).resolves.toBeUndefined();
    });

    it("lifts with the provider", async () => {
      await sso.deleteSsoConnection(ws, owner);
      expect(await sql("SELECT 1 FROM workspace_sso_connections WHERE workspace_id = $1", [ws])).toEqual([]);
      await expect(sessions.assertSsoSessionForWorkspace(ws, admin, undefined)).resolves.toBeUndefined();
      await expect(sessions.beforeSessionCreate({ userId: member }, { path: "/sign-in/email" })).resolves.toBeUndefined();
    });

    it("recorded every sign-in configuration change, and each first-sign-in membership, in the audit stream", async () => {
      const rows = await sql<{ type: string; category: string; actor_type: string; actor_id: string | null; data: Record<string, unknown> }>(
        "SELECT type, category, actor_type, actor_id, data FROM audit_events WHERE workspace_id = $1 ORDER BY seq",
        [ws],
      );
      expect(rows.map((row) => row.type)).toEqual(
        expect.arrayContaining(["sso.connection_created", "sso.domains_verified", "member.provisioned", "sso.settings_updated", "sso.connection_deleted"]),
      );
      expect(rows.every((row) => row.category === "access")).toBe(true);
      expect(rows.find((row) => row.type === "sso.connection_created")).toMatchObject({ actor_type: "user", actor_id: admin });
      expect(rows.find((row) => row.type === "sso.settings_updated")?.data).toMatchObject({ enforced: true, previousEnforced: false });
      expect(rows.find((row) => row.type === "member.provisioned")).toMatchObject({
        actor_type: "user",
        actor_id: "user_new_sso",
        data: expect.objectContaining({ source: "sso", role: "member" }),
      });
      expect(rows.filter((row) => row.type === "member.provisioned")).toHaveLength(1);
    });
  });

  it("refuses enforcement before the domains are verified", async () => {
    safeFetch.mockResolvedValueOnce(json(oktaDiscovery));
    await sso.createSsoConnection(ws, admin, new Headers(), {
      protocol: "oidc",
      domains: ["acme.com"],
      defaultRole: "member",
      oidc: { issuer: OKTA_ISSUER, clientId: "client-id", clientSecret: "<your-client-secret>" },
    });
    await expect(sso.updateSsoConnection(ws, owner, { enforced: true })).rejects.toMatchObject({ code: "DOMAIN_NOT_VERIFIED" });
  });
});
