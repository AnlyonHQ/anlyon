import type { PGlite } from "@electric-sql/pglite";
import { gunzipSync } from "node:zlib";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));
const sink = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; method: string; headers: Record<string, string>; body: string | Buffer }>,
  status: 200,
}));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client) };
});
vi.mock("../src/lib/safe-http.ts", () => ({
  SsrfBlockedError: class SsrfBlockedError extends Error {},
  safeFetch: async (url: string, init: { method: string; headers: Record<string, string>; body: string | Buffer }) => {
    sink.requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    return new Response(sink.status === 204 ? null : "", { status: sink.status });
  },
}));
vi.mock("../src/core/environments/service.ts", async () => {
  const { NotFoundError } = await import("../src/utils/errors.ts");
  return {
    getEnvironment: async (workspaceId: string, environmentId: string) => {
      const { rows } = await state.client!.query("SELECT id FROM environments WHERE workspace_id = $1 AND id = $2", [workspaceId, environmentId]);
      if (!rows[0]) throw new NotFoundError("Environment");
      return rows[0];
    },
  };
});

const { flushAuditEvents, recordAuditEvent, recordPlatformEvent, resetAuditRecorderForTest } = await import("../src/core/audit/recorder.ts");
const service = await import("../src/core/audit/service.ts");
const { deliverDueAuditSinks, MAX_ATTEMPTS } = await import("../src/core/audit/delivery.ts");
const { sweepAuditRetention } = await import("../src/core/audit/retention.ts");
const { verifyDeliverySignature } = await import("../src/utils/crypto.ts");
const { createPolicy } = await import("../src/core/approvals/policy.ts");

const ws = "00000000-0000-4000-8000-00000000c0a1";
const prod = "00000000-0000-4000-8000-00000000c0b1";
const staging = "00000000-0000-4000-8000-00000000c0b2";
const admin = { actor: { type: "user" as const, id: "user_admin" }, context: { requestId: "req_test" } };

const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);
const events = async () => (await sql("SELECT * FROM audit_events WHERE workspace_id = $1 ORDER BY seq", [ws])).rows;
const sinkRow = async (sinkId: string) => (await sql("SELECT * FROM audit_sinks WHERE sink_id = $1", [sinkId])).rows[0];
const due = (sinkId: string) => sql("UPDATE audit_sinks SET next_attempt_at = now() - interval '1 second' WHERE sink_id = $1", [sinkId]);
const sentEvents = () =>
  sink.requests.flatMap((request) => (JSON.parse(request.body as string) as { events: Array<{ id: string; type: string }> }).events);

async function record(type: string, environmentId: string | null, data: Record<string, unknown> = {}) {
  const id = recordAuditEvent({ workspaceId: ws, environmentId, type, actor: { type: "user", id: "user_1" }, data });
  await flushAuditEvents();
  return id!;
}

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', 'ws-audit')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug) VALUES ($1, $3, 'prod', 'prod'), ($2, $3, 'staging', 'staging')", [prod, staging, ws]);
}, 120_000);

beforeEach(async () => {
  resetAuditRecorderForTest();
  sink.requests = [];
  sink.status = 200;
  await sql("DELETE FROM audit_sinks WHERE workspace_id = $1", [ws]);
  await state.client!.transaction(async (tx) => {
    await tx.query("SELECT set_config('anlyon.audit_removal', 'retention', true)");
    await tx.query("DELETE FROM audit_events WHERE workspace_id = $1", [ws]);
  });
  await sql("DELETE FROM audit_lifecycle WHERE workspace_id = $1", [ws]);
  await sql("DELETE FROM audit_settings WHERE workspace_id = $1", [ws]);
});

