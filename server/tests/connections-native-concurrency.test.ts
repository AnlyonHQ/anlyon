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

const { db } = await import("../src/db/index.ts");
const { createNativeProvider } = await import("../src/core/connections/native.ts");
const { OAuthProviderSimulator, OAUTH_SIM_CLIENT, OAUTH_SIM_ENCRYPTION_KEY, OAUTH_SIM_ORIGIN, consentDirectly } = await import("./support/effects/oauth-simulator.ts");
const { ConnectionProviderFailure } = await import("../src/core/connections/types.ts");

describe("Anlyon's own connector under concurrency", () => {
  let scope: { workspaceId: string; environmentId: string };

  beforeAll(async () => {
    const { rows: [ws] } = await state.client!.query<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Concurrency', 'concurrency') RETURNING id`);
    const { rows: [env] } = await state.client!.query<{ id: string }>(
      `INSERT INTO environments (workspace_id, name, slug, is_default) VALUES ($1, 'Production', 'production-concurrency', true) RETURNING id`,
      [ws!.id],
    );
    scope = { workspaceId: ws!.id, environmentId: env!.id };
  });
  beforeEach(() => {
    state.store.clear();
    vi.restoreAllMocks();
  });

  function providerWith(oauth: InstanceType<typeof OAuthProviderSimulator>, fetch = oauth.fetch) {
    return createNativeProvider({ origin: OAUTH_SIM_ORIGIN, encryptionKey: OAUTH_SIM_ENCRYPTION_KEY, fetch, clientFor: () => OAUTH_SIM_CLIENT });
  }

  async function expire(connectionId: string) {
    await state.client!.query(`UPDATE oauth_connections SET expires_at = now() - interval '1 minute' WHERE id = $1`, [connectionId]);
  }

  async function lease(connectionId: string): Promise<Date | null> {
    const { rows } = await state.client!.query<{ refresh_lease_until: Date | null }>(`SELECT refresh_lease_until FROM oauth_connections WHERE id = $1`, [connectionId]);
    return rows[0]!.refresh_lease_until;
  }

  it("refreshes with no transaction open across the provider call, holding a lease instead", async () => {
    const oauth = new OAuthProviderSimulator({ rotate: true });
    let leaseDuringCall: Date | null | undefined;
    let connectionId = "";
    const provider = providerWith(oauth, async (url, init) => {
      if (init.body?.includes("grant_type=refresh_token")) leaseDuringCall = await lease(connectionId);
      return oauth.fetch(url, init);
    });
    ({ connectionId } = await consentDirectly(provider, oauth, scope));
    await expire(connectionId);
    const transaction = vi.spyOn(db, "transaction");

    const token = await provider.getAccessToken({ integrationKey: "hubspot", connectionId });

    expect(token).toBe(oauth.latest().accessToken);
    expect(oauth.refreshes).toBe(1);
    expect(transaction).not.toHaveBeenCalled();
    expect(leaseDuringCall).toBeInstanceOf(Date);
    expect(await lease(connectionId)).toBeNull();
  });

  it("concurrent callers that find a token expired refresh it once, so a rotating refresh token survives", async () => {
    const oauth = new OAuthProviderSimulator({ rotate: true });
    const provider = providerWith(oauth, async (url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return oauth.fetch(url, init);
    });
    const { connectionId } = await consentDirectly(provider, oauth, scope);
    await expire(connectionId);
    const ref = { integrationKey: "hubspot", connectionId };

    const tokens = await Promise.all(Array.from({ length: 5 }, () => provider.getAccessToken(ref)));

    expect(oauth.refreshes).toBe(1);
    expect(new Set(tokens)).toEqual(new Set([oauth.latest().accessToken]));
    await expire(connectionId);
    await provider.getAccessToken(ref);
    expect(oauth.refreshes).toBe(2);
  });

  it("a provider outage frees the lease, so the next call can refresh", async () => {
    const oauth = new OAuthProviderSimulator();
    const provider = providerWith(oauth);
    const { connectionId } = await consentDirectly(provider, oauth, scope);
    await expire(connectionId);
    const ref = { integrationKey: "hubspot", connectionId };
    oauth.fault("token", "unreachable");

    await expect(provider.getAccessToken(ref)).rejects.toBeInstanceOf(ConnectionProviderFailure);
    expect(await lease(connectionId)).toBeNull();

    await provider.getAccessToken(ref);
    expect(oauth.refreshes).toBe(1);
  });

  it("an expired lease left by a crashed refresher is taken over", async () => {
    const oauth = new OAuthProviderSimulator();
    const provider = providerWith(oauth);
    const { connectionId } = await consentDirectly(provider, oauth, scope);
    await expire(connectionId);
    await state.client!.query(`UPDATE oauth_connections SET refresh_lease_until = now() - interval '1 second' WHERE id = $1`, [connectionId]);

    expect(await provider.getAccessToken({ integrationKey: "hubspot", connectionId })).toBe(oauth.latest().accessToken);
    expect(oauth.refreshes).toBe(1);
  });

  async function stored(connectionId: string) {
    const { rows: [row] } = await state.client!.query<{ access_token_encrypted: string; refresh_lease_until: Date | null; revoked_at: Date | null; last_refreshed_at: Date | null }>(
      `SELECT access_token_encrypted, refresh_lease_until, revoked_at, last_refreshed_at FROM oauth_connections WHERE id = $1`,
      [connectionId],
    );
    return row!;
  }

  it("a refresh that outlives its lease still stores a rotated refresh token when no other refresh happened", async () => {
    const oauth = new OAuthProviderSimulator({ rotate: true });
    let connectionId = "";
    let first = true;
    const provider = providerWith(oauth, async (url, init) => {
      if (first && init.body?.includes("grant_type=refresh_token")) {
        first = false;
        await state.client!.query(`UPDATE oauth_connections SET refresh_lease_until = now() + interval '1 hour' WHERE id = $1`, [connectionId]);
      }
      return oauth.fetch(url, init);
    });
    ({ connectionId } = await consentDirectly(provider, oauth, scope));
    await expire(connectionId);
    const ref = { integrationKey: "hubspot", connectionId };
    const before = await stored(connectionId);

    expect(await provider.getAccessToken(ref)).toBe(oauth.latest().accessToken);
    expect(oauth.refreshes).toBe(1);

    const after = await stored(connectionId);
    expect(after.access_token_encrypted).not.toBe(before.access_token_encrypted);
    expect(after.last_refreshed_at).toBeInstanceOf(Date);
    expect(after.refresh_lease_until!.getTime()).toBeGreaterThan(Date.now());

    await state.client!.query(`UPDATE oauth_connections SET refresh_lease_until = NULL WHERE id = $1`, [connectionId]);
    await expire(connectionId);
    expect(await provider.getAccessToken(ref)).toBe(oauth.latest().accessToken);
    expect(oauth.refreshes).toBe(2);
    expect((await stored(connectionId)).revoked_at).toBeNull();
  });

  it("when another refresh stored first, a late refresh refused for its spent token uses theirs and does not kill the grant", async () => {
    const oauth = new OAuthProviderSimulator({ rotate: true });
    let connectionId = "";
    let first = true;
    let theirs = "";
    const ref = () => ({ integrationKey: "hubspot", connectionId });
    const provider = providerWith(oauth, async (url, init) => {
      if (first && init.body?.includes("grant_type=refresh_token")) {
        first = false;
        await state.client!.query(`UPDATE oauth_connections SET refresh_lease_until = now() - interval '1 second' WHERE id = $1`, [connectionId]);
        theirs = await provider.getAccessToken(ref());
      }
      return oauth.fetch(url, init);
    });
    ({ connectionId } = await consentDirectly(provider, oauth, scope));
    await expire(connectionId);

    const ours = await provider.getAccessToken(ref());

    expect(theirs).toBe(oauth.latest().accessToken);
    expect(ours).toBe(theirs);
    expect(oauth.refreshes).toBe(1);
    const after = await stored(connectionId);
    expect(after.revoked_at).toBeNull();
    expect(after.refresh_lease_until).toBeNull();
    await expire(connectionId);
    await provider.getAccessToken(ref());
    expect(oauth.refreshes).toBe(2);
  });

  it("when another refresh stored first and this one also succeeded, this one's tokens are discarded", async () => {
    const oauth = new OAuthProviderSimulator();
    let connectionId = "";
    let first = true;
    let theirs = "";
    let ourAnswer = "";
    const ref = () => ({ integrationKey: "hubspot", connectionId });
    const provider = providerWith(oauth, async (url, init) => {
      if (first && init.body?.includes("grant_type=refresh_token")) {
        first = false;
        const answer = await oauth.fetch(url, init);
        ourAnswer = oauth.latest().accessToken;
        await state.client!.query(`UPDATE oauth_connections SET refresh_lease_until = now() - interval '1 second' WHERE id = $1`, [connectionId]);
        theirs = await provider.getAccessToken(ref());
        return answer;
      }
      return oauth.fetch(url, init);
    });
    ({ connectionId } = await consentDirectly(provider, oauth, scope));
    await expire(connectionId);

    const ours = await provider.getAccessToken(ref());

    expect(oauth.refreshes).toBe(2);
    expect(theirs).toBe(oauth.latest().accessToken);
    expect(theirs).not.toBe(ourAnswer);
    expect(ours).toBe(theirs);
    expect(await provider.getAccessToken(ref())).toBe(theirs);
    expect(oauth.refreshes).toBe(2);
  });

  it("a consent opened twice finishes once: the racing redirect is refused before its code is exchanged", async () => {
    const oauth = new OAuthProviderSimulator();
    const provider = providerWith(oauth);
    const endUserId = `ws_${scope.workspaceId}:env_${scope.environmentId}:csn_race0001`;
    const { sessionToken } = await provider.createConnectSession({ endUserId, integrationKey: "hubspot" });
    const first = new URL(oauth.approve((await provider.beginConsent(sessionToken))!));
    const second = new URL(oauth.approve((await provider.beginConsent(sessionToken))!));
    const callback = (back: URL) => provider.finishConsent({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null });

    const results = await Promise.all([callback(first), callback(second)]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "expired", endUserId: null }]);
    expect(oauth.requests.filter((r) => r.body.includes("grant_type=authorization_code"))).toHaveLength(1);
    const { rows } = await state.client!.query(`SELECT id FROM oauth_connections WHERE end_user_id = $1`, [endUserId]);
    expect(rows).toHaveLength(1);
  });
});
