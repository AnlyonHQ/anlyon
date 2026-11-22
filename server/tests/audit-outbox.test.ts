import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined, edition: "cloud" as "cloud" | "enterprise" }));
const sink = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; body: string; options: unknown }>,
}));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client), pool: { end: async () => {} } };
});
vi.mock("../src/lib/redis.ts", () => {
  const nothing = new Proxy({}, { get: () => async () => null });
  return {
    redis: nothing,
    redisBlocking: nothing,
    RedisKeys: new Proxy({}, { get: (_t, name) => (...parts: unknown[]) => [String(name), ...parts].join(":") }),
    createBlockingConnection: () => nothing,
    incrementWithTtl: async () => 1,
    USAGE_COUNTER_TTL_SECONDS: 1,
    WAITING_EVENT_TTL_SECONDS: 1,
  };
});
vi.mock("../src/core/edition/edition.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/edition/edition.ts")>()),
  currentEdition: () => state.edition,
  isCloudEdition: () => state.edition === "cloud",
}));
vi.mock("../src/core/edition/features.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/edition/features.ts")>()),
  isFeatureEnabled: () => true,
}));
vi.mock("../src/lib/safe-http.ts", () => ({
  SsrfBlockedError: class SsrfBlockedError extends Error {},
  safeFetch: async (url: string, init: { body: string }, options: unknown) => {
    sink.requests.push({ url, body: init.body, options });
    return new Response("", { status: 200 });
  },
}));

const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);
const { auditEventId } = await import("../src/core/audit/outbox.ts");
const { approveApproval, denyApproval, sweepExpiredApprovals } = await import("../src/core/approvals/service.ts");
const { createPolicy, policyWrite } = await import("../src/core/approvals/policy.ts");
const { haltEnvironment, resumeEnvironment } = await import("../src/core/environments/halt.ts");
const { recordInvocationOutcomeIn } = await import("../src/core/billing/action-accounting.ts");
const { createApiKey, deleteApiKey } = await import("../src/core/auth/api-keys.ts");
const { addMember } = await import("../src/core/workspace/members.ts");
const { backfillAuditHistory } = await import("../src/core/audit/backfill.ts");
const service = await import("../src/core/audit/service.ts");
const { deliverDueAuditSinks } = await import("../src/core/audit/delivery.ts");
const { db } = await import("../src/db/index.ts");
const { approvalPolicies } = await import("../src/db/schema/approvals.ts");

const ws = "00000000-0000-4000-8000-00000000d0a1";
const env = "00000000-0000-4000-8000-00000000d0b1";
const env2 = "00000000-0000-4000-8000-00000000d0b2";
const owner = "user_outbox_owner";
const keyA = "00000000-0000-4000-8000-00000000d0c1";
const admin = { actor: { type: "user" as const, id: owner } };

const records = async (where = "true", params: unknown[] = []) =>
  (await sql(`SELECT * FROM audit_events WHERE workspace_id = '${ws}' AND ${where} ORDER BY seq`, params)).rows;

async function approval(id: string, opts: { required?: number; expired?: boolean } = {}) {
  const { rows } = await sql(
    `INSERT INTO approvals (workspace_id, environment_id, approval_id, kind, title, required_approvals, requested_by_key_id, expires_at)
     VALUES ($1, $2, $3, 'custom', 'Refund 400 EUR', $4, $5, $6) RETURNING id`,
    [ws, env, id, opts.required ?? 1, keyA, opts.expired ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z"],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  await sql("INSERT INTO \"user\" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Owner', 'owner@example.test', true, now(), now()), ('user_outbox_2', 'Second', 'second@example.test', true, now(), now())", [owner]);
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', 'ws-outbox')", [ws]);
  await sql("INSERT INTO workspace_members (workspace_id, user_id, role, emergency_access) VALUES ($1, $2, 'admin', true)", [ws, owner]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug, is_default) VALUES ($1, $3, 'prod', 'prod', true), ($2, $3, 'staging', 'staging', false)", [env, env2, ws]);
  await sql("INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template) VALUES ($1, $2, 'act_outbox_refund', 'refund_order', 'https://example.test/refund')", [ws, env]);
}, 120_000);

beforeEach(() => {
  sink.requests = [];
  state.edition = "cloud";
});