describe("recording", () => {
  it("stores records with a stable id and the inserting transaction", async () => {
    const id = await record("member.added", null, { userId: "user_2" });
    const [row] = await events();
    expect(row.event_id).toBe(id);
    expect(id).toMatch(/^aud_/);
    expect(row.category).toBe("access");
    expect(Number(row.tx_id)).toBeGreaterThan(0);
  });

  it("buffers only the low-stakes platform events", async () => {
    recordPlatformEvent(ws, "message.delivered", { messageId: "msg_1" });
    recordPlatformEvent(ws, "approval.approved", { environmentId: prod, approvalId: "apr_1" });
    recordPlatformEvent(ws, "secret.disconnected", { environmentId: prod, secretName: "HUBSPOT" });
    await flushAuditEvents();
    const rows = await events();
    expect(rows.map((row) => row.type)).toEqual(["secret.disconnected"]);
    expect(rows[0].environment_id).toBe(prod);
    expect(rows[0].data).not.toHaveProperty("environmentId");
  });

  it("keeps records buffered through a failed flush and writes them on the next", async () => {
    await sql("ALTER TABLE audit_events RENAME TO audit_events_away");
    recordAuditEvent({ workspaceId: ws, type: "member.removed", data: {} });
    await flushAuditEvents();
    await sql("ALTER TABLE audit_events_away RENAME TO audit_events");
    await flushAuditEvents();
    expect((await events()).map((row) => row.type)).toEqual(["member.removed"]);
  });
});

describe("delivery", () => {
  it("sends committed records past the cursor once, signed, then moves the cursor", async () => {
    await record("member.added", null);
    await record("approval.vote", prod, { approvalId: "apr_1", decision: "approve" });
    const { sink: created, signingSecret } = await service.createSink(
      ws, { name: "SIEM", type: "webhook", config: { url: "https://siem.example.com/audit" }, startFrom: "beginning" }, admin,
    );
    expect(signingSecret).toMatch(/^whsec_/);
    await flushAuditEvents();

    await deliverDueAuditSinks();
    expect(sink.requests).toHaveLength(1);
    const [request] = sink.requests;
    expect(verifyDeliverySignature(request.body as string, request.headers["Anlyon-Signature"], signingSecret!).valid).toBe(true);
    expect(sentEvents().map((event) => event.type)).toEqual(["member.added", "approval.vote", "audit.sink.created"]);

    const row = await sinkRow(created.sinkId);
    expect(Number(row.delivered_count)).toBe(3);
    expect(row.attempts).toBe(0);

    await due(created.sinkId);
    await deliverDueAuditSinks();
    expect(sink.requests).toHaveLength(1);
  });

  it("starts a new sink at the present unless asked for history", async () => {
    await record("member.added", null);
    const { sink: created } = await service.createSink(ws, { name: "Now", type: "webhook", config: { url: "https://siem.example.com/a" } }, admin);
    await record("member.removed", null);
    await deliverDueAuditSinks();
    expect(sentEvents().map((event) => event.type)).toEqual(["audit.sink.created", "member.removed"]);
    expect((await service.getSink(ws, created.sinkId)).deliveredCount).toBe(2);
  });

  it("delivers only the types and environments a sink takes, and still moves past the rest", async () => {
    const { sink: created } = await service.createSink(
      ws,
      { name: "Policies", type: "webhook", config: { url: "https://siem.example.com/p" }, eventTypes: ["policy.*", "member.*"], environmentIds: [staging] },
      admin,
    );
    await record("policy.updated", prod);
    await record("policy.updated", staging);
    await record("approval.vote", staging);
    await record("member.added", null);
    await deliverDueAuditSinks();
    expect(sentEvents().map((event) => event.type)).toEqual(["policy.updated", "member.added"]);
    const row = await sinkRow(created.sinkId);
    const [last] = (await sql("SELECT tx_id, seq FROM audit_events WHERE workspace_id = $1 ORDER BY seq DESC LIMIT 1", [ws])).rows;
    expect([row.cursor_tx_id, row.cursor_seq]).toEqual([last.tx_id, last.seq]);
  });

  it("backs off on failure, dead-letters after the last attempt, and keeps going", async () => {
    const { sink: created } = await service.createSink(ws, { name: "Flaky", type: "webhook", config: { url: "https://siem.example.com/f" } }, admin);
    await record("member.added", null);
    sink.status = 500;

    await deliverDueAuditSinks();
    let row = await sinkRow(created.sinkId);
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("HTTP 500");
    expect(new Date(row.next_attempt_at as string).getTime()).toBeGreaterThan(Date.now());
    expect((await service.getSink(ws, created.sinkId)).status).toBe("retrying");

    await sql("UPDATE audit_sinks SET attempts = $2, next_attempt_at = now() - interval '1 second' WHERE sink_id = $1", [created.sinkId, MAX_ATTEMPTS - 1]);
    await deliverDueAuditSinks();
    row = await sinkRow(created.sinkId);
    expect(row.attempts).toBe(0);
    const letters = await service.listDeadLetters(ws, created.sinkId);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ eventCount: 2, attempts: MAX_ATTEMPTS, lastError: "HTTP 500", redeliveredAt: null });
    expect((await service.getSink(ws, created.sinkId)).openDeadLetters).toBe(1);

    sink.status = 200;
    sink.requests = [];
    await record("member.removed", null);
    await due(created.sinkId);
    await deliverDueAuditSinks();
    expect(sentEvents().map((event) => event.type)).toEqual(["member.removed"]);

    sink.requests = [];
    const { result, deadLetter } = await service.redeliverDeadLetter(ws, created.sinkId, letters[0].id, admin);
    expect(result.ok).toBe(true);
    expect(deadLetter.redeliveredAt).not.toBeNull();
    expect(sentEvents().map((event) => event.id)).toEqual([letters[0].firstEventId, letters[0].lastEventId]);
    await expect(service.redeliverDeadLetter(ws, created.sinkId, letters[0].id, admin)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not deliver for a disabled sink", async () => {
    const { sink: created } = await service.createSink(ws, { name: "Off", type: "webhook", config: { url: "https://siem.example.com/o" }, enabled: false }, admin);
    await record("member.added", null);
    await deliverDueAuditSinks();
    expect(sink.requests).toHaveLength(0);
    expect((await service.getSink(ws, created.sinkId)).status).toBe("disabled");
  });

  it("writes S3 objects as gzip NDJSON", async () => {
    await service.createSink(
      ws,
      { name: "Bucket", type: "s3", config: { bucket: "acme-audit", region: "eu-west-1" }, credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "<secret>" } },
      admin,
    );
    await record("member.added", null);
    await deliverDueAuditSinks();
    const [request] = sink.requests;
    expect(request.method).toBe("PUT");
    expect(request.url).toMatch(/^https:\/\/acme-audit\.s3\.eu-west-1\.amazonaws\.com\/anlyon-audit\/\d{4}\/\d{2}\/\d{2}\/\d{6}Z-aud_.+\.ndjson\.gz$/);
    const lines = gunzipSync(request.body as Buffer).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(["audit.sink.created", "member.added"]);
  });
});

