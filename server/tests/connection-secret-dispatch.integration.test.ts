import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { providerFetch } from "./support/effects/provider-fetch.ts";

const logLines: string[] = [];
vi.mock("../src/lib/logger.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/logger.ts")>();
  const pino = (await import("pino")).default;
  const logger = pino({ level: "debug" }, { write: (line: string) => { logLines.push(line); } });
  return {
    ...actual,
    logger,
    createLogger: (context: Record<string, unknown>) => logger.child(context),
    apiLogger: logger.child({ module: "api" }),
    workerLogger: logger.child({ module: "worker" }),
    dbLogger: logger.child({ module: "database" }),
    redisLogger: logger.child({ module: "redis" }),
    authLogger: logger.child({ module: "auth" }),
  };
});

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});

const { EffectScope, loadEffectModules } = await import("./support/effects/fixture.ts");
const { HttpSimulator } = await import("./support/effects/http-simulator.ts");
const { OAuthProviderSimulator, OAUTH_SIM_CLIENT, OAUTH_SIM_ENCRYPTION_KEY, OAUTH_SIM_ORIGIN, consentDirectly } = await import("./support/effects/oauth-simulator.ts");
const { setProviderFetchForHost } = await import("./support/effects/provider-fetch.ts");
const { createNativeProvider } = await import("../src/core/connections/native.ts");
const { setConnectionProviderForTests } = await import("../src/core/connections/provider.ts");
type Provider = import("../src/core/connections/types.ts").ConnectionProvider;