describe("committed changes always have their record", () => {
  it("records every vote and the decision it caused, in the vote's transaction", async () => {
    const rowId = await approval("apr_outbox_quorum", { required: 2 });
    await approveApproval(ws, "apr_outbox_quorum", { deciderUserId: owner }, env);
    let rows = await records("resource_id = 'apr_outbox_quorum'");
    expect(rows.map((row) => [row.type, row.actor_type, row.actor_id])).toEqual([["approval.vote", "user", owner]]);

    await approveApproval(ws, "apr_outbox_quorum", { deciderKeyId: "00000000-0000-4000-8000-00000000d0c9" }, env);
    rows = await records("resource_id = 'apr_outbox_quorum'");
    expect(rows.map((row) => row.type)).toEqual(["approval.vote", "approval.vote", "approval.approved"]);
    expect(rows[2]).toMatchObject({ actor_type: "api_key", event_id: auditEventId(`approval:${rowId}:approved`), outcome: "approved" });
  });

  it("records a denial, and an expiry by the sweep", async () => {
    await approval("apr_outbox_deny");
    await denyApproval(ws, "apr_outbox_deny", { deciderUserId: owner, note: "Too large" }, env);
    expect((await records("resource_id = 'apr_outbox_deny'")).map((row) => row.type)).toEqual(["approval.vote", "approval.denied"]);

    await approval("apr_outbox_expire", { expired: true });
    await sweepExpiredApprovals(200, { workspaceId: ws });
    const [expired] = await records("resource_id = 'apr_outbox_expire'");
    expect(expired).toMatchObject({ type: "approval.expired", actor_type: "system" });
  });

  it("records policy versions, halts, keys and members with their actor", async () => {
    const policy = await createPolicy(ws, { environmentId: env, name: "Outbox refunds", matchKind: "action", matchActionName: "refund_order", minAmount: 10 }, { actor: { type: "user", id: owner } });
    const [version] = (await sql("SELECT id FROM approval_policy_versions WHERE policy_id = $1", [policy.id])).rows;
    expect(await records(`event_id = '${auditEventId(`policy_version:${version.id}`)}'`)).toHaveLength(1);

    await haltEnvironment(ws, env2, { actor: owner, reason: "drill" });
    await resumeEnvironment(ws, env2, { actor: `key:${keyA}` });
    const halts = await records("category = 'environment'");
    expect(halts.map((row) => [row.type, row.actor_type])).toEqual([["environment.halted", "user"], ["environment.resumed", "api_key"]]);

    const { apiKey, key } = await createApiKey(ws, owner, "outbox key", undefined, undefined, env);
    await deleteApiKey(apiKey.id, ws, admin);
    expect((await records("category = 'access' AND resource_id = $1", [apiKey.id])).map((row) => row.type)).toEqual(["api_key.created", "api_key.deleted"]);
    expect(JSON.stringify(await records("category = 'access'"))).not.toContain(key);

    await addMember(ws, owner, "user_outbox_2", "member", { requestId: "req_outbox" });
    const [added] = await records("type = 'member.added'");
    expect(added).toMatchObject({ actor_id: owner, resource_id: "user_outbox_2" });
    expect(added.context).toEqual({ requestId: "req_outbox" });
  });

  it("records an invocation outcome once, with its receipt", async () => {
    const { rows } = await sql(
      `INSERT INTO action_invocations (workspace_id, environment_id, action_id, invocation_id, requested_by_key_id)
       SELECT $1, $2, id, 'inv_outbox_ok', $3 FROM actions WHERE action_id = 'act_outbox_refund' RETURNING id`,
      [ws, env, keyA],
    );
    const id = rows[0].id as string;
    await db.transaction((tx) => recordInvocationOutcomeIn(tx, ws, id, { status: "unknown", completedAt: new Date() }, "unknown"));
    await db.transaction((tx) => recordInvocationOutcomeIn(tx, ws, id, { status: "unknown" }, "unknown"));
    await db.transaction((tx) => recordInvocationOutcomeIn(tx, ws, id, { status: "succeeded", responseStatus: 200 }, "billed"));
    const outcome = await records("resource_id = 'inv_outbox_ok'");
    expect(outcome.map((row) => row.type)).toEqual(["action.unknown", "action.succeeded"]);
    expect(outcome[1]).toMatchObject({ actor_type: "api_key", actor_id: keyA, event_id: auditEventId(`invocation:${id}:succeeded`) });
    expect(outcome[1].data).toMatchObject({ actionName: "refund_order", receipt: { responseStatus: 200, status: "succeeded" } });
  });
});

