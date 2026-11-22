import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));
const memory = vi.hoisted(() => new Map<string, string>());

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client) };
});
vi.mock("../src/lib/redis.ts", () => ({
  redis: {
    get: async (key: string) => memory.get(key) ?? null,
    set: async (key: string, value: string) => void memory.set(key, value),
    setex: async (key: string, _ttl: number, value: string) => void memory.set(key, value),
    del: async (key: string) => (memory.delete(key) ? 1 : 0),
  },
  RedisKeys: { apiKey: (hash: string) => `apikey:${hash}`, apiKeyPrevious: (id: string) => `apikey:${id}:previous` },
}));
vi.mock("../src/core/edition/features.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/edition/features.ts")>()),
  isFeatureEnabled: () => true,
}));

const { auth, AUTH_BASE_PATH } = await import("../src/utils/auth.ts");
const { env } = await import("../src/config/env.ts");
const { createScimUser } = await import("../src/core/scim/service.ts");

const ws = "00000000-0000-4000-8000-0000000a6101";
const providerId = "acme-oidc-h6";
const IDP = "https://idp.acme.test";
const origin = new URL(env.BETTER_AUTH_URL).origin;
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  state.client!.query<T>(text, params).then((r) => r.rows);

let identity: { sub: string; email: string; name: string } = { sub: "", email: "", name: "" };

const realFetch = globalThis.fetch;
const idpFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.startsWith(`${IDP}/token`)) return json({ access_token: "idp-access-token", token_type: "Bearer", expires_in: 3600 });
  if (url.startsWith(`${IDP}/userinfo`)) return json({ ...identity, email_verified: true });
  return realFetch(input, init);
});

const call = (path: string, init: RequestInit = {}) =>
  auth.handler(new Request(`${origin}${AUTH_BASE_PATH}${path}`, { ...init, headers: { origin, "x-forwarded-for": "203.0.113.9", ...init.headers } }));

async function signInThroughIdp(): Promise<{ status: number; location: string }> {
  const start = await call("/sign-in/sso", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId, callbackURL: `${origin}/done` }),
  });
  expect(start.status, await start.clone().text()).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const stateParam = new URL(url).searchParams.get("state");
  expect(stateParam).toBeTruthy();
  const cookie = (start.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(";")[0])
    .join("; ");

  const callback = await call(`/sso/callback/${providerId}?code=idp-code&state=${encodeURIComponent(stateParam!)}`, {
    method: "GET",
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return { status: callback.status, location: callback.headers.get("location") ?? "" };
}

beforeAll(async () => {
  vi.stubGlobal("fetch", idpFetch);
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Acme', 'acme-h6')", [ws]);
  await sql(
    "INSERT INTO sso_provider (id, issuer, provider_id, domain, domain_verified, organization_id, oidc_config) VALUES ($1, $2, $3, 'acme.com', true, $4, $5)",
    [
      `row-${providerId}`,
      IDP,
      providerId,
      ws,
      JSON.stringify({
        issuer: IDP,
        clientId: "anlyon-client",
        clientSecret: "placeholder-client-secret",
        authorizationEndpoint: `${IDP}/authorize`,
        tokenEndpoint: `${IDP}/token`,
        jwksEndpoint: `${IDP}/keys`,
        userInfoEndpoint: `${IDP}/userinfo`,
        tokenEndpointAuthentication: "client_secret_post",
        pkce: true,
        scopes: ["openid", "email", "profile"],
      }),
    ],
  );
  await sql(
    `INSERT INTO workspace_sso_connections (workspace_id, provider_id, protocol, domains, domain_verification_token, domains_verified_at)
     VALUES ($1, $2, 'oidc', '["acme.com"]', 'anlyon-sso-verification-h6', now())`,
    [ws, providerId],
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("SSO callback", () => {
  it("links a directory-provisioned person to the account SCIM created, on their first SSO sign-in", async () => {
    const created = await createScimUser(ws, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "jane@acme.com",
      emails: [{ primary: true, value: "jane@acme.com" }],
      displayName: "Jane Doe",
      externalId: "okta-jane",
      active: true,
    });
    const [account] = await sql<{ id: string; email_verified: boolean }>(
      `SELECT id, email_verified FROM "user" WHERE email = 'jane@acme.com'`,
    );
    expect(account.email_verified).toBe(true);
    expect(created.id).toBeTruthy();

    identity = { sub: "idp-jane", email: "jane@acme.com", name: "Jane Doe" };
    const { status, location } = await signInThroughIdp();
    expect(status).toBe(302);
    expect(location).not.toMatch(/error=/);
    expect(location).toBe(`${origin}/done`);

    const linked = await sql<{ user_id: string }>("SELECT user_id FROM account WHERE provider_id = $1 AND account_id = 'idp-jane'", [providerId]);
    expect(linked).toEqual([{ user_id: account.id }]);
    expect(await sql(`SELECT id FROM "user" WHERE email = 'jane@acme.com'`)).toHaveLength(1);
    const sessions = await sql("SELECT s.id FROM session s JOIN sso_sessions x ON x.session_id = s.id WHERE s.user_id = $1", [account.id]);
    expect(sessions.length).toBeGreaterThan(0);
  });

  it("refuses to create an account for an email outside the verified domains", async () => {
    identity = { sub: "idp-outsider", email: "someone@gmail.com", name: "Not Acme" };
    const { status, location } = await signInThroughIdp();
    expect(status).toBe(302);
    expect(location).toMatch(/error=/);
    expect(await sql(`SELECT id FROM "user" WHERE email = 'someone@gmail.com'`)).toEqual([]);
    expect(await sql("SELECT id FROM account WHERE account_id = 'idp-outsider'")).toEqual([]);
  });

  it("still creates an account for a new person on a verified domain", async () => {
    identity = { sub: "idp-sam", email: "sam@acme.com", name: "Sam" };
    const { status, location } = await signInThroughIdp();
    expect(status).toBe(302);
    expect(location).not.toMatch(/error=/);
    const [user] = await sql<{ id: string }>(`SELECT id FROM "user" WHERE email = 'sam@acme.com'`);
    expect(user).toBeDefined();
    expect(await sql("SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [ws, user.id])).toEqual([{ role: "member" }]);
  });
});
