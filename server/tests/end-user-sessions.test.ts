import type { PGlite } from "@electric-sql/pglite";
import { Hono, type Context, type Next } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  process.env.CONNECTIONS_ENCRYPTION_KEY = "test-connections-encryption-key-32chars";
  process.env.CONNECTIONS_ALLOW_UNVERIFIED = "true";
  process.env.CONNECT_PUBLIC_URL = "https://api.anlyon.test";
  return {
    client: undefined as PGlite | undefined,
    store: new Map<string, { value: string; expiresAt: number }>(),
  };
});

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client), pool: { end: async () => {} } };
});
vi.mock("../src/lib/redis.ts", () => {
  const live = (key: string) => {
    const entry = state.store.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry;
  };
  const redis = {
    async set(key: string, value: string, _px?: "PX", ttl?: number) {
      state.store.set(key, { value, expiresAt: Date.now() + (ttl ?? 86_400_000) });
      return "OK";
    },
    async get(key: string) { return live(key)?.value ?? null; },
    async getdel(key: string) {
      const entry = live(key);
      state.store.delete(key);
      return entry?.value ?? null;
    },
    async del(key: string) { return state.store.delete(key) ? 1 : 0; },
    async incr(key: string) {
      const next = Number(live(key)?.value ?? 0) + 1;
      state.store.set(key, { value: String(next), expiresAt: live(key)?.expiresAt ?? Date.now() + 60_000 });
      return next;
    },
    async decr() { return 0; },
    async expire() { return 1; },
    async pexpire() { return 1; },
    async exists() { return 0; },
    async hgetall() { return {}; },
  };
  const RedisKeys = new Proxy({}, { get: (_t, name) => (...parts: unknown[]) => `${String(name)}:${parts.join(":")}` });
  return { redis, redisBlocking: redis, RedisKeys, createBlockingConnection: () => redis };
});
vi.mock("../src/core/events/emitter.ts", () => ({ emitEvent: vi.fn() }));
vi.mock("../src/core/notifications/notification-service.ts", () => ({ createAndSendNotification: vi.fn() }));
vi.mock("../src/core/assistant/service.ts", () => ({ onApprovalAnnounced: async () => false }));
vi.mock("../src/lib/product-events.ts", () => ({ captureMilestoneOnce: vi.fn() }));
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/feature-gate.ts", () => ({ requireFeature: () => async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/auth.ts", async (original) => {
  const actual = await original<typeof import("../src/api/middleware/auth.ts")>();
  return {
    ...actual,
    actualRequireApiKey: actual.requireApiKey,
    requireApiKey: async (c: Context, next: Next) => {
      const authType = c.req.header("x-test-auth") ?? "apiKey";
      c.set("authType", authType);
      c.set("workspaceId", ws);
      c.set("environmentId", c.req.header("x-test-env") ?? env);
      c.set("apiKeyScopes", (c.req.header("x-test-scopes") ?? "end-users:write,end-users:approvals").split(",").filter(Boolean));
      if (authType === "apiKey") {
        c.set("apiKeyId", c.req.header("x-test-key") ?? keyId);
        c.set("endUserRequired", false);
        const expires = c.req.header("x-test-key-expires");
        c.set("credentialExpiresAt", expires ? new Date(expires) : null);
      } else {
        c.set("userId", "user_1");
      }
      await next();
    },
    requirePermission: () => async (_c: Context, next: Next) => next(),
  };
});

const ws = "00000000-0000-4000-8000-00000000e5e1";
const env = "00000000-0000-4000-8000-00000000e5f1";
const otherEnv = "00000000-0000-4000-8000-00000000e5f2";
const keyId = "00000000-0000-4000-8000-00000000e5a1";
const revokedKeyId = "00000000-0000-4000-8000-00000000e5a2";
const otherEnvKeyId = "00000000-0000-4000-8000-00000000e5a3";
const scope = { workspaceId: ws, environmentId: env };
const APP = "https://app.acme.test";

