import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.hoisted(() => {
  process.env.CONNECTIONS_ENCRYPTION_KEY ??= "test-connections-encryption-key-32chars";
});

vi.mock("../src/api/governance-gate.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), signOffIfLoosening: async () => null }));
vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  const { providerFetch } = await import("./support/effects/provider-fetch.ts");
  return { ...actual, safeFetch: providerFetch };
});

const ATTIO_HOST = "api.attio.com";
const ALICE_KEY = "attio_alice_key_0000000000000000";
const root = resolve(__dirname, "../..");
const manifest = (name: string) => JSON.parse(readFileSync(resolve(root, `packs/${name}/pack.json`), "utf8"));

class FakeAttio {
  readonly keys = new Set<string>([ALICE_KEY]);
  readonly notes = new Map<string, Record<string, unknown>>();
  readonly requests: Array<{ method: string; path: string; authorization: string }> = [];

  fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const authorization = headers.authorization ?? "";
    this.requests.push({ method, path: u.pathname, authorization });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (!this.keys.has(authorization.replace(/^Bearer /, ""))) return json(401, { status_code: 401, type: "auth_error" });

    if (method === "GET" && u.pathname === "/v2/self") return json(200, { active: true, workspace_id: "ws_fake" });
    if (method === "POST" && u.pathname === "/v2/notes") {
      const { data } = JSON.parse(init.body ?? "{}") as { data: Record<string, unknown> };
      const noteId = randomUUID();
      const note = { id: { workspace_id: "ws_fake", note_id: noteId }, ...data, content_plaintext: data.content };
      this.notes.set(noteId, note);
      return json(200, { data: note });
    }
    const one = /^\/v2\/notes\/([0-9a-f-]{36})$/.exec(u.pathname);
    if (method === "GET" && one) {
      const note = this.notes.get(one[1]!);
      return note ? json(200, { data: note }) : json(404, { status_code: 404, type: "invalid_request_error" });
    }
    return json(404, { status_code: 404, type: "invalid_request_error" });
  };

  writes() {
    return this.requests.filter((r) => r.method !== "GET");
  }
}

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("a pack's governed write for an end user (real Postgres and Redis)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const attio = new FakeAttio();
  let app: { request: (url: string, init?: RequestInit) => Promise<Response> };
  let userId: string;
  let workspaceId: string;
  let environmentId: string;
  let key: string;

  const api = (path: string, init: { method?: string; endUser?: string; body?: unknown } = {}) =>
    app.request(`/api/v2${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.endUser ? { "Anlyon-End-User": init.endUser } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  const note = { record_id: "891dcbfc-9141-415d-9b2a-2238a6cc012d", title: "Refund issued", content: "Refunded order 1042 in full." };

  beforeAll(async () => {
    const { setProviderFetchForHost } = await import("./support/effects/provider-fetch.ts");
    setProviderFetchForHost(ATTIO_HOST, attio.fetch);
    app = (await import("../src/api/index.ts")).default as typeof app;
    const keys = await import("../src/core/auth/api-keys.ts");
    const envs = await import("../src/core/environments/service.ts");
    const sdk = await import("../../sdks/typescript/sdk/src/index.ts");

    userId = `user_${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'T', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`]);
    workspaceId = (await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('End-user pack', $1, 'enterprise') RETURNING id`,
      [`eu-${randomUUID().slice(0, 8)}`])).rows[0].id;
    environmentId = (await envs.ensureDefaultEnvironment(workspaceId)).id;
    const scopes = ["secrets:read", "secrets:write", "actions:read", "actions:write", "actions:invoke", "actions:govern", "policies:read", "policies:write", "impact-limits:read", "end-users:read", "end-users:write"];
    ({ key } = await keys.createApiKey(workspaceId, userId, "end-user-pack", undefined, scopes as never, environmentId));

    const client = new sdk.Client({
      apiKey: key,
      baseUrl: "http://anlyon.test",
      retry: { maxAttempts: 1 },
      fetch: ((url: string, init: RequestInit) => app.request(new URL(url).pathname + new URL(url).search, init)) as typeof fetch,
    });
    const installed = await client.packs.install(manifest("attio"), { actions: ["add-note"] });
    expect(installed.steps.map((s: { kind: string; name: string; outcome: string }) => `${s.kind}:${s.name}:${s.outcome}`)).toContain("action:attio-add-note:created");
  }, 120_000);

  beforeEach(() => {
    attio.requests.length = 0;
  });

  afterAll(async () => {
    const { clearProviderFetch } = await import("./support/effects/provider-fetch.ts");
    clearProviderFetch();
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await pool.end();
  });

  it("stores alice's own key, checked with the provider first", async () => {
    const res = await api("/end-users/alice/connections/attio", { method: "PUT", body: { token: ALICE_KEY } });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(attio.requests).toEqual([{ method: "GET", path: "/v2/self", authorization: `Bearer ${ALICE_KEY}` }]);
  });

  it("sends alice's key for her call, reads the write back, and records an invocation and a receipt for alice", async () => {
    const res = await api("/actions/attio-add-note/invoke", { method: "POST", endUser: "alice", body: { input: note } });
    const body = await res.json() as { data: { id: string; status: string; effectId: string; grade: string } };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.data).toMatchObject({ status: "succeeded", grade: "confirmed" });

    expect(attio.requests.map((r) => `${r.method} ${r.path.replace(/[0-9a-f-]{36}$/, ":id")}`)).toEqual(["POST /v2/notes", "GET /v2/notes/:id"]);
    expect(attio.requests.every((r) => r.authorization === `Bearer ${ALICE_KEY}`)).toBe(true);
    expect([...attio.notes.values()].map((n) => n.title)).toContain(note.title);

    const effect = await api(`/actions/effects/${body.data.effectId}`);
    expect(effect.status).toBe(200);
    expect((await effect.json() as { data: unknown }).data).toMatchObject({
      id: body.data.effectId, endUserId: "alice", grade: "confirmed", impact: [expect.objectContaining({ dimension: "resource_mutations", amount: 1 })],
    });

    const listed = await api("/actions/invocations?endUserId=alice");
    const invocations = (await listed.json() as { data: Array<{ id: string; endUserId?: string; effectId: string | null }> }).data;
    expect(invocations.find((i) => i.id === body.data.id)).toMatchObject({ endUserId: "alice", effectId: body.data.effectId });
    const row = (await pool.query("SELECT end_user_id FROM action_effects WHERE effect_id = $1", [body.data.effectId])).rows[0];
    expect(row.end_user_id).toBe("alice");
  });

  it("answers 409 END_USER_NOT_CONNECTED for bob, who has not connected Attio, with nothing sent or recorded", async () => {
    const before = (await pool.query("SELECT count(*)::int AS n FROM action_effects WHERE workspace_id = $1", [workspaceId])).rows[0].n;
    const res = await api("/actions/attio-add-note/invoke", { method: "POST", endUser: "bob", body: { input: note } });
    const body = await res.json() as { error: { code: string; integration: string; endUserId: string } };
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toMatchObject({ code: "END_USER_NOT_CONNECTED", integration: "attio", endUserId: "bob" });

    expect(attio.requests).toEqual([]);
    expect((await pool.query("SELECT count(*)::int AS n FROM action_effects WHERE workspace_id = $1", [workspaceId])).rows[0].n).toBe(before);
    expect((await pool.query("SELECT count(*)::int AS n FROM action_effects WHERE workspace_id = $1 AND end_user_id = 'bob'", [workspaceId])).rows[0].n).toBe(0);
    const listed = await api("/actions/invocations?endUserId=bob");
    const invocations = (await listed.json() as { data: Array<{ status: string }> }).data;
    expect(invocations.filter((i) => i.status === "succeeded")).toEqual([]);
  });
});
