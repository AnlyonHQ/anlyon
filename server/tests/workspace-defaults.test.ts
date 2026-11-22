import type { PGlite } from "@electric-sql/pglite";
import { Hono, type Context, type Next } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  client: undefined as PGlite | undefined,
  counters: new Map<string, number>(),
  caller: "user_admin",
}));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client), pool: { end: async () => {} } };
});
vi.mock("../src/lib/redis.ts", () => {
  const redis = {
    async incr(key: string) {
      const next = (state.counters.get(key) ?? 0) + 1;
      state.counters.set(key, next);
      return next;
    },
    async decr(key: string) {
      const next = (state.counters.get(key) ?? 0) - 1;
      state.counters.set(key, next);
      return next;
    },
    async get() { return null; },
    async set() { return "OK"; },
    async del() { return 1; },
    async exists() { return 0; },
    async expire() { return 1; },
  };
  const RedisKeys = new Proxy({}, { get: (_t, name) => (...parts: unknown[]) => `${String(name)}:${parts.join(":")}` });
  return { redis, redisBlocking: redis, RedisKeys, createBlockingConnection: () => redis };
});
vi.mock("../src/utils/auth.ts", () => ({
  auth: {}, AUTH_BASE_PATH: "/api/auth", OAUTH_ISSUER: "http://localhost/api/auth", MCP_RESOURCE_URL: "http://localhost/mcp",
}));
vi.mock("../src/api/middleware/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/middleware/auth.ts")>();
  return {
    ...actual,
    requireSession: async (c: Context, next: Next) => {
      c.set("authType", "session");
      c.set("userId", state.caller);
      c.set("workspaceId", c.req.param("workspaceId"));
      await next();
    },
    requireWorkspaceAccess: async (_c: Context, next: Next) => next(),
  };
});
vi.mock("../src/core/events/emitter.ts", () => ({ emitEvent: vi.fn() }));
vi.mock("../src/core/notifications/email-service.ts", () => ({ sendEmailNotification: vi.fn(async () => undefined) }));
vi.mock("../src/core/integrations/integration-service.ts", () => ({
  sendToSlackIntegrations: vi.fn(async () => ({ sent: 0, failed: 0 })),
  sendToDiscordIntegrations: vi.fn(async () => ({ sent: 0, failed: 0 })),
}));
vi.mock("../src/core/assistant/service.ts", () => ({ onApprovalAnnounced: async () => false }));
vi.mock("../src/lib/product-events.ts", () => ({ captureMilestoneOnce: vi.fn(), capture: vi.fn() }));

const defaults = await import("../src/core/workspace/defaults.ts");
const { withDefaultDecider } = await import("../src/core/approvals/policy.ts");
const { combinePlanDecisions } = await import("../src/core/functions/plans.ts");
const approvals = await import("../src/core/approvals/service.ts");
const { putSecret, markSecretNeedsReauth } = await import("../src/core/actions/secrets.ts");
const { default: workspacesRouter } = await import("../src/api/routes/workspaces.ts");
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const { env: config } = await import("../src/config/env.ts");

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/api/v2/workspaces", workspacesRouter);

const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  state.client!.query<T>(text, params).then((result) => result.rows);