describe("sink management", () => {
  it("encrypts credentials, returns only a hint, and records every change", async () => {
    const { sink: created } = await service.createSink(
      ws,
      { name: "DD", type: "datadog", config: { site: "datadoghq.com" }, credentials: { apiKey: "not-a-real-key-1234" } },
      admin,
    );
    const row = await sinkRow(created.sinkId);
    expect(row.credentials_encrypted).not.toContain("not-a-real-key-1234");
    expect(created.credentialsHint).toBe("…1234");
    expect(JSON.stringify(created)).not.toContain("not-a-real-key-1234");

    await service.updateSink(ws, created.sinkId, { enabled: false, credentials: { apiKey: "not-a-real-key-5678" } }, admin);
    await service.deleteSink(ws, created.sinkId, admin);
    await flushAuditEvents();
    const trail = (await events()).filter((event) => String(event.type).startsWith("audit.sink."));
    expect(trail.map((event) => event.type)).toEqual(["audit.sink.created", "audit.sink.updated", "audit.sink.deleted"]);
    expect(trail[1].data).toMatchObject({ changed: ["enabled", "credentials"] });
    expect(JSON.stringify(trail)).not.toContain("not-a-real-key");
    expect(trail.every((event) => event.actor_id === "user_admin")).toBe(true);
  });

  it("rotates a webhook secret and returns the new one once", async () => {
    const { sink: created, signingSecret } = await service.createSink(ws, { name: "W", type: "webhook", config: { url: "https://siem.example.com/w" } }, admin);
    const rotated = await service.updateSink(ws, created.sinkId, { rotateSigningSecret: true }, admin);
    expect(rotated.signingSecret).toMatch(/^whsec_/);
    expect(rotated.signingSecret).not.toBe(signingSecret);
    await expect(service.updateSink(ws, created.sinkId, { credentials: { token: "x" } }, admin)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses an environment from another workspace and an invalid configuration", async () => {
    await expect(service.createSink(
      ws, { name: "X", type: "webhook", config: { url: "https://siem.example.com" }, environmentIds: ["00000000-0000-4000-8000-0000000000ff"] }, admin,
    )).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createSink(ws, { name: "X", type: "splunk", config: { url: "http://splunk.example.com" }, credentials: { token: "t" } }, admin))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("sends a test event outside the stream", async () => {
    const { sink: created } = await service.createSink(ws, { name: "T", type: "webhook", config: { url: "https://siem.example.com/t" } }, admin);
    const result = await service.sendTestEvent(ws, created.sinkId, admin);
    expect(result.ok).toBe(true);
    expect(sentEvents()).toEqual([expect.objectContaining({ type: "audit.test", test: true })]);
    await flushAuditEvents();
    expect((await events()).some((event) => event.type === "audit.test")).toBe(false);
    expect((await service.getSink(ws, created.sinkId)).deliveredCount).toBe(0);
  });
});

describe("retention", () => {
  it("keeps records for the plan's retention by default", async () => {
    expect((await service.getAuditSettings(ws))).toMatchObject({ retentionDays: null, hotDays: 90, archiveAvailable: false });
  });

  it("deletes records older than the workspace's window and keeps the rest", async () => {
    await service.updateAuditSettings(ws, { retentionDays: 30 }, admin);
    await record("member.added", null);
    const backdate = "UPDATE audit_events SET occurred_at = now() - interval '45 days' WHERE workspace_id = $1 AND type = 'member.added'";
    await expect(sql(backdate, [ws])).rejects.toThrow(/immutable/);
    await sql("ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable");
    try {
      await sql(backdate, [ws]);
    } finally {
      await sql("ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable");
    }
    await record("member.removed", null);
    const result = await sweepAuditRetention();
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const kept = (await events()).map((event) => event.type);
    expect(kept.filter((type) => !type.startsWith("audit.re"))).toEqual(["audit.settings.updated", "member.removed"]);
    expect(kept).toContain("audit.records.expired");
  });

  it("refuses a window below the minimum", async () => {
    await expect(service.updateAuditSettings(ws, { retentionDays: 7 }, admin)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("listing and export", () => {
  it("filters by range, environment, type and action, oldest first, across chunks", async () => {
    await record("action.succeeded", prod, { actionName: "refund", invocationId: "inv_1" });
    await record("action.failed", staging, { actionName: "refund", invocationId: "inv_2" });
    await record("approval.vote", prod, { actionName: "refund", approvalId: "apr_1" });
    await record("action.succeeded", prod, { actionName: "send_email", invocationId: "inv_3" });

    const all: string[] = [];
    for await (const chunk of service.iterateAuditEvents(ws, { environmentId: prod, action: "refund" })) all.push(...chunk.map((e) => e.type));
    expect(all).toEqual(["action.succeeded", "approval.vote"]);

    const actions: string[] = [];
    for await (const chunk of service.iterateAuditEvents(ws, { types: ["action.*"], from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) })) {
      actions.push(...chunk.map((e) => e.data.invocationId as string));
    }
    expect(actions).toEqual(["inv_1", "inv_2", "inv_3"]);
  });

  it("limits an environment-scoped credential to its own environment's records", async () => {
    await record("member.added", null);
    await record("action.succeeded", prod);
    await record("action.succeeded", staging);
    const page = await service.listAuditEvents(ws, { onlyEnvironmentId: staging });
    expect(page.events.map((event) => event.environmentId)).toEqual([staging]);
  });

  it("pages newest first", async () => {
    for (let i = 0; i < 5; i++) await record("member.added", null, { i });
    const first = await service.listAuditEvents(ws, {}, { limit: 2 });
    const second = await service.listAuditEvents(ws, {}, { limit: 2, before: first.nextBefore! });
    expect([...first.events, ...second.events].map((event) => event.data.i)).toEqual([4, 3, 2, 1]);
  });
});

describe("policy changes", () => {
  it("become audit records with the actor and the version", async () => {
    await sql("INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template) VALUES ($1, $2, 'act_audit_refund', 'refund_order', 'https://example.test/refund') ON CONFLICT DO NOTHING", [ws, prod]);
    const policy = await createPolicy(ws, { environmentId: prod, name: "Big refunds", matchKind: "action", matchActionName: "refund_order", minAmount: 50, changeNote: "Finance" }, { actor: { type: "api_key", id: "key_operator" } });
    await vi.waitFor(async () => {
      await flushAuditEvents();
      const rows = (await events()).filter((event) => event.type === "policy.created");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_type: "api_key", actor_id: "key_operator", resource_id: policy.id, environment_id: prod });
      expect(rows[0].data).toMatchObject({ version: 1, changeNote: "Finance", name: "Big refunds" });
    });
  });
});
