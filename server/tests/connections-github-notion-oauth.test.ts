import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined, store: new Map<string, { value: string; expiresAt: number }>() }));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client), pool: { end: async () => {} } };
});
vi.mock("../src/lib/redis.ts", () => {
  const live = (key: string) => {
    const entry = state.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      state.store.delete(key);
      return null;
    }
    return entry;
  };
  const redis = {
    async set(key: string, value: string, _px: "PX", ttl: number) {
      state.store.set(key, { value, expiresAt: Date.now() + ttl });
      return "OK";
    },
    async get(key: string) {
      return live(key)?.value ?? null;
    },
    async getdel(key: string) {
      const entry = live(key);
      state.store.delete(key);
      return entry?.value ?? null;
    },
    async pttl(key: string) {
      const entry = live(key);
      return entry ? entry.expiresAt - Date.now() : -2;
    },
    async del(key: string) {
      return state.store.delete(key) ? 1 : 0;
    },
  };
  return { redis, redisBlocking: redis, RedisKeys: {}, createBlockingConnection: () => redis };
});

const { createNativeProvider } = await import("../src/core/connections/native.ts");
const { OAUTH_APPS } = await import("../src/core/connections/oauth-apps.ts");
const { ConnectionRevokedError } = await import("../src/core/connections/types.ts");
const { encryptSecret } = await import("../src/utils/crypto.ts");

const ORIGIN = "https://api.anlyon.test";
const PAGES = "https://connect.anlyon.test";
const KEY = "test-connections-encryption-key-32chars";
const CLIENT = { clientId: "Iv1.client0001", clientSecret: "client_secret_00000000000000000000" };
const BASIC = `Basic ${Buffer.from(`${CLIENT.clientId}:${CLIENT.clientSecret}`).toString("base64")}`;

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeProvider(answer: (request: Sent) => { status: number; body?: unknown }) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const request = { url, method: init.method, headers: Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])), body: init.body ?? "" };
    sent.push(request);
    const { status, body } = answer(request);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const provider = createNativeProvider({ origin: ORIGIN, pagesOrigin: PAGES, encryptionKey: KEY, fetch, clientFor: () => CLIENT });
  return { provider, sent };
}