const HUBSPOT_HOST = "api.hubapi.com";

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("connection-backed secrets (real Postgres)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let m: Awaited<ReturnType<typeof loadEffectModules>>;
  let s: InstanceType<typeof EffectScope>;
  let oauth: InstanceType<typeof OAuthProviderSimulator>;
  let provider: Provider;
  let hubspot: InstanceType<typeof HttpSimulator>;

  beforeAll(async () => {
    await pool.query("SELECT 1");
    m = await loadEffectModules();
  });
  beforeEach(async () => {
    s = await new EffectScope(pool, m).seed();
    oauth = new OAuthProviderSimulator();
    hubspot = new HttpSimulator();
    hubspot.tokens.clear();
    setProviderFetchForHost(HUBSPOT_HOST, hubspot.fetch);
    provider = createNativeProvider({ origin: OAUTH_SIM_ORIGIN, encryptionKey: OAUTH_SIM_ENCRYPTION_KEY, fetch: oauth.fetch, clientFor: () => OAUTH_SIM_CLIENT });
    setConnectionProviderForTests(provider);
    logLines.length = 0;
  });
  afterEach(async () => {
    setConnectionProviderForTests(undefined);
    await s.cleanup();
  });
  afterAll(async () => { await pool.end(); });

  async function connectHubspot(name = "HUBSPOT") {
    const { connectionId, grant } = await consentDirectly(provider, oauth, { workspaceId: s.workspaceId, environmentId: s.environmentId });
    hubspot.tokens.add(grant.accessToken);
    const secret = await m.secrets.putConnectionSecret(s.workspaceId, name, {
      integrationId: "hubspot", connectionId, allowedHosts: [HUBSPOT_HOST], description: "CRM",
    }, s.environmentId);
    return { connection: { connectionId, ...grant }, grant, secret };
  }

  const expire = (connectionId: string) =>
    pool.query("UPDATE oauth_connections SET expires_at = now() - interval '1 minute' WHERE id = $1", [connectionId]);

  function noteAction(name = "note-customer", governed = true, requiresApproval = false) {
    const notes = `https://${HUBSPOT_HOST}/v1/notes`;
    return m.actions.createAction(s.workspaceId, {
      name,
      description: "Add a note. Limitation: no provider idempotency.",
      method: "PUT",
      urlTemplate: `${notes}/{{input.noteId}}`,
      headers: { Authorization: "Bearer {{secret:HUBSPOT}}" },
      bodyTemplate: { body: "{{input.body}}" },
      inputSchema: {
        type: "object", required: ["noteId", "body"],
        properties: { noteId: { type: "string", pattern: "^[a-z0-9-]{1,40}$" }, body: { type: "string" } },
      },
      requiresApproval,
      ...(governed ? {
        impact: { dimension: "resource_mutations", amount: "1", bound: "exact" as const },
        verify: { url: `${notes}/{{input.noteId}}`, status: 200, match: [{ path: "body", equals: "{{input.body}}" }] },
      } : {}),
    }, m.actions.UNSCOPED_AUTHORITY, s.environmentId);
  }

  async function rowsContaining(needle: string): Promise<Record<string, number>> {
    const tables = (await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    )).rows.map((r) => r.table_name as string);
    const hits: Record<string, number> = {};
    for (const table of tables) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${table}" t WHERE t::text LIKE $1`, [`%${needle}%`]);
      if (rows[0].n > 0) hits[table] = rows[0].n;
    }
    return hits;
  }

  it("a declared action dispatches with the provider's token, and the token is persisted and logged nowhere", async () => {
    const { connection, secret } = await connectHubspot();
    expect(secret).toMatchObject({
      name: "HUBSPOT", kind: "connection", allowedHosts: [HUBSPOT_HOST], allowedPlacements: ["header"],
      connection: { integrationId: "hubspot", status: "active" },
    });
    expect(JSON.stringify(secret)).not.toContain(connection.connectionId);
    await noteAction();

    const result = await s.invoke("note-customer", { noteId: "n-1", body: "Refunded order 1042" });
    expect(result).toMatchObject({ status: "succeeded", grade: "confirmed" });
    const write = hubspot.requests.find((r) => r.method === "PUT")!;
    expect(write.authorization).toBe(`Bearer ${connection.accessToken}`);
    expect(oauth.refreshes).toBe(0);

    const effect = await s.effect(result.effectId!);
    expect(JSON.stringify(effect)).not.toContain(connection.accessToken);
    expect(JSON.stringify(result)).not.toContain(connection.accessToken);
    expect(await rowsContaining(connection.accessToken)).toEqual({});
    expect(await rowsContaining(connection.refreshToken)).toEqual({});
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.filter((l) => l.includes(connection.accessToken))).toEqual([]);
    expect(logLines.filter((l) => l.includes(OAUTH_SIM_CLIENT.clientSecret))).toEqual([]);
    expect((await m.secrets.getSecretMetadata(s.workspaceId, "HUBSPOT", s.environmentId)).lastUsedAt).not.toBeNull();
  });

  it("the preview a reviewer sees carries the action's own notes, and no token", async () => {
    const { connection } = await connectHubspot();
    await noteAction();
    const preview = await m.effects.createPreviewForAction(s.workspaceId, s.environmentId, "note-customer", { noteId: "n-9", body: "hi" });
    const head = (preview.blocks as Array<{ title?: string; fields?: Array<{ label: string; value: string }> }>)[0];
    expect(head.fields).toContainEqual({ label: "Action notes", value: "Add a note. Limitation: no provider idempotency." });
    expect(JSON.stringify(preview)).not.toContain(connection.accessToken);
  });

  it("an expired token is refreshed before the dispatch, and the dispatch uses the new one", async () => {
    const { connection, grant } = await connectHubspot();
    await noteAction();
    const first = grant.accessToken;
    await expire(connection.connectionId);
    hubspot.tokens.clear();
    const fetchNow = hubspot.fetch;
    hubspot.fetch = async (url, init) => { hubspot.tokens.clear(); hubspot.tokens.add(grant.accessToken); return fetchNow(url, init); };
    setProviderFetchForHost(HUBSPOT_HOST, hubspot.fetch);

    const result = await s.invoke("note-customer", { noteId: "n-2", body: "hello" });
    expect(result.status).toBe("succeeded");
    expect(oauth.refreshes).toBe(1);
    expect(grant.accessToken).not.toBe(first);
    expect(hubspot.requests.find((r) => r.method === "PUT")!.authorization).toBe(`Bearer ${grant.accessToken}`);
    expect(await rowsContaining(grant.accessToken)).toEqual({});
    expect(await rowsContaining(first)).toEqual({});
    expect(await rowsContaining(grant.refreshToken)).toEqual({});
  });

  it("concurrent dispatches that find a token expired refresh it once, so a rotating refresh token survives", async () => {
    oauth = new OAuthProviderSimulator({ rotate: true });
    provider = createNativeProvider({ origin: OAUTH_SIM_ORIGIN, encryptionKey: OAUTH_SIM_ENCRYPTION_KEY, fetch: oauth.fetch, clientFor: () => OAUTH_SIM_CLIENT });
    setConnectionProviderForTests(provider);
    const { connection, grant } = await connectHubspot();
    await expire(connection.connectionId);

    const ref = { integrationKey: "hubspot", connectionId: connection.connectionId };
    const tokens = await Promise.all(Array.from({ length: 5 }, () => provider.getAccessToken(ref)));
    expect(oauth.refreshes).toBe(1);
    expect(new Set(tokens)).toEqual(new Set([grant.accessToken]));
    expect(grant.revoked).toBe(false);
    await expire(connection.connectionId);
    expect(await provider.getAccessToken(ref)).toBe(grant.accessToken);
    expect(oauth.refreshes).toBe(2);
  });

  it("a revoked connection refuses a declared action at admission, before anything is sent", async () => {
    const { connection } = await connectHubspot();
    await noteAction();
    oauth.revoke();
    await expire(connection.connectionId);

    const refused = await s.invoke("note-customer", { noteId: "n-3", body: "never sent" }).catch((e) => e);
    expect(refused).toMatchObject({ code: "CONNECTION_NEEDS_REAUTH", statusCode: 424 });
    expect(refused.message).toMatch(/HUBSPOT is a connected account that needs to be reconnected\. Nothing was sent/);
    expect(refused.message).not.toMatch(/refresh_token|connection id|oauth_connections/i);
    expect(refused.message).not.toContain(connection.refreshToken);
    expect(hubspot.requests).toHaveLength(0);
    expect((await m.secrets.getSecretMetadata(s.workspaceId, "HUBSPOT", s.environmentId)).connection).toEqual({
      integrationId: "hubspot", status: "needs_reauth",
    });
    expect(logLines.filter((l) => l.includes(connection.refreshToken))).toEqual([]);
  });

  it("a connection revoked while an approval is pending fails the dispatch with nothing sent", async () => {
    const { connection } = await connectHubspot();
    await noteAction("note-customer", true, true);
    const parked = await s.invoke("note-customer", { noteId: "n-6", body: "after approval" });
    expect(parked.approvalId).toBeTruthy();
    oauth.revoke();
    await expire(connection.connectionId);

    await m.approvals.approveApproval(s.workspaceId, parked.approvalId!, { deciderKeyId: crypto.randomUUID() }, s.environmentId);
    const effect = await s.effect(parked.effectId!);
    expect(effect).toMatchObject({ stage: "rejected", outcome: "not_dispatched", rejectionReason: "credential_unavailable" });
    expect(effect.attempts).toHaveLength(0);
    expect(hubspot.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
    expect(JSON.stringify(effect)).toMatch(/needs to be reconnected/);
  });

  it("a revoked connection fails a template action as failed with nothing sent", async () => {
    const { connection } = await connectHubspot();
    await noteAction("note-plain", false);
    oauth.revoke();
    await expire(connection.connectionId);
    const result = await s.invoke("note-plain", { noteId: "n-4", body: "never sent" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/needs to be reconnected/);
    expect(hubspot.requests).toHaveLength(0);
  });

  it("a provider outage during a refresh fails before sending, leaves the account working, and never leaks the client secret or body", async () => {
    const { connection } = await connectHubspot();
    await noteAction("note-plain", false);
    await expire(connection.connectionId);
    oauth.fault("token", "http_500");
    const result = await s.invoke("note-plain", { noteId: "n-5", body: "x" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/could not be fetched\. Nothing was sent/);
    expect(hubspot.requests).toHaveLength(0);
    expect(logLines.filter((l) => l.includes(OAUTH_SIM_CLIENT.clientSecret) || l.includes("boom"))).toEqual([]);
    expect((await m.secrets.getSecretMetadata(s.workspaceId, "HUBSPOT", s.environmentId)).connection).toEqual({ integrationId: "hubspot", status: "active" });
  });

  it("PUT refuses to turn a connected account into a stored value, and the other way round", async () => {
    await connectHubspot();
    await expect(m.secrets.putSecret(s.workspaceId, "HUBSPOT", { value: "static-value" }, s.environmentId))
      .rejects.toMatchObject({ code: "SECRET_KIND_MISMATCH", statusCode: 409 });
    await expect(m.secrets.putConnectionSecret(s.workspaceId, "MAILER_TOKEN", {
      integrationId: "hubspot", connectionId: "c-1", allowedHosts: [HUBSPOT_HOST],
    }, s.environmentId)).rejects.toMatchObject({ code: "SECRET_KIND_MISMATCH" });
  });

  const tokenRows = async (connectionId: string) =>
    (await pool.query("SELECT 1 FROM oauth_connections WHERE id = $1", [connectionId])).rowCount;

  it("deleting a connection secret drops its token even when the provider cannot be told", async () => {
    const { connection, grant } = await connectHubspot();
    oauth.fault("revoke", "http_500");
    await m.secrets.deleteSecret(s.workspaceId, "HUBSPOT", s.environmentId, { confirmProtected: true });
    expect(await tokenRows(connection.connectionId)).toBe(0);
    expect(grant.revoked).toBe(false);
    await expect(m.secrets.getSecretMetadata(s.workspaceId, "HUBSPOT", s.environmentId)).rejects.toMatchObject({ code: "SECRET_NOT_FOUND" });
  });

  it("deleting a connection secret revokes the grant at the provider", async () => {
    const { connection, grant } = await connectHubspot();
    await m.secrets.deleteSecret(s.workspaceId, "HUBSPOT", s.environmentId, { confirmProtected: true });
    expect(grant.revoked).toBe(true);
    expect(await tokenRows(connection.connectionId)).toBe(0);
  });

  it("a connection whose token is already gone still deletes", async () => {
    const { connection } = await connectHubspot();
    await pool.query("DELETE FROM oauth_connections WHERE id = $1", [connection.connectionId]);
    await m.secrets.deleteSecret(s.workspaceId, "HUBSPOT", s.environmentId, { confirmProtected: true });
    await expect(m.secrets.getSecretMetadata(s.workspaceId, "HUBSPOT", s.environmentId)).rejects.toMatchObject({ code: "SECRET_NOT_FOUND" });
  });

  it("a connection secret cannot be created without hosts", async () => {
    await expect(m.secrets.putConnectionSecret(s.workspaceId, "EMPTY", {
      integrationId: "hubspot", connectionId: "c-2", allowedHosts: [],
    }, s.environmentId)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