const auth = await import("../src/api/middleware/auth.ts") as typeof import("../src/api/middleware/auth.ts") & { actualRequireApiKey: typeof import("../src/api/middleware/auth.ts").requireApiKey };
const { corsMiddleware } = await import("../src/api/middleware/cors.ts");
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const endUsersRouter = (await import("../src/api/routes/end-users.ts")).default;
const sessionRouter = (await import("../src/api/routes/end-user-session.ts")).default;
const { mintSessionToken } = await import("../src/core/end-users/session-token.ts");
const connections = await import("../src/core/end-users/connections.ts");
const { keyCheck } = await import("../src/core/connections/health.ts");
const { flushAuditEvents } = await import("../src/core/audit/recorder.ts");
const { createNativeProvider } = await import("../src/core/connections/native.ts");
const { setConnectionProviderForTests } = await import("../src/core/connections/provider.ts");
const upstreamOAuth = await import("../src/core/mcp-upstreams/oauth.ts");

const app = new Hono();
app.use("*", corsMiddleware);
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/api/v2/end-users", endUsersRouter);
app.route("/api/v2/end-user-session", sessionRouter);
app.use("/api/v2/actions/*", auth.actualRequireApiKey);
app.get("/api/v2/actions/list", (c) => c.json({ success: true }));

const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);
const code = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

