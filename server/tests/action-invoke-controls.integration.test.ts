import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const safeFetchMock = vi.fn();
vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: safeFetchMock };
});

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";
const SECRET_VALUE = "sk_live_do_not_leak_2f9a";

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

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("action invoke controls (real stack, HTTP)", () => {
  let pool: Pool;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let keysSvc: typeof import("../src/core/auth/api-keys.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");
  let secretsSvc: typeof import("../src/core/actions/secrets.ts");
  let actionSvc: typeof import("../src/core/actions/service.ts");
  let approvals: typeof import("../src/core/approvals/service.ts");
  let halt: typeof import("../src/core/environments/halt.ts");
  let budgets: typeof import("../src/core/billing/budgets.ts");

  let userId: string;
  let workspaceId: string;
  let environmentId: string;
  let apiKey: string;
  let apiKeyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = (await import("../src/api/index.ts")).default as typeof app;
    keysSvc = await import("../src/core/auth/api-keys.ts");
    envSvc = await import("../src/core/environments/service.ts");
    secretsSvc = await import("../src/core/actions/secrets.ts");
    actionSvc = await import("../src/core/actions/service.ts");
    approvals = await import("../src/core/approvals/service.ts");
    halt = await import("../src/core/environments/halt.ts");
    budgets = await import("../src/core/billing/budgets.ts");

    userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'T', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('A', $1) RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    environmentId = (await envSvc.ensureDefaultEnvironment(workspaceId)).id;

    const created = await keysSvc.createApiKey(
      workspaceId,
      userId,
      "agent",
      undefined,
      ["actions:read", "actions:write", "actions:invoke"],
      environmentId,
    );
    apiKey = created.key;
    apiKeyId = (
      await pool.query("SELECT id FROM api_keys WHERE workspace_id = $1", [workspaceId])
    ).rows[0].id;

    await budgets.putBudget(workspaceId, apiKeyId, { monthlyCostCentsCap: 100_000, enabled: true });

    await secretsSvc.putSecret(
      workspaceId,
      "PARTNER_TOKEN",
      { value: SECRET_VALUE, allowedHosts: ["api.partner.test"], allowedPlacements: ["header"] },
      environmentId,
    );
  }, 60_000);

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    }
    await pool?.end().catch(() => {});
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await pool.query("UPDATE environments SET halted_at = NULL WHERE id = $1", [environmentId]);
    const redisLib = await import("../src/lib/redis.ts");
    await redisLib.redis.del(redisLib.RedisKeys.environmentHalt(environmentId));
  });

  const authed = (init: RequestInit = {}) => ({
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  async function createAction(opts: { requiresApproval: boolean }) {
    const action = await actionSvc.createAction(
      workspaceId,
      {
        name: `partner_call_${randomUUID().slice(0, 8)}`,
        method: "POST",
        urlTemplate: "https://api.partner.test/v1/charge",
        headers: { Authorization: "Bearer {{secret:PARTNER_TOKEN}}" },
        requiresApproval: opts.requiresApproval,
      },
      actionSvc.UNSCOPED_AUTHORITY,
      environmentId,
    );
    return action;
  }

  function upstreamAccepts() {
    safeFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ charged: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  const invokesUsed = async () => (await budgets.getBudgetUsage(apiKeyId)).actionInvokes;

  it("sends the resolved secret to the destination and keeps it out of everything else", async () => {
    const action = await createAction({ requiresApproval: false });
    upstreamAccepts();

    const res = await app.request(
      `/api/v2/actions/${action.id}/invoke`,
      authed({ method: "POST", body: JSON.stringify({ input: {} }) }),
    );

    expect(res.status).toBe(200);
    const bodyText = await res.text();

    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const sentHeaders = safeFetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(sentHeaders.Authorization).toBe(`Bearer ${SECRET_VALUE}`);

    expect(bodyText).not.toContain(SECRET_VALUE);
    const stored = await pool.query(
      `SELECT input::text AS input, response_body, error_message, definition_snapshot::text AS snapshot
       FROM action_invocations WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [workspaceId],
    );
    expect(JSON.stringify(stored.rows[0])).not.toContain(SECRET_VALUE);
  });

  it("charges one invocation, and a replayed idempotency key neither re-executes nor re-charges", async () => {
    const action = await createAction({ requiresApproval: false });
    upstreamAccepts();
    const before = await invokesUsed();
    const idempotencyKey = `idem_${randomUUID()}`;

    const first = await app.request(
      `/api/v2/actions/${action.id}/invoke`,
      authed({
        method: "POST",
        body: JSON.stringify({ input: {} }),
        headers: { "Idempotency-Key": idempotencyKey },
      }),
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(await invokesUsed()).toBe(before + 1);

    const replay = await app.request(
      `/api/v2/actions/${action.id}/invoke`,
      authed({
        method: "POST",
        body: JSON.stringify({ input: {} }),
        headers: { "Idempotency-Key": idempotencyKey },
      }),
    );

    expect(replay.status).toBe(200);
    expect((await replay.json()).data.invocationId).toBe(firstBody.data.invocationId);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(await invokesUsed()).toBe(before + 1);
  });

  it("blocks an invocation while the environment is halted", async () => {
    const action = await createAction({ requiresApproval: false });
    upstreamAccepts();
    await halt.haltEnvironment(workspaceId, environmentId, { reason: "drill", actor: "test" });

    const res = await app.request(
      `/api/v2/actions/${action.id}/invoke`,
      authed({ method: "POST", body: JSON.stringify({ input: {} }) }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("ENVIRONMENT_HALTED");
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("blocks an already-approved invocation too: approval is not permission to act during a halt", async () => {
    const action = await createAction({ requiresApproval: true });
    upstreamAccepts();

    const parked = await app.request(
      `/api/v2/actions/${action.id}/invoke`,
      authed({ method: "POST", body: JSON.stringify({ input: {} }) }),
    );
    expect(parked.status).toBe(202);
    const { approvalId } = (await parked.json()).data;
    expect(approvalId).toBeTruthy();

    await halt.haltEnvironment(workspaceId, environmentId, { reason: "drill", actor: "test" });
    const reviewer = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'R', $2, false, now(), now())`,
      [reviewer, `${reviewer}@test.dev`],
    );
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'approver')`, [workspaceId, reviewer]);
    await approvals.approveApproval(
      workspaceId,
      approvalId,
      { deciderUserId: reviewer },
      environmentId,
    );

    expect(safeFetchMock).not.toHaveBeenCalled();
    const stored = await pool.query(
      `SELECT status, error_message FROM action_invocations
       WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [workspaceId],
    );
    expect(stored.rows[0].status).toBe("failed");
    expect(stored.rows[0].error_message).toContain("halt");
  });
});