describe("a rolled-back change leaves no record", () => {
  it("drops the policy version's record with the policy write", async () => {
    const before = (await records()).length;
    await expect(policyWrite(ws, { environmentId: env, actor: { type: "user", id: owner } }, "doomed", async (tx) => {
      await tx.insert(approvalPolicies).values({ workspaceId: ws, environmentId: env, policyId: "pol_outbox_doomed", name: "Doomed", matchKind: "action", matchActionName: "refund_order" } as never);
      throw new Error("validation failed after the insert");
    })).rejects.toThrow("validation failed");
    expect((await sql("SELECT 1 FROM approval_policies WHERE policy_id = 'pol_outbox_doomed'")).rows).toHaveLength(0);
    expect(await records()).toHaveLength(before);
  });

  it("drops the outcome's record when the outcome's transaction rolls back", async () => {
    const { rows } = await sql(
      `INSERT INTO action_invocations (workspace_id, environment_id, action_id, invocation_id)
       SELECT $1, $2, id, 'inv_outbox_rollback' FROM actions WHERE action_id = 'act_outbox_refund' RETURNING id`,
      [ws, env],
    );
    await expect(db.transaction(async (tx) => {
      await recordInvocationOutcomeIn(tx, ws, rows[0].id as string, { status: "failed" }, "released");
      throw new Error("later step failed");
    })).rejects.toThrow("later step failed");
    expect(await records("resource_id = 'inv_outbox_rollback'")).toHaveLength(0);
    expect((await sql("SELECT status FROM action_invocations WHERE invocation_id = 'inv_outbox_rollback'")).rows[0].status).toBe("running");
  });

  it("does not make a change whose record cannot be written", async () => {
    await sql("ALTER TABLE audit_events RENAME TO audit_events_away");
    try {
      await expect(haltEnvironment(ws, env2, { actor: owner })).rejects.toThrow();
    } finally {
      await sql("ALTER TABLE audit_events_away RENAME TO audit_events");
    }
    expect((await sql("SELECT halted_at FROM environments WHERE id = $1", [env2])).rows[0].halted_at).toBeNull();
  });
});

describe("backfill", () => {
  it("builds the trail from history once, with original times and the live ids", async () => {
    const { rows } = await sql(
      `INSERT INTO approvals (workspace_id, environment_id, approval_id, kind, title, status, decision_origin, decided_by_user_id,
         requested_by_key_id, created_at, decided_at, expires_at)
       VALUES ($1, $2, 'apr_history', 'custom', 'Old refund', 'approved', 'human', $3, $4,
         '2026-03-01T10:00:00Z', '2026-03-01T10:05:00Z', '2026-03-02T10:00:00Z') RETURNING id`,
      [ws, env, owner, keyA],
    );
    await sql("INSERT INTO approval_decisions (approval_id, decider_user_id, decision, decided_at) VALUES ($1, $2, 'approve', '2026-03-01T10:05:00Z')", [rows[0].id, owner]);
    await sql(
      `INSERT INTO action_invocations (workspace_id, environment_id, action_id, invocation_id, status, created_at, completed_at)
       SELECT $1, $2, id, 'inv_history', 'failed', '2026-03-02T09:00:00Z', '2026-03-02T09:00:02Z' FROM actions WHERE action_id = 'act_outbox_refund'`,
      [ws, env],
    );

    const dry = await backfillAuditHistory({ workspaceId: ws, dryRun: true });
    expect(dry.inserted).toBe(0);
    expect(dry.sources.approvals.built).toBeGreaterThan(0);

    const first = await backfillAuditHistory({ workspaceId: ws });
    const history = (await records("resource_id IN ('apr_history', 'inv_history')"))
      .map((row) => [row.type, new Date(`${row.occurred_at}`).toISOString(), row.backfilled])
      .sort((a, b) => `${a[1]}${a[0]}`.localeCompare(`${b[1]}${b[0]}`));
    expect(history).toEqual([
      ["approval.requested", "2026-03-01T10:00:00.000Z", true],
      ["approval.approved", "2026-03-01T10:05:00.000Z", true],
      ["approval.vote", "2026-03-01T10:05:00.000Z", true],
      ["action.failed", "2026-03-02T09:00:02.000Z", true],
    ]);
    expect(first.inserted).toBeGreaterThanOrEqual(4);

    const duplicates = await sql(`SELECT resource_id, type, count(*)::int AS n FROM audit_events WHERE workspace_id = $1 AND type <> 'approval.vote' GROUP BY 1, 2 HAVING count(*) > 1 AND type NOT LIKE 'environment.%'`, [ws]);
    expect(duplicates.rows).toEqual([]);
    expect((await records("resource_id = 'apr_outbox_quorum' AND backfilled")).map((row) => row.type)).toEqual(["approval.requested"]);

    const again = await backfillAuditHistory({ workspaceId: ws });
    expect(again.inserted).toBe(0);
  });

  it("keeps history from a sink unless it includes history", async () => {
    const plain = await service.createSink(ws, { name: "Plain", type: "webhook", config: { url: "https://siem.example.com/p" }, startFrom: "beginning" }, admin);
    const withHistory = await service.createSink(ws, { name: "History", type: "webhook", config: { url: "https://siem.example.com/h" }, startFrom: "beginning", includeHistory: true }, admin);
    for (let i = 0; i < 20 && (await deliverDueAuditSinks()).some((run) => run.delivered > 0); i++) {
      await sql("UPDATE audit_sinks SET next_attempt_at = now() - interval '1 second' WHERE workspace_id = $1", [ws]);
    }
    const delivered = (url: string) => sink.requests.filter((request) => request.url === url)
      .flatMap((request) => (JSON.parse(request.body) as { events: Array<{ id: string; backfilled?: true }> }).events);
    expect(delivered("https://siem.example.com/p").some((event) => event.backfilled)).toBe(false);
    expect(delivered("https://siem.example.com/h").some((event) => event.backfilled)).toBe(true);
    await service.deleteSink(ws, plain.sink.sinkId, admin);
    await service.deleteSink(ws, withHistory.sink.sinkId, admin);
  });
});