describe("signing in to GitHub and Notion", () => {
  let scope: { workspaceId: string; environmentId: string };

  beforeAll(async () => {
    const { rows: [ws] } = await state.client!.query<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Sign-in', 'sign-in-gh-notion') RETURNING id`);
    const { rows: [env] } = await state.client!.query<{ id: string }>(
      `INSERT INTO environments (workspace_id, name, slug, is_default) VALUES ($1, 'Production', 'production-gh-notion', true) RETURNING id`,
      [ws!.id],
    );
    scope = { workspaceId: ws!.id, environmentId: env!.id };
  });
  beforeEach(() => {
    state.store.clear();
  });

  const endUserId = () => `ws_${scope.workspaceId}:env_${scope.environmentId}:csn_${Math.random().toString(36).slice(2, 12)}`;

  async function signIn(provider: ReturnType<typeof createNativeProvider>, integrationKey: string, code = "the-code") {
    const { sessionToken } = await provider.createConnectSession({ endUserId: endUserId(), integrationKey });
    const authorizeUrl = new URL((await provider.beginConsent(sessionToken))!);
    const result = await provider.finishConsent({ state: authorizeUrl.searchParams.get("state"), code, error: null });
    return { authorizeUrl, result };
  }

  async function row(connectionId: string) {
    const { rows } = await state.client!.query<{ refresh_token_encrypted: string | null; expires_at: Date | null; revoked_at: Date | null; connection_config: Record<string, unknown>; scopes: string | null }>(
      `SELECT refresh_token_encrypted, expires_at, revoked_at, connection_config, scopes FROM oauth_connections WHERE id = $1`, [connectionId],
    );
    return rows[0]!;
  }

  const expire = (connectionId: string) =>
    state.client!.query(`UPDATE oauth_connections SET expires_at = now() - interval '1 minute' WHERE id = $1`, [connectionId]);

  describe("GitHub", () => {
    const tokenUrl = "https://github.com/login/oauth/access_token";

    it("asks for `repo` with PKCE at GitHub's authorize URL, on the pages host's callback", async () => {
      const { provider } = fakeProvider(() => ({ status: 200, body: { access_token: "gho_token", token_type: "bearer", scope: "repo" } }));
      const { sessionToken } = await provider.createConnectSession({ endUserId: endUserId(), integrationKey: "github" });
      const url = new URL((await provider.beginConsent(sessionToken))!);
      expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
      expect(url.searchParams.get("client_id")).toBe(CLIENT.clientId);
      expect(url.searchParams.get("redirect_uri")).toBe(`${PAGES}/callback`);
      expect(url.searchParams.get("scope")).toBe("repo");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get("state")).toBeTruthy();
    });

    it("exchanges the code as a form asking for JSON, and keeps an OAuth app's token, which does not expire, marked as a sign-in", async () => {
      const { provider, sent } = fakeProvider(() => ({ status: 200, body: { access_token: "gho_token", token_type: "bearer", scope: "repo" } }));
      const { authorizeUrl, result } = await signIn(provider, "github");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const [exchange] = sent;
      expect(exchange!.url).toBe(tokenUrl);
      expect(exchange!.method).toBe("POST");
      expect(exchange!.headers.accept).toBe("application/json");
      expect(exchange!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      const form = new URLSearchParams(exchange!.body);
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("the-code");
      expect(form.get("client_id")).toBe(CLIENT.clientId);
      expect(form.get("client_secret")).toBe(CLIENT.clientSecret);
      expect(form.get("redirect_uri")).toBe(authorizeUrl.searchParams.get("redirect_uri"));
      expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

      const stored = await row(result.outcome.connectionId);
      expect(stored).toMatchObject({ refresh_token_encrypted: null, expires_at: null, scopes: "repo", connection_config: { signedIn: true } });
      expect(await provider.getAccessToken({ integrationKey: "github", connectionId: result.outcome.connectionId })).toBe("gho_token");
    });

    it("a code GitHub refuses (200 with an error) stores nothing", async () => {
      const { provider } = fakeProvider(() => ({ status: 200, body: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." } }));
      const before = (await state.client!.query(`SELECT id FROM oauth_connections`)).rows.length;
      const { result } = await signIn(provider, "github");
      expect(result).toMatchObject({ ok: false, reason: "provider_error" });
      expect((await state.client!.query(`SELECT id FROM oauth_connections`)).rows.length).toBe(before);
    });

    it("a GitHub App's expiring token is refreshed, and the new refresh token replaces the spent one", async () => {
      let issued = 0;
      const { provider, sent } = fakeProvider((request) => {
        issued++;
        return { status: 200, body: { access_token: `ghu_${issued}`, expires_in: 28800, refresh_token: `ghr_${issued}`, refresh_token_expires_in: 15897600, token_type: "bearer", scope: "" } };
      });
      const { result } = await signIn(provider, "github");
      if (!result.ok) throw new Error("consent failed");
      const ref = { integrationKey: "github", connectionId: result.outcome.connectionId };
      expect((await row(ref.connectionId)).expires_at).toBeInstanceOf(Date);

      await expire(ref.connectionId);
      expect(await provider.getAccessToken(ref)).toBe("ghu_2");
      const refresh = new URLSearchParams(sent[1]!.body);
      expect(sent[1]!.url).toBe(tokenUrl);
      expect(Object.fromEntries(refresh)).toMatchObject({ grant_type: "refresh_token", refresh_token: "ghr_1", client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret });

      await expire(ref.connectionId);
      expect(await provider.getAccessToken(ref)).toBe("ghu_3");
      expect(new URLSearchParams(sent[2]!.body).get("refresh_token")).toBe("ghr_2");
    });

    it("a refresh token GitHub refuses with 200 and bad_refresh_token is a dead grant", async () => {
      let calls = 0;
      const { provider } = fakeProvider(() => (++calls === 1
        ? { status: 200, body: { access_token: "ghu_1", expires_in: 28800, refresh_token: "ghr_1", token_type: "bearer" } }
        : { status: 200, body: { error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." } }));
      const { result } = await signIn(provider, "github");
      if (!result.ok) throw new Error("consent failed");
      await expire(result.outcome.connectionId);
      await expect(provider.getAccessToken({ integrationKey: "github", connectionId: result.outcome.connectionId })).rejects.toBeInstanceOf(ConnectionRevokedError);
      expect((await row(result.outcome.connectionId)).revoked_at).toBeInstanceOf(Date);
    });

    it("a token that cannot be refreshed is proved with GET /user, with GitHub's headers; a 401 is a dead grant", async () => {
      let userStatus = 200;
      const { provider, sent } = fakeProvider((request) => request.url === tokenUrl
        ? { status: 200, body: { access_token: "gho_token", token_type: "bearer", scope: "repo" } }
        : { status: userStatus, body: { login: "octocat" } });
      const { result } = await signIn(provider, "github");
      if (!result.ok) throw new Error("consent failed");
      const ref = { integrationKey: "github", connectionId: result.outcome.connectionId };

      expect(await provider.getAccessToken(ref, { forceRefresh: true })).toBe("gho_token");
      const check = sent.at(-1)!;
      expect(check).toMatchObject({ url: "https://api.github.com/user", method: "GET" });
      expect(check.headers).toMatchObject({ authorization: "Bearer gho_token", "user-agent": "anlyon", "x-github-api-version": "2022-11-28", accept: "application/vnd.github+json" });

      userStatus = 401;
      await expect(provider.getAccessToken(ref, { forceRefresh: true })).rejects.toBeInstanceOf(ConnectionRevokedError);
    });

    it("disconnecting deletes that one token at GitHub, with the client in HTTP Basic, not the whole grant", async () => {
      const { provider, sent } = fakeProvider((request) => request.url === tokenUrl
        ? { status: 200, body: { access_token: "gho_token", token_type: "bearer", scope: "repo" } }
        : { status: 204 });
      const { result } = await signIn(provider, "github");
      if (!result.ok) throw new Error("consent failed");
      await provider.deleteConnection({ integrationKey: "github", connectionId: result.outcome.connectionId });

      const revoke = sent.at(-1)!;
      expect(revoke.url).toBe(`https://api.github.com/applications/${encodeURIComponent(CLIENT.clientId)}/token`);
      expect(revoke.method).toBe("DELETE");
      expect(revoke.headers.authorization).toBe(BASIC);
      expect(revoke.headers["content-type"]).toBe("application/json");
      expect(revoke.headers["user-agent"]).toBe("anlyon");
      expect(JSON.parse(revoke.body)).toEqual({ access_token: "gho_token" });
      expect(sent.some((s) => s.url.endsWith("/grant"))).toBe(false);
      const { rows } = await state.client!.query(`SELECT id FROM oauth_connections WHERE id = $1`, [result.outcome.connectionId]);
      expect(rows).toEqual([]);
    });
  });

  describe("Notion", () => {
    const tokenUrl = "https://api.notion.com/v1/oauth/token";
    const granted = (n: number) => ({
      access_token: `ntn_access_${n}`, token_type: "bearer", refresh_token: `nrt_${n}`, bot_id: "bot-1",
      workspace_id: "ws-notion-1", workspace_name: "Acme Notes", workspace_icon: null, owner: { type: "user", user: { id: "u-1" } }, duplicated_template_id: null,
    });

    it("asks Notion for a user-owned grant, with no scopes and no PKCE", async () => {
      const { provider } = fakeProvider(() => ({ status: 200, body: granted(1) }));
      const { sessionToken } = await provider.createConnectSession({ endUserId: endUserId(), integrationKey: "notion" });
      const url = new URL((await provider.beginConsent(sessionToken))!);
      expect(`${url.origin}${url.pathname}`).toBe("https://api.notion.com/v1/oauth/authorize");
      expect(url.searchParams.get("owner")).toBe("user");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("redirect_uri")).toBe(`${PAGES}/callback`);
      expect(url.searchParams.has("scope")).toBe(false);
      expect(url.searchParams.has("code_challenge")).toBe(false);
    });

    it("exchanges the code as JSON with the client in HTTP Basic and Notion's version, and keeps the workspace", async () => {
      const { provider, sent } = fakeProvider(() => ({ status: 200, body: granted(1) }));
      const { authorizeUrl, result } = await signIn(provider, "notion");
      if (!result.ok) throw new Error("consent failed");

      const [exchange] = sent;
      expect(exchange!.url).toBe(tokenUrl);
      expect(exchange!.headers).toMatchObject({ authorization: BASIC, "content-type": "application/json", "notion-version": "2022-06-28" });
      expect(JSON.parse(exchange!.body)).toEqual({ grant_type: "authorization_code", code: "the-code", redirect_uri: authorizeUrl.searchParams.get("redirect_uri") });

      const stored = await row(result.outcome.connectionId);
      expect(stored.connection_config).toEqual({ workspace_id: "ws-notion-1", workspace_name: "Acme Notes", bot_id: "bot-1", signedIn: true });
      expect(stored.refresh_token_encrypted).not.toBeNull();
      expect(stored.expires_at).toBeNull();
      expect(await provider.getAccessToken({ integrationKey: "notion", connectionId: result.outcome.connectionId })).toBe("ntn_access_1");
    });

    it("a forced check refreshes with JSON, storing the new pair; Notion's invalid_grant code is a dead grant", async () => {
      let issued = 0;
      let refuse = false;
      const { provider, sent } = fakeProvider(() => (refuse
        ? { status: 400, body: { object: "error", status: 400, code: "invalid_grant", message: "Invalid refresh token." } }
        : { status: 200, body: granted(++issued) }));
      const { result } = await signIn(provider, "notion");
      if (!result.ok) throw new Error("consent failed");
      const ref = { integrationKey: "notion", connectionId: result.outcome.connectionId };

      expect(await provider.getAccessToken(ref, { forceRefresh: true })).toBe("ntn_access_2");
      expect(sent[1]!.headers.authorization).toBe(BASIC);
      expect(JSON.parse(sent[1]!.body)).toEqual({ grant_type: "refresh_token", refresh_token: "nrt_1" });
      expect(await provider.getAccessToken(ref, { forceRefresh: true })).toBe("ntn_access_3");
      expect(JSON.parse(sent[2]!.body)).toEqual({ grant_type: "refresh_token", refresh_token: "nrt_2" });

      refuse = true;
      await expect(provider.getAccessToken(ref, { forceRefresh: true })).rejects.toBeInstanceOf(ConnectionRevokedError);
      expect((await row(ref.connectionId)).revoked_at).toBeInstanceOf(Date);
    });

    it("a grant with no refresh token is proved with GET /v1/users/me and Notion's version", async () => {
      const { provider, sent } = fakeProvider((request) => request.url === tokenUrl
        ? { status: 200, body: { ...granted(1), refresh_token: null } }
        : { status: 200, body: { object: "user", type: "bot" } });
      const { result } = await signIn(provider, "notion");
      if (!result.ok) throw new Error("consent failed");
      expect(await provider.getAccessToken({ integrationKey: "notion", connectionId: result.outcome.connectionId }, { forceRefresh: true })).toBe("ntn_access_1");
      expect(sent.at(-1)).toMatchObject({ url: "https://api.notion.com/v1/users/me", method: "GET", headers: { authorization: "Bearer ntn_access_1", "notion-version": "2022-06-28" } });
    });

    it("disconnecting revokes the token at Notion with HTTP Basic and a JSON body", async () => {
      const { provider, sent } = fakeProvider((request) => request.url === tokenUrl ? { status: 200, body: granted(1) } : { status: 200, body: { request_id: "r" } });
      const { result } = await signIn(provider, "notion");
      if (!result.ok) throw new Error("consent failed");
      await provider.deleteConnection({ integrationKey: "notion", connectionId: result.outcome.connectionId });
      const revoke = sent.at(-1)!;
      expect(revoke).toMatchObject({ url: "https://api.notion.com/v1/oauth/revoke", method: "POST", headers: { authorization: BASIC, "content-type": "application/json", "notion-version": "2022-06-28" } });
      expect(JSON.parse(revoke.body)).toEqual({ token: "ntn_access_1" });
    });
  });

  it("an end user's key for GitHub or Notion (no sign-in mark) is deleted without telling the provider", async () => {
    const { provider, sent } = fakeProvider(() => ({ status: 204 }));
    for (const integrationKey of ["github", "notion"]) {
      const id = `oc_key_${integrationKey}`;
      await state.client!.query(
        `INSERT INTO oauth_connections (id, workspace_id, environment_id, integration_key, end_user_id, subject_end_user_id, access_token_encrypted)
         VALUES ($1, $2, $3, $4, $5, 'alice', $6)`,
        [id, scope.workspaceId, scope.environmentId, integrationKey, endUserId(),
          encryptSecret("pasted_key_000000", KEY, { store: "oauth-connection", workspaceId: scope.workspaceId, name: `${id}:access` })],
      );
      await provider.deleteConnection({ integrationKey, connectionId: id });
      const { rows } = await state.client!.query(`SELECT id FROM oauth_connections WHERE id = $1`, [id]);
      expect(rows).toEqual([]);
    }
    expect(sent).toEqual([]);
  });

  it("both specs are on HTTPS provider hosts, and only GitHub's revocation names the client", () => {
    expect(OAUTH_APPS.github!.revoke).toMatchObject({ style: "json_basic", method: "DELETE", field: "access_token" });
    expect(OAUTH_APPS.github!.revoke!.url).toContain("/token");
    expect(OAUTH_APPS.notion!.revoke!.url).not.toContain("{client_id}");
    expect(OAUTH_APPS.notion!.clientAuth).toBe("basic");
    expect(OAUTH_APPS.github!.clientAuth).toBe("body");
  });
});