async function mint(endUserId: string, init: { headers?: Record<string, string>; body?: unknown } = {}) {
  return app.request(`/api/v2/end-users/${encodeURIComponent(endUserId)}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(init.body ?? {}),
  });
}

async function tokenFor(endUserId: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await mint(endUserId, { headers });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { token: string } }).data.token;
}

function call(path: string, token: string | null, init: { method?: string; body?: unknown; origin?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: init.origin ?? APP };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.request(`/api/v2/end-user-session${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function insertApproval(id: string, endUserId: string | null, decidedBy: "team" | "end_user", extra: { expired?: boolean; kind?: string; payload?: unknown; env?: string } = {}) {
  await sql(
    `INSERT INTO approvals (workspace_id, environment_id, approval_id, kind, status, title, description, payload, expires_at, end_user_id, decided_by)
     VALUES ($1, $2, $3, $4, 'pending', 'Send the email', 'Send one email from the user''s own Gmail.', $5, now() + ($6 || ' seconds')::interval, $7, $8)`,
    [ws, extra.env ?? env, id, extra.kind ?? "custom", JSON.stringify(extra.payload ?? { to: "sam@example.com" }), extra.expired ? "-60" : "86400", endUserId, decidedBy],
  );
}

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Acme', 'acme-sessions')", [ws]);
  await sql(
    `INSERT INTO environments (id, workspace_id, name, slug, kind, allowed_redirect_urls, default_redirect_url)
     VALUES ($1, $3, 'Production', 'prod', 'production', ARRAY['${APP}/connected'], '${APP}/connected'),
            ($2, $3, 'Dev', 'dev', 'development', ARRAY['http://localhost:3000/connected'], NULL)`,
    [env, otherEnv, ws],
  );
  await sql(
    `INSERT INTO api_keys (id, workspace_id, environment_id, name, key_hash, key_prefix, is_active)
     VALUES ($1, $4, $5, 'app', 'hash_app', 'anlyon_a', 'true'),
            ($2, $4, $5, 'revoked', 'hash_revoked', 'anlyon_r', 'false'),
            ($3, $4, $6, 'dev', 'hash_dev', 'anlyon_d', 'true')`,
    [keyId, revokedKeyId, otherEnvKeyId, ws, env, otherEnv],
  );
}, 120_000);

beforeEach(async () => {
  state.store.clear();
  vi.spyOn(keyCheck, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  await sql("DELETE FROM oauth_connections");
  await sql("DELETE FROM approval_decisions");
  await sql("DELETE FROM approvals");
});

describe("minting a session", () => {
  it("returns a 15-minute eus_ token for the end user, with both capabilities from a key that has both scopes", async () => {
    const res = await mint("alice@acme.test");
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { data } = (await res.json()) as { data: { token: string; expiresAt: string; endUserId: string; capabilities: string[] } };
    expect(data.token.startsWith("eus_v1.")).toBe(true);
    expect(data.endUserId).toBe("alice@acme.test");
    expect(data.capabilities).toEqual(["connections", "approvals"]);
    const minutes = (new Date(data.expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14.9);
    expect(minutes).toBeLessThanOrEqual(15);
  });

  it("takes a shorter lifetime, refuses one over an hour, and never outlives the key", async () => {
    const short = (await (await mint("alice", { body: { ttlSeconds: 120 } })).json()) as { data: { expiresAt: string } };
    expect(new Date(short.data.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(120_000);
    expect((await mint("alice", { body: { ttlSeconds: 7200 } })).status).toBe(400);
    expect((await mint("alice", { body: { ttlSeconds: 10 } })).status).toBe(400);
    const soon = new Date(Date.now() + 90_000).toISOString();
    const capped = (await (await mint("alice", { headers: { "x-test-key-expires": soon } })).json()) as { data: { expiresAt: string } };
    expect(new Date(capped.data.expiresAt).getTime()).toBeLessThanOrEqual(new Date(soon).getTime());
  });

  it("gives approvals only to a key that may decide them, and needs end-users:write", async () => {
    const res = await mint("alice", { headers: { "x-test-scopes": "end-users:write" } });
    expect(((await res.json()) as { data: { capabilities: string[] } }).data.capabilities).toEqual(["connections"]);
    expect((await mint("alice", { headers: { "x-test-scopes": "end-users:read,end-users:approvals" } })).status).toBe(403);
  });

  it("is for API keys only, and checks the end-user id", async () => {
    for (const authType of ["session", "oauth"]) {
      const res = await mint("alice", { headers: { "x-test-auth": authType } });
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("END_USER_SESSION_API_KEY_REQUIRED");
    }
    const bad = await mint("has space");
    expect(bad.status).toBe(400);
    expect(await code(bad)).toBe("INVALID_END_USER");
  });

  it("is audited without the token", async () => {
    const token = await tokenFor("audit-me");
    await flushAuditEvents();
    const { rows } = await sql("SELECT type, end_user_id, data, actor_type, actor_id FROM audit_events WHERE type = 'end_user.session_created' AND end_user_id = 'audit-me'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "api_key", actor_id: keyId });
    expect(JSON.stringify(rows[0])).not.toContain(token.split(".")[2]);
  });
});

describe("what a session may do", () => {
  it("lists only its own end user's connections, with names, and never a token", async () => {
    const actor = { type: "api_key" as const, id: keyId };
    await connections.setEndUserApiKey(scope, "alice", "github", "ghp_alice_token_000000", actor);
    await connections.setEndUserApiKey(scope, "bob", "notion", "secret_bob_token_000000", actor);
    const res = await call("/connections", await tokenFor("alice"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("ghp_alice");
    const { data } = JSON.parse(body) as { data: Array<{ integration: string; displayName: string; status: string }> };
    expect(data).toEqual([expect.objectContaining({ integration: "github", displayName: "GitHub", status: "active" })]);
  });

  it("creates a connect link that returns only to an allowed redirect URL", async () => {
    const token = await tokenFor("alice");
    const ok = await call("/connect-links", token, { method: "POST", body: { integration: "github", redirectUrl: `${APP}/connected?anlyon_popup=1` } });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { data: { url: string } }).data.url).toMatch(/^https:\/\/api\.anlyon\.test\//);
    const evil = await call("/connect-links", token, { method: "POST", body: { integration: "github", redirectUrl: "https://evil.test/connected" } });
    expect(evil.status).toBe(400);
    expect(await code(evil)).toBe("REDIRECT_URL_NOT_ALLOWED");
  });

  it("creates a connect link for the mcp-<id> key a 409 names, for a live OAuth MCP server in its environment only", async () => {
    const insert = async (upstreamId: string, environmentId: string, name: string) => ((await sql(
      `INSERT INTO mcp_upstreams (upstream_id, workspace_id, environment_id, name, url, oauth) VALUES ($1, $2, $3, $4, 'https://mcp.tracker.test/mcp', $5) RETURNING id`,
      [upstreamId, ws, environmentId, name, JSON.stringify({
        resource: "https://mcp.tracker.test/mcp", issuer: "https://auth.tracker.test", authorizationEndpoint: "https://auth.tracker.test/authorize",
        tokenEndpoint: "https://auth.tracker.test/token", scopesSupported: [], scopes: [], clientRegistration: "pre_registered", clientId: "tracker-client",
        clientSecretName: null, advertised: { dynamicRegistration: false, clientIdMetadataDocuments: false, pkceS256: true },
      })],
    )).rows[0] as { id: string }).id;
    const here = upstreamOAuth.upstreamIntegrationKey(await insert("mcpu_session_here", env, "Tracker"));
    const elsewhere = upstreamOAuth.upstreamIntegrationKey(await insert("mcpu_session_elsewhere", otherEnv, "Tracker"));
    setConnectionProviderForTests(createNativeProvider({ origin: "https://api.anlyon.test", encryptionKey: "test-connections-encryption-key-32chars", upstreamApp: upstreamOAuth.upstreamApp }));
    try {
      const token = await tokenFor("alice");
      const ok = await call("/connect-links", token, { method: "POST", body: { integration: here } });
      expect(ok.status).toBe(201);
      expect(((await ok.json()) as { data: { url: string; integration: string } }).data).toMatchObject({ integration: here, url: expect.stringMatching(/^https:\/\/api\.anlyon\.test\//) });
      for (const integration of [elsewhere, "mcp-00000000-0000-4000-8000-000000000000"]) {
        expect((await call("/connect-links", token, { method: "POST", body: { integration } })).status).toBe(400);
      }
      await sql("UPDATE mcp_upstreams SET archived_at = now() WHERE upstream_id = 'mcpu_session_here'");
      expect((await call("/connect-links", token, { method: "POST", body: { integration: here } })).status).toBe(400);
    } finally {
      setConnectionProviderForTests(undefined);
    }
  });

  it("disconnects its own end user's account, and not another's", async () => {
    const actor = { type: "api_key" as const, id: keyId };
    await connections.setEndUserApiKey(scope, "alice", "github", "ghp_alice_token_000000", actor);
    await connections.setEndUserApiKey(scope, "bob", "github", "ghp_bob_token_00000000", actor);
    const token = await tokenFor("alice");
    expect((await call("/connections/github", token, { method: "DELETE" })).status).toBe(200);
    expect(await connections.listEndUserConnections(scope, "alice")).toEqual([]);
    expect(await connections.listEndUserConnections(scope, "bob")).toHaveLength(1);
    expect((await call("/connections/github", token, { method: "DELETE" })).status).toBe(404);
    expect(await connections.listEndUserConnections(scope, "bob")).toHaveLength(1);
  });

  it("lists and reads only its own end user's approvals, without internal ids", async () => {
    await insertApproval("apr_alice", "alice", "end_user", {
      kind: "action",
      payload: { actionName: "gmail-send", actionId: "act_1", invocationId: "inv_1", urlTemplate: "https://internal.test/x", method: "POST", input: { to: "sam@example.com" } },
    });
    await insertApproval("apr_bob", "bob", "end_user");
    await insertApproval("apr_alice_team", "alice", "team");
    const token = await tokenFor("alice");

    const list = await call("/approvals?status=pending", token);
    expect(list.status).toBe(200);
    const text = await list.text();
    for (const hidden of ["internal.test", "inv_1", "act_1", keyId, "matchedPolicyId", "decidedBy"]) expect(text).not.toContain(hidden);
    const { data } = JSON.parse(text) as { data: Array<Record<string, unknown>> };
    expect(data).toEqual([expect.objectContaining({ id: "apr_alice", status: "pending", actionName: "gmail-send", input: { to: "sam@example.com" }, preview: null })]);

    expect((await call("/approvals/apr_alice", token)).status).toBe(200);
    expect((await call("/approvals/apr_bob", token)).status).toBe(404);
    expect((await call("/approvals/apr_alice_team", token)).status).toBe(404);
  });

  it("shows the end user the change and whether it can be undone, never the operator's guarantees", async () => {
    const { rows: [action] } = await sql(
      "INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template) VALUES ($1, $2, 'act_preview', 'stripe-refund', 'https://api.stripe.com') RETURNING id",
      [ws, env],
    );
    const head = {
      type: "fields", title: "Execution target",
      fields: [{ label: "Environment", value: "Production (production)" }, { label: "Adapter", value: "stripe.refund v1" }, { label: "Success means", value: "A refund succeeds." }],
    };
    const impact = { type: "impact", title: "Expected impact: 1 reminders", quantities: [{ dimension: "money", currency: "usd", amount: 1290, bound: "exact" }] };
    const limitations = {
      type: "limitations", title: "What is supported and what is not",
      items: [{ kind: "unsupported", text: "Not supported: Provider idempotency" }, { kind: "unsupported", text: "Recovery: No verify rule is declared" }],
    };
    const insertPreview = (previewId: string, adapterType: string, blocks: unknown[], reversible: boolean, account: string) => sql(
      `INSERT INTO effect_previews (workspace_id, environment_id, action_id, preview_id, action_name, action_version_id, adapter_type, adapter_version,
         request_digest, binding_digest, target_account, resource_key, target, request, input, impact, evidence, blocks, preconditions, capabilities,
         evidence_observed_at, expires_at, end_user_id)
       VALUES ($1, $2, $3, $4, 'stripe-refund', 'acv_1', $5, '1', 'rd', 'bd', $6, 'res', $7, '{}', '{}', $8, '{}', $9, '{}', $10, now(), now() + interval '1 hour', 'alice')`,
      [ws, env, action!.id, previewId, adapterType, account, JSON.stringify({ account, display: { customer: "Sam" } }),
        JSON.stringify(impact.quantities), JSON.stringify(blocks), JSON.stringify({ reversible: { supported: reversible, description: "Refunds are irreversible." } })],
    );
    const refund = { type: "fields", title: "Refund", fields: [{ label: "Refund amount", value: "12.90 USD" }, { label: "Fault drill", value: "Test key drill" }] };
    await insertPreview("prv_refund", "stripe.refund", [head, refund, impact, limitations], false, "acct_1");
    const request = { type: "fields", title: "Request", fields: [{ label: "Method", value: "POST" }, { label: "Read-back", value: "none declared" }] };
    await insertPreview("prv_declared", "http.declared", [head, request, impact, limitations], false, "app.acme.test");
    await insertApproval("apr_refund", "alice", "end_user", { kind: "action", payload: { actionName: "stripe-refund", previewId: "prv_refund", input: { amount: 1290 } } });
    await insertApproval("apr_declared", "alice", "end_user", { kind: "action", payload: { actionName: "acme-remind", previewId: "prv_declared", input: { text: "Review the plan" } } });
    const token = await tokenFor("alice");

    const res = await call("/approvals/apr_refund", token);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const hidden of ["Execution target", "Adapter", "Success means", "Not supported", "Recovery", "Fault drill", "limitations", "Expected impact"]) {
      expect(text, hidden).not.toContain(hidden);
    }
    const { data } = JSON.parse(text) as { data: { preview: Record<string, unknown> } };
    expect(data.preview).toMatchObject({
      target: { account: "acct_1", display: { customer: "Sam" } },
      blocks: [{ type: "fields", title: "Refund", fields: [{ label: "Refund amount", value: "12.90 USD" }] }],
      impact: [{ dimension: "money", currency: "usd", amount: 1290, bound: "exact" }],
      reversible: false,
      undo: "This can't be undone once it runs.",
    });

    const declared = (await (await call("/approvals/apr_declared", token)).json()) as { data: { input: unknown; preview: Record<string, unknown> } };
    expect(declared.data.input).toEqual({ text: "Review the plan" });
    expect(declared.data.preview).toMatchObject({ target: { account: null }, blocks: [], reversible: false });
  });

  it("decides its own end user's approval through the end-user path, and records how", async () => {
    await insertApproval("apr_alice", "alice", "end_user");
    const token = await tokenFor("alice");
    const res = await call("/approvals/apr_alice/decide", token, { method: "POST", body: { decision: "deny", reason: "Not this one" } });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { approval: { status: string; decisionNote: string } } };
    expect(data.approval).toMatchObject({ status: "denied", decisionNote: "Not this one" });
    const { rows: [vote] } = await sql("SELECT d.decider_key_id FROM approval_decisions d JOIN approvals a ON a.id = d.approval_id WHERE a.approval_id = 'apr_alice'");
    expect(vote.decider_key_id).toBe(keyId);
    await flushAuditEvents();
    const { rows: [audit] } = await sql("SELECT data, end_user_id FROM audit_events WHERE type = 'approval.vote' AND resource_id = 'apr_alice'");
    expect(audit).toMatchObject({ end_user_id: "alice", data: expect.objectContaining({ via: "end_user_session", decision: "deny" }) });
    expect((await call("/approvals/apr_alice/decide", token, { method: "POST", body: { decision: "approve" } })).status).toBe(409);
  });

  it("refuses another end user's approval, a team approval and an expired one", async () => {
    await insertApproval("apr_bob", "bob", "end_user");
    await insertApproval("apr_alice_team", "alice", "team");
    await insertApproval("apr_alice_old", "alice", "end_user", { expired: true });
    const token = await tokenFor("alice");
    for (const id of ["apr_bob", "apr_alice_team"]) {
      const res = await call(`/approvals/${id}/decide`, token, { method: "POST", body: { decision: "approve" } });
      expect(res.status, id).toBe(404);
    }
    const old = await call("/approvals/apr_alice_old/decide", token, { method: "POST", body: { decision: "approve" } });
    expect(old.status).toBe(409);
    const { rows } = await sql("SELECT approval_id, status FROM approvals ORDER BY approval_id");
    expect(rows).toEqual([
      { approval_id: "apr_alice_old", status: "expired" },
      { approval_id: "apr_alice_team", status: "pending" },
      { approval_id: "apr_bob", status: "pending" },
    ]);
  });

  it("needs the approvals capability for approvals", async () => {
    await insertApproval("apr_alice", "alice", "end_user");
    const token = await tokenFor("alice", { "x-test-scopes": "end-users:write" });
    for (const [method, path] of [["GET", "/approvals"], ["GET", "/approvals/apr_alice"], ["POST", "/approvals/apr_alice/decide"]] as const) {
      const res = await call(path, token, { method, body: method === "POST" ? { decision: "approve" } : undefined });
      expect(res.status, path).toBe(403);
      expect(await code(res)).toBe("END_USER_SESSION_SCOPE");
    }
    expect((await call("/connections", token)).status).toBe(200);
  });

  it("has no other routes, and is refused everywhere else", async () => {
    const token = await tokenFor("alice");
    for (const [method, path] of [
      ["POST", "/connections/confirm"], ["PUT", "/connections/github"], ["DELETE", ""], ["POST", "/sessions"], ["GET", "/end-users"],
    ] as const) {
      const res = await call(path, token, { method, body: method === "GET" || method === "DELETE" ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const elsewhere = await app.request("/api/v2/actions/list", { headers: { authorization: `Bearer ${token}` } });
    expect(elsewhere.status).toBe(403);
    expect(await code(elsewhere)).toBe("END_USER_SESSION_NOT_ALLOWED");
  });
});

describe("the token", () => {
  const claims = { workspaceId: ws, environmentId: env, endUserId: "alice", keyId, capabilities: ["connections", "approvals"] as Array<"connections" | "approvals"> };

  it("is required", async () => {
    const res = await call("/connections", null);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("END_USER_SESSION_REQUIRED");
  });

  it("expires", async () => {
    const { token } = mintSessionToken(claims, 60, Date.now() - 2 * 3600_000);
    const res = await call("/connections", token);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("END_USER_SESSION_EXPIRED");
  });

  it("cannot be changed to name another end user, or forged", async () => {
    const token = await tokenFor("alice");
    const [prefix, payload, mac] = token.split(".") as [string, string, string];
    const tampered = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    tampered.eu = "bob";
    const forged = `${prefix}.${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${mac}`;
    for (const bad of [forged, `${prefix}.${payload}.${"A".repeat(mac.length)}`, "eus_v1.e30.AAAA", "eus_garbage"]) {
      const res = await call("/connections", bad);
      expect(res.status, bad.slice(0, 20)).toBe(401);
      expect(await code(res)).toBe("END_USER_SESSION_INVALID");
    }
  });

  it("stops working when its key is revoked", async () => {
    const { token } = mintSessionToken({ ...claims, keyId: revokedKeyId }, 600);
    const res = await call("/connections", token);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("END_USER_SESSION_INVALID");
  });

  it("is held to its own environment", async () => {
    const crossed = mintSessionToken({ ...claims, environmentId: otherEnv }, 600).token;
    expect(await code(await call("/connections", crossed))).toBe("END_USER_SESSION_INVALID");
    await insertApproval("apr_alice", "alice", "end_user");
    const devToken = await tokenFor("alice", { "x-test-key": otherEnvKeyId, "x-test-env": otherEnv });
    const res = await call("/approvals", devToken, { origin: "http://localhost:3000" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
    expect((await call("/approvals/apr_alice/decide", devToken, { method: "POST", body: { decision: "approve" }, origin: "http://localhost:3000" })).status).toBe(404);
  });

  it("stops working when its end user is erased, while a token minted afterwards works", async () => {
    const before = mintSessionToken({ ...claims, endUserId: "carol" }, 600).token;
    expect((await call("/connections", before)).status).toBe(200);
    await connections.eraseEndUser(scope, "carol", { type: "api_key", id: keyId }, async () => 0);
    const res = await call("/connections", before);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("END_USER_SESSION_INVALID");
    const after = mintSessionToken({ ...claims, endUserId: "carol" }, 600, Date.now() + 2000).token;
    expect((await call("/connections", after)).status).toBe(200);
  });
});

describe("CORS", () => {
  it("answers an allowed origin, and never with credentials", async () => {
    const res = await call("/connections", await tokenFor("alice"));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
    expect(res.headers.get("vary")).toContain("Origin");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("refuses any other origin before doing anything", async () => {
    await insertApproval("apr_alice", "alice", "end_user");
    const token = await tokenFor("alice");
    for (const origin of ["https://evil.test", "https://app.acme.test.evil.test", "http://app.acme.test"]) {
      const res = await call("/approvals/apr_alice/decide", token, { method: "POST", body: { decision: "approve" }, origin });
      expect(res.status, origin).toBe(403);
      expect(await code(res)).toBe("ORIGIN_NOT_ALLOWED");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect((await sql("SELECT status FROM approvals WHERE approval_id = 'apr_alice'")).rows[0].status).toBe("pending");
  });

  it("serves a server with no Origin, and lets any origin read that a token must be refreshed", async () => {
    const res = await app.request("/api/v2/end-user-session/connections", { headers: { authorization: `Bearer ${await tokenFor("alice")}` } });
    expect(res.status).toBe(200);
    const expired = mintSessionToken({ workspaceId: ws, environmentId: env, endUserId: "alice", keyId, capabilities: ["connections"] }, 60, Date.now() - 3600_000).token;
    const refused = await call("/connections", expired, { origin: "https://evil.test" });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBe("https://evil.test");
  });

  it("answers a preflight for the session routes only, without credentials", async () => {
    const preflight = await app.request("/api/v2/end-user-session/approvals/apr_1/decide", {
      method: "OPTIONS",
      headers: { origin: APP, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(APP);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
    const other = await app.request("/api/v2/end-users/alice/sessions", {
      method: "OPTIONS",
      headers: { origin: APP, "access-control-request-method": "POST" },
    });
    expect(other.headers.get("access-control-allow-origin")).not.toBe(APP);
  });
});