let seq = 0;
async function workspace(): Promise<{ id: string; env: string }> {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  const env = `00000000-0000-4000-9000-${String(seq).padStart(12, "0")}`;
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Defaults', $2)", [id, `defaults-${seq}`]);
  await sql(
    "INSERT INTO environments (id, workspace_id, name, slug, kind, is_default) VALUES ($1, $2, 'Production', 'production', 'production', true)",
    [env, id],
  );
  for (const [userId, role] of [["user_admin", "admin"], ["user_member", "member"], ["user_viewer", "viewer"]]) {
    await sql(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $1, $2, true, now(), now()) ON CONFLICT DO NOTHING`,
      [userId, `${userId}@example.com`],
    );
    await sql("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)", [id, userId, role]);
  }
  return { id, env };
}

const request = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const alerts = (workspaceId: string, type: string) =>
  sql<{ title: string; action_url: string }>("SELECT title, action_url FROM notifications WHERE workspace_id = $1 AND type = $2", [workspaceId, type]);

beforeAll(async () => {
  await import("../src/db/index.ts");
}, 120_000);

describe("storage", () => {
  it("answers the recommendations for a workspace that never said, which are what it did before", async () => {
    const { id } = await workspace();
    expect(await defaults.getWorkspaceDefaults(id)).toEqual({
      actingFor: null,
      endUserDecider: null,
      approvalWindowHours: null,
      effective: { endUserDecider: "team", approvalWindowHours: config.APPROVAL_DEFAULT_TTL_HOURS },
      recommended: { actingFor: "both", endUserDecider: "team", approvalWindowHours: config.APPROVAL_DEFAULT_TTL_HOURS },
      setup: { status: null, at: null },
      updatedAt: null,
    });
  });

  it("recommends the team deciding whoever the agent acts for, and null returns an answer to that", async () => {
    const { id } = await workspace();
    for (const actingFor of ["users", "both", "team"] as const) {
      const view = await defaults.updateWorkspaceDefaults(id, "user_admin", { actingFor });
      expect(view.recommended.endUserDecider).toBe("team");
      expect(view.effective.endUserDecider).toBe("team");
    }

    let view = await defaults.updateWorkspaceDefaults(id, "user_admin", { endUserDecider: "end_user", approvalWindowHours: 4 });
    expect(view).toMatchObject({ actingFor: "team", endUserDecider: "end_user", approvalWindowHours: 4 });
    expect(view.effective).toEqual({ endUserDecider: "end_user", approvalWindowHours: 4 });
    expect(await defaults.endUserDeciderFor(id)).toBe("end_user");

    view = await defaults.updateWorkspaceDefaults(id, "user_admin", { endUserDecider: null, approvalWindowHours: null });
    expect(view.effective).toEqual({ endUserDecider: "team", approvalWindowHours: config.APPROVAL_DEFAULT_TTL_HOURS });
    expect(await defaults.endUserDeciderFor(id)).toBe("team");
    expect(await defaults.approvalWindowHoursFor(id)).toBe(config.APPROVAL_DEFAULT_TTL_HOURS);
  });

  it("records when the journey ended, and keeps one row per workspace", async () => {
    const { id } = await workspace();
    await defaults.updateWorkspaceDefaults(id, "user_admin", { setupStatus: "skipped" });
    const view = await defaults.updateWorkspaceDefaults(id, "user_admin", { setupStatus: "completed" });
    expect(view.setup.status).toBe("completed");
    expect(Date.parse(view.setup.at ?? "")).toBeGreaterThan(Date.now() - 60_000);
    expect(await sql("SELECT updated_by FROM workspace_defaults WHERE workspace_id = $1", [id])).toEqual([{ updated_by: "user_admin" }]);
  });

  it("refuses answers the product does not have", async () => {
    const { id } = await workspace();
    await expect(sql("INSERT INTO workspace_defaults (workspace_id, acting_for) VALUES ($1, 'everyone')", [id])).rejects.toThrow(/workspace_defaults_acting_for/);
    await expect(sql("INSERT INTO workspace_defaults (workspace_id, end_user_decider) VALUES ($1, 'agent')", [id])).rejects.toThrow(/workspace_defaults_end_user_decider/);
    await expect(sql("INSERT INTO workspace_defaults (workspace_id, approval_window_hours) VALUES ($1, 169)", [id])).rejects.toThrow(/workspace_defaults_approval_window/);
  });

  it("goes with its workspace", async () => {
    const { id } = await workspace();
    await defaults.updateWorkspaceDefaults(id, null, { actingFor: "team" });
    await sql("DELETE FROM workspaces WHERE id = $1", [id]);
    expect(await sql("SELECT 1 FROM workspace_defaults WHERE workspace_id = $1", [id])).toEqual([]);
  });
});

describe("GET and PATCH /workspaces/:id/defaults", () => {
  it("lets every member read them", async () => {
    const { id } = await workspace();
    for (const caller of ["user_admin", "user_member", "user_viewer"]) {
      state.caller = caller;
      const response = await request("GET", `/api/v2/workspaces/${id}/defaults`);
      expect(response.status).toBe(200);
      expect((await response.json()).data.effective.endUserDecider).toBe("team");
    }
  });

  it("lets only an admin change them", async () => {
    const { id } = await workspace();
    for (const caller of ["user_member", "user_viewer"]) {
      state.caller = caller;
      const response = await request("PATCH", `/api/v2/workspaces/${id}/defaults`, { endUserDecider: "end_user" });
      expect(response.status).toBe(403);
    }
    expect(await sql("SELECT 1 FROM workspace_defaults WHERE workspace_id = $1", [id])).toEqual([]);

    state.caller = "user_admin";
    const response = await request("PATCH", `/api/v2/workspaces/${id}/defaults`, {
      actingFor: "both", endUserDecider: null, approvalWindowHours: 72, setupStatus: "completed",
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      actingFor: "both",
      endUserDecider: null,
      approvalWindowHours: 72,
      effective: { endUserDecider: "team", approvalWindowHours: 72 },
      setup: { status: "completed" },
    });
  });

  it("refuses an empty body, an unknown field and an answer out of range", async () => {
    const { id } = await workspace();
    state.caller = "user_admin";
    for (const body of [{}, { approvalWindowHours: 0 }, { approvalWindowHours: 169 }, { approvalWindowHours: 1.5 }, { actingFor: "agents" }, { limitHit: "ask" }, { setupStatus: null }]) {
      const response = await request("PATCH", `/api/v2/workspaces/${id}/defaults`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("the audit record", () => {
  type AuditRow = {
    type: string;
    category: string;
    actor_type: string;
    actor_id: string | null;
    resource_type: string | null;
    resource_id: string | null;
    data: Record<string, unknown>;
  };
  const records = (workspaceId: string) =>
    sql<AuditRow>(
      "SELECT type, category, actor_type, actor_id, resource_type, resource_id, data FROM audit_events WHERE workspace_id = $1 AND type = 'workspace.defaults_updated' ORDER BY seq",
      [workspaceId],
    );

  it("records who changed which answers, before and after, and where in the console", async () => {
    const { id } = await workspace();
    state.caller = "user_admin";
    const response = await request("PATCH", `/api/v2/workspaces/${id}/defaults`, {
      actingFor: "users", endUserDecider: "end_user", approvalWindowHours: 4, setupStatus: "completed", source: "setup_journey",
    });
    expect(response.status).toBe(200);

    const [record, ...rest] = await records(id);
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      category: "access",
      actor_type: "user",
      actor_id: "user_admin",
      resource_type: "workspace",
      resource_id: id,
    });
    expect(record.data).toEqual({
      source: "setup_journey",
      changes: {
        actingFor: { before: null, after: "users" },
        endUserDecider: { before: null, after: "end_user" },
        approvalWindowHours: { before: null, after: 4 },
        setupStatus: { before: null, after: "completed" },
      },
      effective: {
        before: { endUserDecider: "team", approvalWindowHours: config.APPROVAL_DEFAULT_TTL_HOURS },
        after: { endUserDecider: "end_user", approvalWindowHours: 4 },
      },
    });
  });

  it("records a change of who the agent acts for, which leaves who decides with the team", async () => {
    const { id } = await workspace();
    state.caller = "user_admin";
    await request("PATCH", `/api/v2/workspaces/${id}/defaults`, { actingFor: "users", source: "defaults_page" });
    const [record] = await records(id);
    expect(record.data).toMatchObject({
      source: "defaults_page",
      changes: { actingFor: { before: null, after: "users" } },
      effective: { before: { endUserDecider: "team" }, after: { endUserDecider: "team" } },
    });
  });

  it("records dismissing the prompt on Home as setup skipped", async () => {
    const { id } = await workspace();
    state.caller = "user_admin";
    await request("PATCH", `/api/v2/workspaces/${id}/defaults`, { setupStatus: "skipped", source: "home_prompt" });
    const [record] = await records(id);
    expect(record.data).toMatchObject({ source: "home_prompt", changes: { setupStatus: { before: null, after: "skipped" } } });
  });

  it("writes nothing for a save that changes nothing, or a change that was refused", async () => {
    const { id } = await workspace();
    state.caller = "user_admin";
    await request("PATCH", `/api/v2/workspaces/${id}/defaults`, { approvalWindowHours: 72, source: "defaults_page" });
    await request("PATCH", `/api/v2/workspaces/${id}/defaults`, { approvalWindowHours: 72, source: "defaults_page" });
    state.caller = "user_member";
    expect((await request("PATCH", `/api/v2/workspaces/${id}/defaults`, { approvalWindowHours: 4 })).status).toBe(403);
    expect((await records(id)).map((record) => record.data.changes)).toEqual([
      { approvalWindowHours: { before: null, after: 72 } },
    ]);
  });

  it("says api when the caller did not name a source, and refuses a source alone or one it does not know", async () => {
    const { id } = await workspace();
    await defaults.updateWorkspaceDefaults(id, "user_admin", { endUserDecider: "end_user" });
    const [record] = await records(id);
    expect(record).toMatchObject({ actor_type: "user", actor_id: "user_admin" });
    expect(record.data.source).toBe("api");

    state.caller = "user_admin";
    for (const body of [{ source: "defaults_page" }, { approvalWindowHours: 4, source: "slack" }]) {
      const response = await request("PATCH", `/api/v2/workspaces/${id}/defaults`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await records(id)).toHaveLength(1);
  });
});

describe("the approval window", () => {
  it("is how long a new approval waits, and the instance default until the workspace chooses", async () => {
    const { id, env } = await workspace();
    const hours = (approval: { createdAt: Date | string; expiresAt: Date | string }) =>
      (new Date(approval.expiresAt).getTime() - new Date(approval.createdAt).getTime()) / 3_600_000;

    const before = await approvals.createApproval(id, { title: "Refund the order?" }, { requestedByUserId: "user_member", environmentId: env });
    expect(hours(before)).toBeCloseTo(config.APPROVAL_DEFAULT_TTL_HOURS, 1);

    await defaults.updateWorkspaceDefaults(id, "user_admin", { approvalWindowHours: 4 });
    const after = await approvals.createApproval(id, { title: "Refund the order?" }, { requestedByUserId: "user_member", environmentId: env });
    expect(hours(after)).toBeCloseTo(4, 1);

    const own = await approvals.createApproval(id, { title: "Quick one", expiresInSeconds: 600 }, { requestedByUserId: "user_member", environmentId: env });
    expect(hours(own)).toBeCloseTo(600 / 3600, 1);
  });
});

describe("who decides a call made for a user that no policy matched", () => {
  const unmatched = {
    matched: false, effect: "require_approval" as const, requiredApprovals: 1, matchedPolicyId: null, matchedPolicyVersion: null,
    matchedPolicyName: null, matchedActionName: null, explanation: "No policy matched; applied the default (require one approval).",
  };
  const matchedTeam = { ...unmatched, matched: true, matchedPolicyId: "apol_1", matchedPolicyVersion: 1, matchedPolicyName: "Team", decidedBy: "team" as const };

  it("is the user when the workspace says so, and says why", () => {
    const decision = withDefaultDecider(unmatched, "alice", "end_user");
    expect(decision.decidedBy).toBe("end_user");
    expect(decision.explanation).toMatch(/workspace default/);
  });

  it("stays the team for a call made for nobody, under a policy, or when the workspace says the team", () => {
    expect(withDefaultDecider(unmatched, null, "end_user").decidedBy).toBeUndefined();
    expect(withDefaultDecider(matchedTeam, "alice", "end_user").decidedBy).toBe("team");
    expect(withDefaultDecider(unmatched, "alice", "team").decidedBy).toBeUndefined();
  });

  it("makes a hosted function's plan the user's when every write is theirs that way", () => {
    const writes = [withDefaultDecider(unmatched, "alice", "end_user"), withDefaultDecider(unmatched, "alice", "end_user")];
    expect(combinePlanDecisions(writes, "alice")).toMatchObject({ decidedBy: "end_user", requiredApprovals: 1 });
    expect(combinePlanDecisions([writes[0]!, matchedTeam], "alice").decidedBy).toBe("team");
    expect(combinePlanDecisions([unmatched], "alice").decidedBy).toBe("team");
  });
});

describe("team alerts", () => {
  async function expireAll(workspaceId: string) {
    await sql("UPDATE approvals SET expires_at = now() - interval '1 minute' WHERE workspace_id = $1 AND status = 'pending'", [workspaceId]);
    await approvals.sweepExpiredApprovals(200, { workspaceId });
  }

  it("tells the team when its own request expires with no answer", async () => {
    const { id, env } = await workspace();
    const approval = await approvals.createApproval(id, { title: "Refund the order?" }, { requestedByUserId: "user_member", environmentId: env });
    await expireAll(id);
    const rows = await alerts(id, "approval_expired");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Request expired: Refund the order?");
    expect(rows[0]!.action_url).toMatch(new RegExp(`/approvals\\?id=${approval.id}$`));
  });

  it("does not tell the team when the workspace turned that alert off", async () => {
    const { id, env } = await workspace();
    await approvals.createApproval(id, { title: "Refund the order?" }, { requestedByUserId: "user_member", environmentId: env });
    await sql(`UPDATE notification_preferences SET enabled_types = '["approval_requested"]'::jsonb WHERE workspace_id = $1`, [id]);
    await expireAll(id);
    expect(await alerts(id, "approval_expired")).toEqual([]);
  });

  it("leaves a user's own request to the developer's app", async () => {
    const { id, env } = await workspace();
    await sql(
      `INSERT INTO approvals (workspace_id, environment_id, approval_id, kind, status, title, expires_at, end_user_id, decided_by)
       VALUES ($1, $2, 'apr_alice_own', 'custom', 'pending', 'Send the email', now() + interval '1 day', 'alice', 'end_user')`,
      [id, env],
    );
    await expireAll(id);
    expect(await sql("SELECT status FROM approvals WHERE approval_id = 'apr_alice_own'")).toEqual([{ status: "expired" }]);
    expect(await alerts(id, "approval_expired")).toEqual([]);
  });

  it("tells the team once when one of its accounts stops working, and not when that alert is off", async () => {
    const { id, env } = await workspace();
    await putSecret(id, "GITHUB", { value: "ghp_workspace_token_00", integrationId: "github", allowedHosts: ["api.github.com"], checked: true }, env);
    expect(await markSecretNeedsReauth({ workspaceId: id, environmentId: env, name: "GITHUB" }, "access_revoked")).toBe(1);
    expect(await markSecretNeedsReauth({ workspaceId: id, environmentId: env, name: "GITHUB" }, "access_revoked")).toBe(0);
    await vi.waitFor(async () => expect(await alerts(id, "connection_broken")).toHaveLength(1));
    const [alert] = await alerts(id, "connection_broken");
    expect(alert!.title).toBe("Reconnect GITHUB");
    expect(alert!.action_url).toMatch(/\/integrations\?integration=github$/);

    const quiet = await workspace();
    await sql(
      `INSERT INTO notification_preferences (workspace_id, enabled_types) VALUES ($1, '["approval_requested"]'::jsonb)`,
      [quiet.id],
    );
    await putSecret(quiet.id, "GITHUB", { value: "ghp_workspace_token_00", integrationId: "github", allowedHosts: ["api.github.com"], checked: true }, quiet.env);
    expect(await markSecretNeedsReauth({ workspaceId: quiet.id, environmentId: quiet.env, name: "GITHUB" }, "key_rejected")).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await alerts(quiet.id, "connection_broken")).toEqual([]);
  });

  it("is on in a new workspace's notification preferences", async () => {
    const fresh = await workspace();
    await sql("INSERT INTO notification_preferences (workspace_id) VALUES ($1)", [fresh.id]);
    const [{ enabled_types }] = await sql<{ enabled_types: string[] }>("SELECT enabled_types FROM notification_preferences WHERE workspace_id = $1", [fresh.id]);
    expect(enabled_types).toEqual(expect.arrayContaining(["approval_requested", "approval_expired", "outcome_unknown", "connection_broken"]));
  });
});
