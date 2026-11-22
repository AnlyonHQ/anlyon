import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

process.env.TYPESAFE_API_KEY = "ts_test_only";
process.env.TYPESAFE_TIMEOUT_MS = "1000";

const safeFetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: safeFetchMock };
});

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";

type Answers = { recommendation?: string; confidence?: number; risk?: number; injection?: number; consistent?: number };
const typesafe = vi.fn();
function answer(a: Answers = {}) {
  typesafe.mockImplementation(async () => new Response(JSON.stringify({
    model: "jev-1.13.0",
    answers: {
      risk: { type: "score", score: a.risk ?? 0.2, confidence: 0.9, probabilities: {} },
      recommendation: { type: "choice", choice: a.recommendation ?? "approve", confidence: a.confidence ?? 0.97, probabilities: {} },
      consistent_with_history: { type: "noul", noul: a.consistent ?? 0.92 },
      injection_suspected: { type: "noul", noul: a.injection ?? 0.01 },
      amount_unusual: { type: "noul", noul: 0.1 },
    },
    usage: { input_tokens: 400, output_tokens: 0 },
  }), { status: 200, headers: { "content-type": "application/json" } }));
}

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("AI approval assistant (real Postgres + Redis)", () => {
  let pool: Pool;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let assistant: typeof import("../src/core/assistant/service.ts");
  let usage: typeof import("../src/core/assistant/usage.ts");
  let advice: typeof import("../src/core/assistant/advice.ts");
  let actionSvc: typeof import("../src/core/actions/service.ts");
  let approvalsSvc: typeof import("../src/core/approvals/service.ts");
  let policySvc: typeof import("../src/core/approvals/policy.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");
  let keysSvc: typeof import("../src/core/auth/api-keys.ts");
  const cleanup: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const { usePlanFixture } = await import("./support/plan-fixture.ts");
    usePlanFixture({ "*": { maxMonthlyAssistantReviews: 1_000, maxDailyAssistantAutoApprovals: 100 } });
    app = (await import("../src/api/index.ts")).default as typeof app;
    assistant = await import("../src/core/assistant/service.ts");
    usage = await import("../src/core/assistant/usage.ts");
    advice = await import("../src/core/assistant/advice.ts");
    actionSvc = await import("../src/core/actions/service.ts");
    approvalsSvc = await import("../src/core/approvals/service.ts");
    policySvc = await import("../src/core/approvals/policy.ts");
    envSvc = await import("../src/core/environments/service.ts");
    keysSvc = await import("../src/core/auth/api-keys.ts");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    typesafe.mockReset();
    safeFetchMock.mockClear();
  });

  afterAll(async () => {
    for (const id of cleanup) await pool.query("DELETE FROM workspaces WHERE id = $1", [id]).catch(() => {});
    await pool?.end().catch(() => {});
  });

  function stubTypeSafe() {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/systemone")) return typesafe(url, init);
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
  }

  async function seed(opts: { optIn?: boolean; autoApprove?: Record<string, unknown> } = {}) {
    const ws = await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('WS', $1) RETURNING id`, [`ws-${randomUUID().slice(0, 8)}`]);
    const workspaceId = ws.rows[0].id as string;
    cleanup.push(workspaceId);
    const environmentId = (await envSvc.ensureDefaultEnvironment(workspaceId)).id;
    const actionName = `refund_${randomUUID().slice(0, 6)}`;
    await actionSvc.createAction(workspaceId, {
      name: actionName, method: "POST", urlTemplate: "https://api.shop.test/refund", requiresApproval: true,
    }, actionSvc.UNSCOPED_AUTHORITY, environmentId);
    if (opts.optIn) {
      await assistant.updateAssistantSettings(workspaceId, {
        enabled: true, consentVersion: advice.ASSISTANT_CONSENT_VERSION,
        ...(opts.autoApprove ? { autoApprove: { actions: [actionName], ...opts.autoApprove } } : {}),
      }, null);
    }
    return { workspaceId, environmentId, actionName };
  }

  async function history(s: { workspaceId: string; environmentId: string; actionName: string }, n: number, status = "approved") {
    for (let i = 0; i < n; i++) {
      await pool.query(
        `INSERT INTO approvals (workspace_id, environment_id, approval_id, kind, status, title, payload, expires_at, decided_at, decision_origin)
         VALUES ($1, $2, $3, 'action', $4, 'past', $5, now() + interval '1 day', now(), 'human')`,
        [s.workspaceId, s.environmentId, `apr_${randomUUID().replace(/-/g, "")}`, status,
          JSON.stringify({ actionName: s.actionName, input: { amount: 20 + i } })],
      );
    }
  }

  const invoke = (s: { workspaceId: string; environmentId: string; actionName: string }, input: Record<string, unknown> = { amount: 25 }) =>
    actionSvc.invokeAction(s.workspaceId, s.actionName, input, { environmentId: s.environmentId });

  async function settled(approvalId: string) {
    for (let i = 0; i < 100; i++) {
      const r = await pool.query(
        `SELECT a.status, a.status_reason, a.recommendation, a.reasons FROM approval_advice a
         JOIN approvals p ON p.id = a.approval_id WHERE p.approval_id = $1`, [approvalId]);
      if (r.rows[0] && r.rows[0].status !== "pending") return r.rows[0];
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`advice for ${approvalId} never settled`);
  }

  const notifications = async (workspaceId: string) =>
    (await pool.query(`SELECT metadata, message FROM notifications WHERE workspace_id = $1 AND type = 'approval_requested'`, [workspaceId])).rows;

  it("never calls out for a workspace that has not opted in, and requires consent to opt in", async () => {
    stubTypeSafe();
    const s = await seed();
    const result = await invoke(s);
    expect(result.pendingApproval).toBe(true);
    expect(typesafe).not.toHaveBeenCalled();
    expect(await notifications(s.workspaceId)).toHaveLength(1);

    await expect(assistant.updateAssistantSettings(s.workspaceId, { enabled: true }, null)).rejects.toThrow(/consent/);
    expect((await assistant.getAssistantSettings(s.workspaceId)).enabled).toBe(false);
  });

  it("stores advice and sends the reviewer notification with it, without deciding", async () => {
    stubTypeSafe();
    answer();
    const s = await seed({ optIn: true });
    const result = await invoke(s);
    const row = await settled(result.approvalId!);
    expect(row).toMatchObject({ status: "ready", recommendation: "approve" });
    expect(typesafe).toHaveBeenCalledTimes(1);

    const sent = JSON.parse((typesafe.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.model).toBe("jev-1.13.0");
    expect(sent.state.request.action).toBe(s.actionName);

    const [notification] = await notifications(s.workspaceId);
    expect(notification.metadata.advice).toMatchObject({ recommendation: "approve" });
    const approval = await approvalsSvc.getApproval(s.workspaceId, result.approvalId!);
    expect(approval.status).toBe("pending");
    expect((await usage.getAssistantUsage(s.workspaceId)).reviews.used).toBe(1);
  });

  it("approves inside the envelope, labelled as the assistant, and runs the action", async () => {
    stubTypeSafe();
    answer();
    const s = await seed({ optIn: true, autoApprove: { enabled: true, maxAmount: 100 } });
    await history(s, 20);
    const result = await invoke(s);
    await settled(result.approvalId!);

    const approval = await approvalsSvc.getApproval(s.workspaceId, result.approvalId!);
    expect(approval).toMatchObject({ status: "approved", decisionOrigin: "assistant" });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(await notifications(s.workspaceId)).toHaveLength(0);
    expect((await usage.getAssistantUsage(s.workspaceId)).autoApprovals.used).toBe(1);

    const inv = await pool.query(`SELECT decision FROM action_invocations WHERE approval_id = $1`, [result.approvalId]);
    expect(inv.rows[0].decision).toMatchObject({ source: "assistant", code: "ASSISTANT_APPROVED", effect: "approved" });
  });

  it("leaves it to a person outside the envelope: amount over the cap, a prior denial, or too little history", async () => {
    stubTypeSafe();
    answer();
    const over = await seed({ optIn: true, autoApprove: { enabled: true, maxAmount: 10 } });
    await history(over, 20);
    const denied = await seed({ optIn: true, autoApprove: { enabled: true } });
    await history(denied, 20);
    await history(denied, 1, "denied");
    const thin = await seed({ optIn: true, autoApprove: { enabled: true } });
    await history(thin, 3);

    for (const [s, reason] of [[over, "above the auto-approve cap"], [denied, "was denied"], [thin, "Not enough approved history"]] as const) {
      const result = await invoke(s);
      const row = await settled(result.approvalId!);
      expect((await approvalsSvc.getApproval(s.workspaceId, result.approvalId!)).status).toBe("pending");
      expect(row.reasons.at(-1)).toContain(reason);
      expect(await notifications(s.workspaceId)).toHaveLength(1);
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("with no cap set, leaves a request carrying an amount to a person, and still approves one carrying none", async () => {
    stubTypeSafe();
    answer();
    const s = await seed({ optIn: true, autoApprove: { enabled: true } });
    expect((await assistant.getAssistantSettings(s.workspaceId)).autoApprove.maxAmount ?? null).toBeNull();
    await history(s, 20);

    const withAmount = await invoke(s, { amount: 25 });
    const row = await settled(withAmount.approvalId!);
    expect(row).toMatchObject({ recommendation: "approve" });
    expect(row.reasons.at(-1)).toContain("no cap set");
    expect((await approvalsSvc.getApproval(s.workspaceId, withAmount.approvalId!)).status).toBe("pending");
    expect(await notifications(s.workspaceId)).toHaveLength(1);
    expect(safeFetchMock).not.toHaveBeenCalled();

    const withoutAmount = await invoke(s, { orderId: "ord_1" });
    await settled(withoutAmount.approvalId!);
    expect(await approvalsSvc.getApproval(s.workspaceId, withoutAmount.approvalId!)).toMatchObject({
      status: "approved", decisionOrigin: "assistant",
    });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(await notifications(s.workspaceId)).toHaveLength(1);
  });

  it("never approves when a policy requires more than one approver", async () => {
    stubTypeSafe();
    answer({ confidence: 1, risk: 0 });
    const s = await seed({ optIn: true, autoApprove: { enabled: true } });
    await history(s, 20);
    await policySvc.createPolicy(s.workspaceId, {
      environmentId: s.environmentId, name: "two people", matchKind: "action", matchActionName: s.actionName,
      effect: "require_approval", requiredApprovals: 2,
    });
    const result = await invoke(s);
    const row = await settled(result.approvalId!);
    const approval = await approvalsSvc.getApproval(s.workspaceId, result.approvalId!);
    expect(approval).toMatchObject({ status: "pending", approvedCount: 0 });
    expect(row.reasons.at(-1)).toContain("more than one approver");
  });

  it("never approves while the environment is halted", async () => {
    stubTypeSafe();
    const s = await seed({ optIn: true, autoApprove: { enabled: true } });
    await history(s, 20);
    const halt = await import("../src/core/environments/halt.ts");
    answer();
    const reply = typesafe.getMockImplementation()!;
    typesafe.mockImplementation(async (...args: unknown[]) => {
      await halt.haltEnvironment(s.workspaceId, s.environmentId, { reason: "test" });
      return reply(...args);
    });
    const result = await invoke(s);
    const row = await settled(result.approvalId!);
    expect((await approvalsSvc.getApproval(s.workspaceId, result.approvalId!)).status).toBe("pending");
    expect(row.reasons.at(-1)).toContain("halted");
    expect(safeFetchMock).not.toHaveBeenCalled();
    await halt.resumeEnvironment(s.workspaceId, s.environmentId);
  });

  it("holds the review cap: skipped with a note, and the reviewer is still notified", async () => {
    stubTypeSafe();
    answer();
    const s = await seed({ optIn: true });
    const caps = await usage.assistantCaps(s.workspaceId);
    expect(typeof caps.reviews).toBe("number");
    await pool.query(
      `INSERT INTO assistant_usage (workspace_id, period, kind, count) VALUES ($1, $2, 'reviews', $3)`,
      [s.workspaceId, usage.usagePeriod("reviews"), caps.reviews],
    );
    const result = await invoke(s);
    const row = await settled(result.approvalId!);
    expect(row).toMatchObject({ status: "skipped", status_reason: "quota_exceeded" });
    expect(typesafe).not.toHaveBeenCalled();
    const [notification] = await notifications(s.workspaceId);
    expect(notification.message).toContain("Vigil suggestions paused");
    expect(notification.metadata.advice).toBeUndefined();
  });

  it("never admits past a cap under concurrency", async () => {
    const s = await seed();
    const admitted = await Promise.all(Array.from({ length: 20 }, () => usage.admitAssistantUsage(s.workspaceId, "auto_approvals", 5)));
    expect(admitted.filter(Boolean)).toHaveLength(5);
    expect((await usage.getAssistantUsage(s.workspaceId)).autoApprovals.used).toBe(5);
  });

  it("does not show advice to an API-key caller", async () => {
    stubTypeSafe();
    answer();
    const s = await seed({ optIn: true });
    const userId = `user_${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'T', $2, false, now(), now())`, [userId, `${userId}@test.dev`]);
    const key = await keysSvc.createApiKey(s.workspaceId, userId, "agent", undefined, ["approvals:read"], s.environmentId);
    const result = await invoke(s);
    await settled(result.approvalId!);
    expect((await assistant.adviceByPublicId(s.workspaceId, [result.approvalId!])).size).toBe(1);

    const res = await app.request(`/api/v2/approvals/${result.approvalId}`, { headers: { Authorization: `Bearer ${key.key}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data.id).toBe(result.approvalId);
    expect(body.data).not.toHaveProperty("advice");
    await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
  });

  it("the sweep finishes a review whose worker died, and the reviewer is notified", async () => {
    stubTypeSafe();
    answer();
    const s = await seed({ optIn: true });
    const created = await approvalsSvc.createApproval(s.workspaceId, { title: "Crashed review" }, { environmentId: s.environmentId });
    await settled(created.id);
    const before = (await notifications(s.workspaceId)).length;

    const dead = await approvalsSvc.createApproval(s.workspaceId, { title: "Dead worker" }, { environmentId: s.environmentId });
    await settled(dead.id);
    await pool.query(
      `UPDATE approval_advice SET status = 'pending', attempts = 2, claimed_at = now() - interval '1 hour',
         created_at = now() - interval '1 hour', completed_at = NULL,
         recommendation = NULL, risk = NULL, confidence = NULL, model = NULL
       WHERE approval_id = (SELECT id FROM approvals WHERE approval_id = $1)`, [dead.id]);

    await assistant.sweepPendingAdvice();
    const row = await settled(dead.id);
    expect(row).toMatchObject({ status: "failed", status_reason: "gave_up" });
    expect((await notifications(s.workspaceId)).length).toBe(before + 2);
  });

  it("the sweep leaves a review that is still in flight alone", async () => {
    stubTypeSafe();
    answer();
    const s = await seed({ optIn: true });
    const created = await approvalsSvc.createApproval(s.workspaceId, { title: "In flight" }, { environmentId: s.environmentId });
    await settled(created.id);
    await pool.query(
      `UPDATE approval_advice SET status = 'pending', attempts = 1, claimed_at = now(), created_at = now() - interval '1 minute'
       WHERE approval_id = (SELECT id FROM approvals WHERE approval_id = $1)`, [created.id]);
    typesafe.mockClear();
    await assistant.sweepPendingAdvice();
    expect(typesafe).not.toHaveBeenCalled();
    const r = await pool.query(`SELECT status FROM approval_advice WHERE approval_id = (SELECT id FROM approvals WHERE approval_id = $1)`, [created.id]);
    expect(r.rows[0].status).toBe("pending");
  });

  it("turning the assistant off turns auto-approve off, so re-enabling never silently resumes it", async () => {
    const s = await seed({ optIn: true, autoApprove: { enabled: true } });
    expect((await assistant.getAssistantSettings(s.workspaceId)).autoApprove.enabled).toBe(true);
    await assistant.updateAssistantSettings(s.workspaceId, { enabled: false }, null);
    await assistant.updateAssistantSettings(s.workspaceId, { enabled: true, consentVersion: advice.ASSISTANT_CONSENT_VERSION }, null);
    expect((await assistant.getAssistantSettings(s.workspaceId)).autoApprove.enabled).toBe(false);
  });

  it("sends no request notification when a person decides while the model is thinking", async () => {
    stubTypeSafe();
    answer();
    const s = await seed({ optIn: true });
    const reply = typesafe.getMockImplementation()!;
    let approvalId = "";
    typesafe.mockImplementation(async (...args: unknown[]) => {
      await pool.query(
        `UPDATE approvals SET status = 'denied', decision_origin = 'human', decided_at = now() WHERE approval_id = $1`,
        [approvalId],
      );
      return reply(...args);
    });
    const created = await approvalsSvc.createApproval(s.workspaceId, { title: "Decided mid-review" }, { environmentId: s.environmentId });
    approvalId = created.id;
    const row = await settled(created.id);
    expect(row.status).toBe("ready");
    expect(await notifications(s.workspaceId)).toHaveLength(0);
  });

  it("delivers stored answers after a crash without asking the model again", async () => {
    stubTypeSafe();
    answer();
    const s = await seed({ optIn: true });
    const created = await approvalsSvc.createApproval(s.workspaceId, { title: "Crashed before delivery" }, { environmentId: s.environmentId });
    await settled(created.id);
    await pool.query("DELETE FROM notifications WHERE workspace_id = $1", [s.workspaceId]);
    await pool.query(
      `UPDATE approval_advice SET status = 'pending', attempts = 1, completed_at = NULL,
         claimed_at = now() - interval '1 hour', created_at = now() - interval '1 hour'
       WHERE approval_id = (SELECT id FROM approvals WHERE approval_id = $1)`, [created.id]);
    typesafe.mockClear();

    await assistant.sweepPendingAdvice();
    expect(typesafe).not.toHaveBeenCalled();
    expect((await settled(created.id)).status).toBe("ready");
    const [notification] = await notifications(s.workspaceId);
    expect(notification.metadata.advice).toMatchObject({ recommendation: "approve" });
  });

  it("settles stored answers as ready with the suggestion when the attempts are used up", async () => {
    stubTypeSafe();
    answer();
    const s = await seed({ optIn: true });
    const created = await approvalsSvc.createApproval(s.workspaceId, { title: "Out of attempts" }, { environmentId: s.environmentId });
    await settled(created.id);
    await pool.query("DELETE FROM notifications WHERE workspace_id = $1", [s.workspaceId]);
    await pool.query(
      `UPDATE approval_advice SET status = 'pending', attempts = 2, completed_at = NULL,
         claimed_at = now() - interval '1 hour', created_at = now() - interval '1 hour'
       WHERE approval_id = (SELECT id FROM approvals WHERE approval_id = $1)`, [created.id]);
    await assistant.sweepPendingAdvice();
    expect((await settled(created.id)).status).toBe("ready");
    const [notification] = await notifications(s.workspaceId);
    expect(notification.metadata.advice).toMatchObject({ recommendation: "approve" });
  });

  it("never admits past the platform ceiling under concurrency", async () => {
    const when = new Date(Date.UTC(2031, 0, 15));
    const redisLib = await import("../src/lib/redis.ts");
    await redisLib.redis.del("assistant:platform-reviews:2031-01");
    const admitted = await Promise.all(Array.from({ length: 20 }, () => usage.admitPlatformReview(when, 5)));
    expect(admitted.filter(Boolean)).toHaveLength(5);
    await usage.releasePlatformReview({ period: "2031-01" });
    expect(await usage.admitPlatformReview(when, 5)).toEqual({ period: "2031-01" });
    expect(await usage.admitPlatformReview(when, 5)).toBeNull();
    await redisLib.redis.del("assistant:platform-reviews:2031-01");
  });

  it("queues sampled assistant approvals for audit until someone gives a verdict", async () => {
    stubTypeSafe();
    answer();
    const s = await seed({ optIn: true, autoApprove: { enabled: true, maxAmount: 1_000_000 } });
    await assistant.updateAssistantSettings(s.workspaceId, { auditSampleRate: 1 }, null);
    await history(s, 20);
    const result = await invoke(s);
    await settled(result.approvalId!);
    const queue = await assistant.listAuditQueue(s.workspaceId);
    expect(queue.map((a) => a.id)).toEqual([result.approvalId]);
    expect(queue[0]).toMatchObject({ decisionOrigin: "assistant", advice: { auditRequested: true, auditVerdict: null } });

    await assistant.recordAuditVerdict(s.workspaceId, result.approvalId!, "disagree", "user_1");
    expect(await assistant.listAuditQueue(s.workspaceId)).toEqual([]);
    await expect(assistant.recordAuditVerdict(s.workspaceId, result.approvalId!, "agree", "user_2"))
      .rejects.toMatchObject({ statusCode: 409 });
    const stored = await pool.query(
      `SELECT audit_verdict, audited_by_user_id FROM approval_advice
       WHERE approval_id = (SELECT id FROM approvals WHERE approval_id = $1)`, [result.approvalId]);
    expect(stored.rows[0]).toEqual({ audit_verdict: "disagree", audited_by_user_id: "user_1" });
  });
});