describe("private network destinations", () => {
  it("are never available on cloud, whatever is stored", async () => {
    await expect(service.updateAuditSettings(ws, { allowPrivateDestinations: true }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await sql("INSERT INTO audit_settings (workspace_id, allow_private_destinations) VALUES ($1, true) ON CONFLICT (workspace_id) DO UPDATE SET allow_private_destinations = true", [ws]);
    expect(await service.privateNetworkAllowed(ws)).toBe(false);
    await expect(service.createSink(ws, { name: "Internal", type: "webhook", config: { url: "https://10.0.0.5/audit" } }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await sql("UPDATE audit_settings SET allow_private_destinations = false WHERE workspace_id = $1", [ws]);
  });

  it("are allowed off cloud once an admin turns them on, and only then", async () => {
    state.edition = "enterprise";
    await expect(service.createSink(ws, { name: "Internal", type: "webhook", config: { url: "https://10.0.0.5/audit" } }, admin)).rejects.toMatchObject({ statusCode: 400 });
    const settings = await service.updateAuditSettings(ws, { allowPrivateDestinations: true }, admin);
    expect(settings).toMatchObject({ allowPrivateDestinations: true, privateDestinationsAvailable: true });
    const { sink: created } = await service.createSink(ws, { name: "Internal", type: "webhook", config: { url: "https://10.0.0.5/audit" } }, admin);
    await service.sendTestEvent(ws, created.sinkId, admin);
    expect(sink.requests.at(-1)).toMatchObject({ url: "https://10.0.0.5/audit", options: { allowPrivateNetwork: true } });
    await expect(service.createSink(ws, { name: "Meta", type: "webhook", config: { url: "https://169.254.169.254/x" } }, admin)).rejects.toMatchObject({ statusCode: 400 });
    expect(await records("type = 'audit.settings.updated'")).not.toHaveLength(0);
    await service.deleteSink(ws, created.sinkId, admin);
  });

  it("are refused off cloud where an instance admin turned them off, whatever the workspace chose", async () => {
    state.edition = "enterprise";
    const { setStoredInstanceSettingsForTest } = await import("../src/core/instance/settings.ts");
    await service.updateAuditSettings(ws, { allowPrivateDestinations: true }, admin);
    const { sink: created } = await service.createSink(ws, { name: "Internal 2", type: "webhook", config: { url: "https://10.0.0.6/audit" } }, admin);
    try {
      setStoredInstanceSettingsForTest({ "network.private_destinations": "off" });
      expect(await service.privateNetworkAllowed(ws)).toBe(false);
      expect(await service.getAuditSettings(ws)).toMatchObject({ allowPrivateDestinations: true, privateDestinationsAvailable: false });
      await expect(service.updateAuditSettings(ws, { allowPrivateDestinations: true }, admin))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/instance admin has turned off private network destinations/) });
      await expect(service.createSink(ws, { name: "Internal 3", type: "webhook", config: { url: "https://10.0.0.7/audit" } }, admin)).rejects.toMatchObject({ statusCode: 400 });
      const before = sink.requests.length;
      await service.sendTestEvent(ws, created.sinkId, admin).catch(() => undefined);
      expect(sink.requests.slice(before).every((request) => request.options.allowPrivateNetwork !== true)).toBe(true);
      expect(await service.updateAuditSettings(ws, { allowPrivateDestinations: false }, admin)).toMatchObject({ allowPrivateDestinations: false });

      setStoredInstanceSettingsForTest({ "network.private_destinations": "workspace" });
      expect(await service.getAuditSettings(ws)).toMatchObject({ privateDestinationsAvailable: true });
      expect(await service.privateNetworkAllowed(ws)).toBe(false);
      await service.updateAuditSettings(ws, { allowPrivateDestinations: true }, admin);
      expect(await service.privateNetworkAllowed(ws)).toBe(true);
    } finally {
      setStoredInstanceSettingsForTest({});
      await service.deleteSink(ws, created.sinkId, admin);
    }
  });
});

describe("self-approval by the only approver in the environment", () => {
  const soloWs = "00000000-0000-4000-8000-00000000d0a3";
  const soloEnv = "00000000-0000-4000-8000-00000000d0b3";
  const solo = "user_outbox_solo";
  const soloKey = "00000000-0000-4000-8000-00000000d0c3";

  beforeAll(async () => {
    await sql("INSERT INTO \"user\" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Solo', 'solo@example.test', true, now(), now()), ('user_outbox_reviewer', 'Reviewer', 'reviewer@example.test', true, now(), now())", [solo]);
    await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'solo', 'ws-outbox-solo')", [soloWs]);
    await sql("INSERT INTO workspace_members (workspace_id, user_id, role, emergency_access) VALUES ($1, $2, 'admin', true)", [soloWs, solo]);
    await sql("INSERT INTO environments (id, workspace_id, name, slug, is_default) VALUES ($1, $2, 'prod', 'prod', true)", [soloEnv, soloWs]);
    await sql("INSERT INTO api_keys (id, workspace_id, environment_id, name, key_hash, key_prefix, created_by) VALUES ($1, $2, $3, 'agent', 'hash_solo_agent', 'anlyon_l', $4)", [soloKey, soloWs, soloEnv, solo]);
  });

  const requestFromOwnKey = (id: string) => sql(
    `INSERT INTO approvals (workspace_id, environment_id, approval_id, kind, title, required_approvals, requested_by_key_id, expires_at)
     VALUES ($1, $2, $3, 'custom', 'Refund 40 EUR', 1, $4, '2099-01-01T00:00:00Z')`,
    [soloWs, soloEnv, id, soloKey],
  );

  it("marks the vote, the answer and the audit record, and is refused once a second approver joins", async () => {
    await requestFromOwnKey("apr_self_solo");
    const result = await approveApproval(soloWs, "apr_self_solo", { deciderUserId: solo }, soloEnv);
    expect(result).toMatchObject({ selfApproved: true, approval: { status: "approved" } });
    const [vote] = (await sql("SELECT self_approved FROM approval_decisions d JOIN approvals a ON a.id = d.approval_id WHERE a.approval_id = 'apr_self_solo'")).rows;
    expect(vote.self_approved).toBe(true);
    const [record] = (await sql(`SELECT data FROM audit_events WHERE workspace_id = $1 AND type = 'approval.vote' AND resource_id = 'apr_self_solo'`, [soloWs])).rows;
    expect(record.data).toMatchObject({ selfApproved: true, decision: "approve" });

    await sql("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, 'user_outbox_reviewer', 'approver')", [soloWs]);
    await requestFromOwnKey("apr_self_second");
    await expect(approveApproval(soloWs, "apr_self_second", { deciderUserId: solo }, soloEnv))
      .rejects.toMatchObject({ code: "SELF_APPROVAL_NOT_ALLOWED" });
    const decided = await approveApproval(soloWs, "apr_self_second", { deciderUserId: "user_outbox_reviewer" }, soloEnv);
    expect(decided.selfApproved).toBe(false);
  });
});
