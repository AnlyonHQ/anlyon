import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";
process.env.INTERNAL_AUTH_SECRET ??= "internal-auth-test-secret-0000000000000";

let available = false;

beforeAll(async () => {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    await probe.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.end().catch(() => {});
  }
});

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("release journeys (real stack, HTTP)", () => {
  let pool: Pool;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let keys: typeof import("../src/core/auth/api-keys.ts");
  let scopes: typeof import("../src/core/auth/api-key-scopes.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");
  let agentsSvc: typeof import("../src/core/agents/service.ts");
  let policySvc: typeof import("../src/core/approvals/policy.ts");
  let EventsFanoutWorker: typeof import("../src/workers/events.ts").EventsFanoutWorker;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = (await import("../src/api/index.ts")).default as typeof app;
    keys = await import("../src/core/auth/api-keys.ts");
    scopes = await import("../src/core/auth/api-key-scopes.ts");
    envSvc = await import("../src/core/environments/service.ts");
    agentsSvc = await import("../src/core/agents/service.ts");
    policySvc = await import("../src/core/approvals/policy.ts");
    EventsFanoutWorker = (await import("../src/workers/events.ts")).EventsFanoutWorker;
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  async function freshAccount() {
    const userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'T', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    const ws = await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('J', $1, 'enterprise') RETURNING id`, [
      `ws-${randomUUID().slice(0, 8)}`,
    ]);
    const workspaceId = ws.rows[0].id;
    const env = await envSvc.ensureDefaultEnvironment(workspaceId);
    const { key } = await keys.createApiKey(workspaceId, userId, "journey-key", undefined, undefined, env.id);
    return { userId, workspaceId, environmentId: env.id, key };
  }

  const authed = (key: string, init: RequestInit = {}) => ({
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

  it("journey 1: issue a scoped key and authenticate against the API", async () => {
    const acc = await freshAccount();
    const res = await app.request("/api/v2/runs", authed(acc.key));
    expect(res.status).toBe(200);
    const anon = await app.request("/api/v2/runs");
    expect(anon.status).toBe(401);
  });

  it("journey 3: report a run with spans from a key and inspect the full trace", async () => {
    const acc = await freshAccount();

    const started = await app.request(
      "/api/v2/runs",
      authed(acc.key, {
        method: "POST",
        headers: { "X-Request-Id": "customer-trace_123" },
        body: JSON.stringify({ name: "nightly-summary" }),
      }),
    );
    expect(started.status).toBe(201);
    const runId = (await started.json()).data.id as string;

    const ingest = await app.request(
      `/api/v2/runs/${runId}/spans`,
      authed(acc.key, {
        method: "POST",
        headers: { "X-Request-Id": "customer-trace_123" },
        body: JSON.stringify({
          spans: [
            { id: "root", name: "plan", type: "model_call", startedAt: "2026-07-15T00:00:00Z", endedAt: "2026-07-15T00:00:01Z" },
            { id: "tool", parentId: "root", name: "search", type: "tool_call", startedAt: "2026-07-15T00:00:01Z" },
          ],
        }),
      }),
    );
    expect((await ingest.json()).data.ingested).toBe(2);

    await app.request(
      `/api/v2/runs/${runId}`,
      authed(acc.key, { method: "PATCH", body: JSON.stringify({ status: "succeeded", tokens: 120 }) }),
    );

    const trace = await app.request(`/api/v2/runs/${runId}`, authed(acc.key));
    const run = (await trace.json()).data;
    expect(run.status).toBe("succeeded");
    expect(run.tokens).toBe(120);
    expect(run.metadata.requestId).toBe("customer-trace_123");
    expect(run.spans[0].id).toBe("root");
    expect(run.spans[0].children[0].id).toBe("tool");
    expect(run.spans[0].attributes.requestId).toBe("customer-trace_123");

    const exported = await app.request(`/api/v2/runs/${runId}/export`, authed(acc.key));
    expect(exported.status).toBe(200);
    const imported = await app.request(
      "/api/v2/runs/import",
      authed(acc.key, {
        method: "POST",
        headers: { "Idempotency-Key": `import-${randomUUID()}` },
        body: JSON.stringify((await exported.json()).data),
      }),
    );
    expect(imported.status).toBe(201);
    const importedRun = (await imported.json()).data;
    expect(importedRun.id).not.toBe(runId);
    expect(importedRun.environmentId).toBe(acc.environmentId);
    expect(importedRun.metadata.sourceRequestId).toBe("customer-trace_123");

    const fb = await app.request(
      `/api/v2/runs/${runId}/feedback`,
      authed(acc.key, { method: "POST", body: JSON.stringify({ label: "thumbs_up", rating: 1 }) }),
    );
    expect(fb.status).toBe(201);
  });

  it("event fan-out persists trace context and emits a correlated event_delivery span", async () => {
    const acc = await freshAccount();
    const started = await app.request(
      "/api/v2/runs",
      authed(acc.key, { method: "POST", body: JSON.stringify({ name: "event-trace" }) }),
    );
    const traceRunId = (await started.json()).data.id as string;
    await app.request(
      `/api/v2/runs/${traceRunId}/spans`,
      authed(acc.key, {
        method: "POST",
        body: JSON.stringify({ spans: [{ id: "event-parent", name: "publish", startedAt: "2026-07-15T00:00:00Z" }] }),
      }),
    );

    const topic = await app.request(
      "/api/v2/events/topics",
      authed(acc.key, { method: "POST", body: JSON.stringify({ name: "orders" }) }),
    );
    expect(topic.status).toBe(201);
    const topicId = (await topic.json()).data.id as string;
    const subscription = await app.request(
      `/api/v2/events/topics/${topicId}/subscriptions`,
      authed(acc.key, { method: "POST", body: JSON.stringify({ url: "https://example.test/event-hook" }) }),
    );
    expect(subscription.status).toBe(201);

    const published = await app.request(
      "/api/v2/events",
      authed(acc.key, {
        method: "POST",
        body: JSON.stringify({
          topic: topicId,
          type: "order.created",
          data: { orderId: "order_1" },
          runId: traceRunId,
          parentSpanId: "event-parent",
        }),
      }),
    );
    expect(published.status).toBe(202);
    const eventId = (await published.json()).data.id as string;
    const stored = await pool.query(`SELECT id FROM events WHERE event_id = $1`, [eventId]);

    const worker = new EventsFanoutWorker(99);
    await (worker as unknown as { fanOut(eventInternalId: string, workspaceId: string): Promise<void> })
      .fanOut(stored.rows[0].id, acc.workspaceId);

    const trace = await app.request(`/api/v2/runs/${traceRunId}`, authed(acc.key));
    const rootSpan = (await trace.json()).data.spans.find((span: { id: string }) => span.id === "event-parent");
    expect(rootSpan.children).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `event_${eventId}`,
        name: "order.created",
        type: "event_delivery",
        status: "succeeded",
        attributes: expect.objectContaining({ eventId, topic: "orders", deliveryCount: 1, fanoutStatus: "fanned_out" }),
      }),
    ]));
  });

  it("journey 4: trigger an approval and decide it, enforcing self-approval and policy", async () => {
    const acc = await freshAccount();
    const started = await app.request(
      "/api/v2/runs",
      authed(acc.key, { method: "POST", body: JSON.stringify({ name: "approval-trace" }) }),
    );
    const traceRunId = (await started.json()).data.id as string;
    await app.request(
      `/api/v2/runs/${traceRunId}/spans`,
      authed(acc.key, {
        method: "POST",
        body: JSON.stringify({ spans: [{ id: "approval-parent", name: "plan", type: "tool_call", startedAt: new Date().toISOString() }] }),
      }),
    );
    const { key: approverKey } = await keys.createApiKey(
      acc.workspaceId,
      acc.userId,
      "approver",
      undefined,
      [...scopes.DEFAULT_API_KEY_SCOPES, "approvals:decide"],
      acc.environmentId,
    );

    const created = await app.request(
      "/api/v2/approvals",
      authed(acc.key, {
        method: "POST",
        body: JSON.stringify({ title: "Ship release", runId: traceRunId, parentSpanId: "approval-parent" }),
      }),
    );
    expect(created.status).toBe(201);
    const approvalId = (await created.json()).data.id as string;

    const self = await app.request(
      `/api/v2/approvals/${approvalId}/approve`,
      authed(acc.key, { method: "POST", body: JSON.stringify({}) }),
    );
    expect(self.status).toBe(403);

    const decided = await app.request(
      `/api/v2/approvals/${approvalId}/approve`,
      authed(approverKey, { method: "POST", body: JSON.stringify({}) }),
    );
    expect(decided.status).toBe(200);
    expect((await decided.json()).data.approval.status).toBe("approved");

    const trace = await app.request(`/api/v2/runs/${traceRunId}`, authed(acc.key));
    const parent = (await trace.json()).data.spans.find((span: { id: string }) => span.id === "approval-parent");
    expect(parent.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `approval_${approvalId}`, type: "approval_wait", status: "succeeded" }),
    ]));
  });

  it("journey 10: promote an agent to production and roll back safely", async () => {
    const acc = await freshAccount();
    const prod = await envSvc.createEnvironment(acc.workspaceId, {
      name: "Production2",
      slug: "production2",
      isProtected: true,
    });
    const { agent } = await agentsSvc.createAgent(
      acc.workspaceId,
      { name: "releaser", environmentId: acc.environmentId, config: { model: "v1" } },
      acc.userId,
    );

    await expect(agentsSvc.promoteAgent(acc.workspaceId, agent.id, prod.id, acc.userId)).rejects.toThrow(
      /protected/,
    );

    const promoted = await agentsSvc.promoteAgent(acc.workspaceId, agent.id, prod.id, acc.userId, {
      confirmProtected: true,
    });
    expect(promoted.agent.environmentId).toBe(prod.id);
    expect(promoted.version.config).toEqual({ model: "v1" });

    await agentsSvc.createAgentVersion(acc.workspaceId, agent.id, { config: { model: "v2" }, publish: true });
    const promoted2 = await agentsSvc.promoteAgent(acc.workspaceId, agent.id, prod.id, acc.userId, {
      confirmProtected: true,
    });
    expect(promoted2.version.version).toBe(2);

    const rolledBack = await agentsSvc.updateAgent(acc.workspaceId, promoted2.agent.id, { currentVersion: 1 });
    expect(rolledBack.currentVersion).toBe(1);
    const versions = await agentsSvc.listAgentVersions(acc.workspaceId, promoted2.agent.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);

    expect(promoted2.version.config).toEqual({ model: "v2" });
  });
});
