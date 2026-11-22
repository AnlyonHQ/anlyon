import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client) };
});

vi.mock("../src/lib/redis.ts", () => {
  const fn = () => async () => 0;
  const redis = new Proxy({}, { get: () => fn() });
  const RedisKeys = new Proxy({}, { get: (_t, key) => (...args: unknown[]) => `${String(key)}:${args.join(":")}` });
  return { redis, RedisKeys, default: redis };
});

vi.mock("../src/lib/resend-client.ts", () => ({ resendClient: {} }));

const previews = vi.hoisted(() => ({ getPreview: vi.fn() }));
vi.mock("../src/core/effects/service.ts", async (original) => ({
  ...(await original<typeof import("../src/core/effects/service.ts")>()),
  getPreview: previews.getPreview,
}));

const TEAM = "T0TEST";
const CHANNEL = "C0APPROVE";
const slack = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; body: Record<string, any> }>,
  users: new Map<string, { email: string | null; confirmed: boolean; guest?: "single" | "multi"; team?: string }>(),
  oidc: { user: "U_LINKME", team: "T0TEST" },
  ts: 0,
}));

const realFetch = globalThis.fetch;
const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = url.replace("https://slack.com/api/", "");
  if (!url.startsWith("https://slack.com/api/")) throw new Error(`Unexpected request to ${url}`);
  const raw = typeof init?.body === "string" ? init.body : "";
  const body = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
  slack.calls.push({ method, body });
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  switch (method) {
    case "chat.postMessage":
      slack.ts += 1;
      return json({ ok: true, channel: body.channel, ts: `1800000000.${String(slack.ts).padStart(6, "0")}` });
    case "chat.update":
    case "chat.postEphemeral":
    case "views.open":
    case "conversations.join":
      return json({ ok: true });
    case "users.info": {
      const u = slack.users.get(body.user);
      if (!u) return json({ ok: false, error: "user_not_found" });
      return json({
        ok: true,
        user: {
          id: body.user, team_id: u.team ?? TEAM, is_email_confirmed: u.confirmed,
          is_restricted: u.guest !== undefined, is_ultra_restricted: u.guest === "single",
          profile: { email: u.email, real_name: body.user },
        },
      });
    }
    case "openid.connect.token":
      return json({ ok: true, access_token: "xoxp-oidc-placeholder" });
    case "openid.connect.userInfo":
      return json({ ok: true, "https://slack.com/user_id": slack.oidc.user, "https://slack.com/team_id": slack.oidc.team });
    default:
      return json({ ok: false, error: "unknown_method" });
  }
});

const { env } = await import("../src/config/env.ts");
const SECRET = "test-slack-signing-secret";
Object.assign(env, {
  SLACK_SIGNING_SECRET: SECRET,
  SLACK_CLIENT_ID: "test-client-id",
  SLACK_CLIENT_SECRET: "test-client-secret",
  API_BASE_URL: "https://api.example.test",
  CONSOLE_URL: "https://console.example.test",
});
vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
vi.stubEnv("SLACK_CLIENT_ID", "test-client-id");
vi.stubEnv("SLACK_CLIENT_SECRET", "test-client-secret");

const { db } = await import("../src/db/index.ts");
const { approvals } = await import("../src/db/schema/approvals.ts");
const { slackApprovalMessages, slackApprovalActions, slackUserLinks } = await import("../src/db/schema/slack-approvals.ts");
const { encryptIntegrationToken } = await import("../src/utils/crypto.ts");
const { signSlackRequest } = await import("../src/core/slack-approvals/signature.ts");
const { postApprovalToSlack } = await import("../src/core/slack-approvals/service.ts");
const { sendToSlackIntegrations } = await import("../src/core/integrations/integration-service.ts");
const settings = await import("../src/core/slack-approvals/settings.ts");
const { slackPublicRouter, setSlackWorkScheduler } = await import("../src/api/routes/slack-approvals.ts");
const { eq } = await import("drizzle-orm");

const app = new Hono();
app.route("/api/slack", slackPublicRouter);
const pending: Promise<void>[] = [];
setSlackWorkScheduler((work) => pending.push(work));

const ws = "00000000-0000-4000-8000-0000000051a1";
const prod = "00000000-0000-4000-8000-0000000051a2";
const staging = "00000000-0000-4000-8000-0000000051a3";
const install = "00000000-0000-4000-8000-0000000051a4";
const sql = (text: string, params: unknown[] = []) => state.client!.query(text, params);

beforeAll(async () => {
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', 'ws-slack')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug, kind, is_default) VALUES ($1, $2, 'Production', 'prod', 'production', true)", [prod, ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug, kind) VALUES ($1, $2, 'Staging', 'staging', 'staging')", [staging, ws]);
  const people: Array<[string, string, boolean, boolean]> = [
    ["u_req", "req@example.test", true, true],
    ["u_bea", "bea@example.test", true, true],
    ["u_carl", "carl@example.test", true, false],
    ["u_dee", "dee@example.test", false, true],
    ["u_eve", "eve@example.test", false, true],
    ["u_gail", "gail@example.test", true, true],
    ["u_gus", "gus@example.test", true, true],
  ];
  for (const [id, email, verified, member] of people) {
    await sql("INSERT INTO \"user\" (id, name, email, email_verified) VALUES ($1, $2, $3, $4)", [id, id.slice(2).toUpperCase(), email, verified]);
    if (member) await sql("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws, id]);
  }
  await sql(
    `INSERT INTO integration_connections (id, workspace_id, type, name, slack_team_id, slack_team_name, slack_access_token_encrypted)
     VALUES ($1, $2, 'slack', 'Slack - Test', $3, 'Test', $4)`,
    [install, ws, TEAM, encryptIntegrationToken("xoxb-placeholder", env.INTEGRATION_ENCRYPTION_KEY!, ws)],
  );
  await sql("INSERT INTO slack_approval_routes (workspace_id, environment_id, integration_id, channel_id, channel_name) VALUES ($1, $2, $3, $4, 'approvals')", [ws, prod, install, CHANNEL]);
  await sql("INSERT INTO slack_user_links (workspace_id, slack_team_id, slack_user_id, user_id) VALUES ($1, $2, 'U_REQ', 'u_req'), ($1, $2, 'U_DEE', 'u_dee')", [ws, TEAM]);

  slack.users.set("U_BEA", { email: "BEA@example.test", confirmed: true });
  slack.users.set("U_BEA_UNCONFIRMED", { email: "bea@example.test", confirmed: false });
  slack.users.set("U_CARL", { email: "carl@example.test", confirmed: true });
  slack.users.set("U_EVE", { email: "eve@example.test", confirmed: true });
  slack.users.set("U_STRANGER", { email: "nobody@example.test", confirmed: true });
  slack.users.set("U_GAIL", { email: "gail@example.test", confirmed: true, guest: "multi" });
  slack.users.set("U_GUS", { email: "gus@example.test", confirmed: true, guest: "single" });
  slack.users.set("U_OUTSIDER", { email: "bea@example.test", confirmed: true, team: "T0OTHERORG" });
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  slack.calls.length = 0;
  previews.getPreview.mockReset();
  previews.getPreview.mockRejectedValue(new Error("not found"));
});

let n = 0;
async function newApproval(over: Partial<typeof approvals.$inferInsert> = {}) {
  const [row] = await db.insert(approvals).values({
    workspaceId: ws,
    environmentId: prod,
    approvalId: `apr_slack_${++n}`,
    kind: "custom",
    title: `Refund order ${n}`,
    description: "Customer was charged twice.",
    payload: { orderId: `ord_${n}`, amount: 1200 },
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    ...over,
  }).returning();
  await postApprovalToSlack(row.id);
  const [message] = await db.select().from(slackApprovalMessages).where(eq(slackApprovalMessages.approvalId, row.id));
  return { row, message };
}

async function signedPost(body: string, opts: { timestamp?: number; secret?: string } = {}) {
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const res = await app.request("/api/slack/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": signSlackRequest(opts.secret ?? SECRET, ts, body),
    },
    body,
  });
  await Promise.all(pending.splice(0));
  return res;
}

const form = (payload: unknown) => `payload=${encodeURIComponent(JSON.stringify(payload))}`;

function clickPayload(message: { messageTs: string | null; channelId: string }, approvalId: string, actionId: string, slackUser: string) {
  return {
    type: "block_actions",
    team: { id: TEAM },
    user: { id: slackUser, team_id: TEAM },
    trigger_id: "trigger-1",
    channel: { id: message.channelId },
    message: { ts: message.messageTs },
    actions: [{ action_id: actionId, value: approvalId }],
  };
}

async function click(message: { messageTs: string | null; channelId: string }, approvalId: string, actionId: string, slackUser: string) {
  return signedPost(form(clickPayload(message, approvalId, actionId, slackUser)));
}

const current = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0];
const attempts = async (id: string) => db.select().from(slackApprovalActions).where(eq(slackApprovalActions.approvalId, id));
const ephemerals = () => slack.calls.filter((c) => c.method === "chat.postEphemeral").map((c) => c.body);
const lastUpdate = () => [...slack.calls].reverse().find((c) => c.method === "chat.update")?.body;

describe("posting", () => {
  it("posts a pending approval once, to its environment's channel, with the request and the buttons", async () => {
    const { row, message } = await newApproval();
    await postApprovalToSlack(row.id);
    const posts = slack.calls.filter((c) => c.method === "chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0].body.channel).toBe(CHANNEL);
    const blocks = JSON.stringify(posts[0].body.blocks);
    expect(blocks).toContain("Executes in *Production*");
    expect(blocks).toContain("orderId: `ord_");
    expect(blocks).toContain("anlyon_approve");
    expect(message.messageTs).toMatch(/^1800000000\./);
  });

  it("does not post for an environment without a channel", async () => {
    await newApproval({ environmentId: staging });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
  });
});

describe("the interactivity endpoint", () => {
  it("refuses a bad signature and a stale timestamp, and decides nothing", async () => {
    const { row, message } = await newApproval();
    const body = form(clickPayload(message, row.approvalId, "anlyon_approve", "U_BEA"));
    expect((await signedPost(body, { secret: "wrong-secret" })).status).toBe(401);
    expect((await signedPost(body, { timestamp: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    const unsigned = await app.request("/api/slack/interactions", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(unsigned.status).toBe(401);
    expect((await current(row.id)).status).toBe("pending");
  });

  it("ignores a click whose button names another approval than the message it is on", async () => {
    const { row, message } = await newApproval();
    const other = await newApproval();
    const res = await click(message, other.row.approvalId, "anlyon_approve", "U_BEA");
    expect(res.status).toBe(200);
    expect((await current(row.id)).status).toBe("pending");
    expect((await current(other.row.id)).status).toBe("pending");
  });
});

describe("deciding from Slack", () => {
  it("a member matched by Slack-confirmed email approves; the message shows who and when", async () => {
    const { row, message } = await newApproval();
    const res = await click(message, row.approvalId, "anlyon_approve", "U_BEA");
    expect(res.status).toBe(200);
    const after = await current(row.id);
    expect(after.status).toBe("approved");
    expect(after.decidedByUserId).toBe("u_bea");
    expect(after.decisionOrigin).toBe("human");
    const [attempt] = await attempts(row.id);
    expect(attempt).toMatchObject({ slackUserId: "U_BEA", userId: "u_bea", identifiedBy: "email", result: "recorded" });
    await vi.waitFor(() => expect(JSON.stringify(lastUpdate()?.blocks)).toContain("*Approved* by BEA (<@U_BEA>) <!date^"));
    expect(lastUpdate()?.ts).toBe(message.messageTs);
  });

  it("denies, with no Approve left on the updated message", async () => {
    const { row, message } = await newApproval();
    await click(message, row.approvalId, "anlyon_deny", "U_BEA");
    expect((await current(row.id)).status).toBe("denied");
    await vi.waitFor(() => expect(JSON.stringify(lastUpdate()?.blocks)).toContain("*Denied* by BEA"));
    expect(JSON.stringify(lastUpdate()?.blocks)).not.toContain("anlyon_approve");
  });

  it("refuses a Slack user who cannot be mapped, and says how to link", async () => {
    for (const slackUser of ["U_STRANGER", "U_BEA_UNCONFIRMED", "U_CARL", "U_EVE"]) {
      slack.calls.length = 0;
      const { row, message } = await newApproval();
      await click(message, row.approvalId, "anlyon_approve", slackUser);
      expect((await current(row.id)).status).toBe("pending");
      expect((await attempts(row.id))[0]).toMatchObject({ result: "refused", reason: "unlinked", userId: null });
      expect(ephemerals()[0]).toMatchObject({ channel: CHANNEL, user: slackUser });
      expect(ephemerals()[0].text).toContain("https://console.example.test/settings/integrations");
    }
  });

  it("an explicit link identifies a member whose email cannot", async () => {
    const { row, message } = await newApproval();
    await click(message, row.approvalId, "anlyon_approve", "U_DEE");
    expect((await current(row.id)).decidedByUserId).toBe("u_dee");
    expect((await attempts(row.id))[0]).toMatchObject({ identifiedBy: "link", result: "recorded" });
  });

  it("a Slack guest is never matched by email, single- or multi-channel; an explicit link works", async () => {
    for (const slackUser of ["U_GAIL", "U_GUS"]) {
      slack.calls.length = 0;
      const { row, message } = await newApproval();
      await click(message, row.approvalId, "anlyon_approve", slackUser);
      expect((await current(row.id)).status).toBe("pending");
      expect((await attempts(row.id))[0]).toMatchObject({ result: "refused", reason: "guest", userId: null });
      expect(ephemerals()[0].text).toContain("Slack guests are not matched");
      expect(ephemerals()[0].text).toContain("https://console.example.test/settings/integrations");
    }
    await sql("INSERT INTO slack_user_links (workspace_id, slack_team_id, slack_user_id, user_id) VALUES ($1, $2, 'U_GAIL', 'u_gail')", [ws, TEAM]);
    const { row, message } = await newApproval();
    await click(message, row.approvalId, "anlyon_approve", "U_GAIL");
    expect(await current(row.id)).toMatchObject({ status: "approved", decidedByUserId: "u_gail" });
    expect((await attempts(row.id))[0]).toMatchObject({ identifiedBy: "link", result: "recorded" });
  });

  it("the requester cannot decide their own request while another member can", async () => {
    const { row, message } = await newApproval({ requestedByUserId: "u_req", requestedByOAuthClientId: "client_1" });
    for (const action of ["anlyon_approve", "anlyon_deny"]) await click(message, row.approvalId, action, "U_REQ");
    expect((await current(row.id)).status).toBe("pending");
    expect((await attempts(row.id)).map((a) => a.reason)).toEqual(["requester", "requester"]);
    expect(ephemerals()[0].text).toContain("an app acting for you requested it");
    expect(ephemerals()[0].text).toContain("Another member who can decide approvals in this environment");
  });

  it("the only member who can decide in the environment decides their own agent's request from Slack, marked self-approved", async () => {
    const solo = "00000000-0000-4000-8000-0000000051a5";
    await sql("INSERT INTO environments (id, workspace_id, name, slug, kind) VALUES ($1, $2, 'Solo', 'solo', 'production')", [solo, ws]);
    await sql("INSERT INTO slack_approval_routes (workspace_id, environment_id, integration_id, channel_id, channel_name) VALUES ($1, $2, $3, $4, 'approvals')", [ws, solo, install, CHANNEL]);
    for (const other of ["u_bea", "u_dee", "u_eve", "u_gail", "u_gus"]) {
      await sql("INSERT INTO member_environment_roles (workspace_id, user_id, environment_id, role) VALUES ($1, $2, $3, 'viewer')", [ws, other, solo]);
    }

    const keyId = "00000000-0000-4000-8000-0000000051a6";
    await sql("INSERT INTO api_keys (id, workspace_id, environment_id, name, key_hash, key_prefix, created_by) VALUES ($1, $2, $3, 'agent', 'hash-solo-agent', 'anlyon_l', 'u_req')", [keyId, ws, solo]);
    for (const over of [
      { requestedByUserId: "u_req", requestedByOAuthClientId: "client_1" },
      { requestedByKeyId: keyId },
    ]) {
      const { row, message } = await newApproval({ environmentId: solo, ...over });
      expect(message).toBeDefined();
      await click(message, row.approvalId, "anlyon_approve", "U_REQ");

      expect(await current(row.id)).toMatchObject({ status: "approved", decidedByUserId: "u_req" });
      expect((await attempts(row.id))[0]).toMatchObject({ result: "recorded", userId: "u_req" });
      const [vote] = (await sql("SELECT self_approved FROM approval_decisions WHERE approval_id = $1", [row.id])).rows as Array<{ self_approved: boolean }>;
      expect(vote.self_approved).toBe(true);
      const audit = (await sql("SELECT data FROM audit_events WHERE type = 'approval.vote' AND resource_id = $1", [row.approvalId])).rows as Array<{ data: { selfApproved: boolean } }>;
      expect(audit).toHaveLength(1);
      expect(audit[0].data.selfApproved).toBe(true);
      expect(JSON.stringify(lastUpdate()?.blocks)).toContain("Self-approved (only approver in this environment)");
    }

    await sql("DELETE FROM member_environment_roles WHERE environment_id = $1 AND user_id = 'u_bea'", [solo]);
    const { row, message } = await newApproval({ environmentId: solo, requestedByUserId: "u_req", requestedByOAuthClientId: "client_1" });
    await click(message, row.approvalId, "anlyon_approve", "U_REQ");
    expect((await current(row.id)).status).toBe("pending");
    expect((await attempts(row.id))[0]).toMatchObject({ result: "refused", reason: "requester" });

    await sql("DELETE FROM slack_approval_routes WHERE environment_id = $1", [solo]);
    await sql("DELETE FROM member_environment_roles WHERE environment_id = $1", [solo]);
  });

  it("quorum: the first vote keeps it open, a second decider finalizes it, a repeat vote is refused", async () => {
    const { row, message } = await newApproval({ requiredApprovals: 2 });
    await click(message, row.approvalId, "anlyon_approve", "U_BEA");
    expect(await current(row.id)).toMatchObject({ status: "pending", approvedCount: 1 });
    expect(ephemerals().at(-1)?.text).toContain("1 of 2 approvals");
    await vi.waitFor(() => expect(JSON.stringify(lastUpdate()?.blocks)).toContain("Votes so far: approved by BEA"));

    await click(message, row.approvalId, "anlyon_approve", "U_BEA");
    expect((await attempts(row.id)).at(-1)).toMatchObject({ result: "refused", reason: "already_voted" });

    await click(message, row.approvalId, "anlyon_approve", "U_DEE");
    expect(await current(row.id)).toMatchObject({ status: "approved", approvedCount: 2, decidedByUserId: "u_dee" });
  });

  it("a click on an approval already decided elsewhere is refused and the message is brought up to date", async () => {
    const { row, message } = await newApproval();
    await db.update(approvals).set({ status: "denied", decidedAt: new Date(), decisionOrigin: "human", decidedByUserId: "u_req" })
      .where(eq(approvals.id, row.id));
    await click(message, row.approvalId, "anlyon_approve", "U_BEA");
    expect((await current(row.id)).status).toBe("denied");
    expect((await attempts(row.id))[0]).toMatchObject({ result: "refused", reason: "already_decided" });
    expect(ephemerals()[0].text).toContain("already denied");
    await vi.waitFor(() => expect(JSON.stringify(lastUpdate()?.blocks)).toContain("*Denied* by REQ"));
  });

  it("a click on an expired approval expires it and shows it expired", async () => {
    const { row, message } = await newApproval();
    await db.update(approvals).set({ expiresAt: new Date(Date.now() - 3600 * 1000) }).where(eq(approvals.id, row.id));
    await click(message, row.approvalId, "anlyon_approve", "U_BEA");
    expect((await current(row.id)).status).toBe("expired");
    expect((await attempts(row.id))[0]).toMatchObject({ result: "refused", reason: "already_decided" });
    await vi.waitFor(() => expect(JSON.stringify(lastUpdate()?.blocks)).toContain("*Expired*"));
  });

  it("refuses Approve when the bound preview has expired; Deny still decides", async () => {
    const digest = "d".repeat(64);
    previews.getPreview.mockResolvedValue({
      id: "prv_bound", blocks: [], allowances: [], bindingDigest: digest, expiresAt: new Date(Date.now() - 1000),
    });
    const { row, message } = await newApproval({ previewId: "prv_bound", bindingDigest: digest });
    expect(JSON.stringify(slack.calls.find((c) => c.method === "chat.postMessage")?.body.blocks)).not.toContain("anlyon_approve");
    await click(message, row.approvalId, "anlyon_approve", "U_BEA");
    expect((await current(row.id)).status).toBe("pending");
    expect((await attempts(row.id))[0]).toMatchObject({ result: "refused", reason: "preview" });
    await click(message, row.approvalId, "anlyon_deny", "U_BEA");
    expect((await current(row.id)).status).toBe("denied");
  });

  it("decide with a note: the dialog opens bound to the message, and the note is recorded", async () => {
    const { row, message } = await newApproval();
    await click(message, row.approvalId, "anlyon_note", "U_BEA");
    const opened = slack.calls.find((c) => c.method === "views.open")?.body;
    expect(opened?.trigger_id).toBe("trigger-1");
    expect(opened?.view.private_metadata).toBe(message.id);

    const submit = (decision: string | null, note: string) => form({
      type: "view_submission",
      team: { id: TEAM },
      user: { id: "U_BEA", team_id: TEAM },
      view: {
        callback_id: "anlyon_decision_note",
        private_metadata: message.id,
        state: { values: { decision: { decision_input: { selected_option: decision ? { value: decision } : null } }, note: { note_input: { value: note } } } },
      },
    });
    const invalid = await signedPost(submit(null, "x"));
    expect(await invalid.json()).toMatchObject({ response_action: "errors" });

    const res = await signedPost(submit("deny", "Order was already refunded by support."));
    expect(await res.json()).toEqual({ response_action: "clear" });
    expect(await current(row.id)).toMatchObject({ status: "denied", decisionNote: "Order was already refunded by support." });
  });

  it("removing the environment's channel turns Slack decisions off, even on posted messages", async () => {
    const { row, message } = await newApproval();
    await settings.removeSlackApprovalRoute(ws, prod);
    try {
      await click(message, row.approvalId, "anlyon_approve", "U_BEA");
      expect((await current(row.id)).status).toBe("pending");
      expect((await attempts(row.id))[0]).toMatchObject({ reason: "routing_removed" });
    } finally {
      await sql("INSERT INTO slack_approval_routes (workspace_id, environment_id, integration_id, channel_id, channel_name) VALUES ($1, $2, $3, $4, 'approvals')", [ws, prod, install, CHANNEL]);
    }
  });
});

describe("the plain approval notification", () => {
  const notification = (approvalId: string) => ({
    id: "00000000-0000-4000-8000-0000000051f1",
    workspaceId: ws,
    type: "approval_requested",
    priority: "high",
    title: "Approval needed",
    message: "An agent is waiting for your decision.",
    metadata: { approvalId },
    actionUrl: null,
    actionLabel: null,
  }) as never;
  const plainPosts = () => slack.calls.filter((c) => c.method === "chat.postMessage");

  it("skips the channel the approval is posted to with buttons, and only that channel", async () => {
    await sql("UPDATE integration_connections SET slack_channel_id = $1, enabled_event_types = '[\"approval_requested\"]'::jsonb WHERE id = $2", [CHANNEL, install]);
    try {
      const inProd = await newApproval();
      const inStaging = await newApproval({ environmentId: staging });

      slack.calls.length = 0;
      expect(await sendToSlackIntegrations(notification(inProd.row.approvalId))).toEqual({ sent: 0, failed: 0 });
      expect(plainPosts()).toHaveLength(0);

      expect(await sendToSlackIntegrations(notification(inStaging.row.approvalId))).toEqual({ sent: 1, failed: 0 });
      expect(plainPosts()[0].body.channel).toBe(CHANNEL);

      slack.calls.length = 0;
      await sql("UPDATE integration_connections SET slack_channel_id = 'C0OTHER' WHERE id = $1", [install]);
      expect(await sendToSlackIntegrations(notification(inProd.row.approvalId))).toEqual({ sent: 1, failed: 0 });
      expect(plainPosts()[0].body.channel).toBe("C0OTHER");

      slack.calls.length = 0;
      await sql("UPDATE integration_connections SET slack_channel_id = $1 WHERE id = $2", [CHANNEL, install]);
      Object.assign(env, { SLACK_SIGNING_SECRET: undefined });
      vi.stubEnv("SLACK_SIGNING_SECRET", undefined);
      try {
        expect(await sendToSlackIntegrations(notification(inProd.row.approvalId))).toEqual({ sent: 1, failed: 0 });
      } finally {
        Object.assign(env, { SLACK_SIGNING_SECRET: SECRET });
        vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
      }
    } finally {
      await sql("UPDATE integration_connections SET slack_channel_id = NULL WHERE id = $1", [install]);
    }
  });
});

describe("settings", () => {
  it("routes an environment to a channel (joining it) and lists it", async () => {
    const result = await settings.setSlackApprovalRoute({
      workspaceId: ws, environmentId: staging, integrationId: install, channelId: "C0STAGING", channelName: "staging-approvals", userId: "u_bea",
    });
    expect(result.autoJoined).toBe(true);
    expect(slack.calls.some((c) => c.method === "conversations.join" && c.body.channel === "C0STAGING")).toBe(true);
    const view = await settings.getSlackApprovalsSettings(ws, "u_dee");
    expect(view.requestUrl).toBe("https://api.example.test/api/slack/interactions");
    expect(view.routes.map((r) => r.environmentId).sort()).toEqual([prod, staging].sort());
    expect(view.links).toEqual([expect.objectContaining({ slackUserId: "U_DEE" })]);
    await settings.removeSlackApprovalRoute(ws, staging);
  });

  it("links a Slack account only for the member who started it, once, in a connected Slack workspace", async () => {
    const start = async () => {
      const { authUrl } = await settings.startSlackIdentityLink(ws, "u_eve");
      expect(authUrl).toContain("https://slack.com/openid/connect/authorize?");
      return new URL(authUrl).searchParams.get("state")!;
    };
    const hasAccess = async () => true;

    const s1 = await start();
    expect(await settings.finishSlackIdentityLink({ state: s1, code: "c", sessionUserId: "u_bea", hasAccess })).toMatchObject({ ok: false });
    expect(await settings.finishSlackIdentityLink({ state: s1, code: "c", sessionUserId: "u_eve", hasAccess })).toMatchObject({ ok: false });

    slack.oidc = { user: "U_EVE2", team: "T0OTHER" };
    const s2 = await start();
    expect(await settings.finishSlackIdentityLink({ state: s2, code: "c", sessionUserId: "u_eve", hasAccess })).toMatchObject({ ok: false });

    slack.oidc = { user: "U_EVE2", team: TEAM };
    const s3 = await start();
    expect(await settings.finishSlackIdentityLink({ state: s3, code: "c", sessionUserId: "u_eve", hasAccess })).toEqual({ ok: true, workspaceId: ws });
    const links = await db.select().from(slackUserLinks).where(eq(slackUserLinks.userId, "u_eve"));
    expect(links).toEqual([expect.objectContaining({ slackUserId: "U_EVE2", slackTeamId: TEAM })]);

    const { row, message } = await newApproval();
    await click(message, row.approvalId, "anlyon_approve", "U_EVE2");
    expect((await current(row.id)).decidedByUserId).toBe("u_eve");

    expect(await settings.unlinkSlackIdentity(ws, "u_eve")).toBe(1);
  });
});

describe("who may route approvals to Slack and decide them there", () => {
  it("a key or app changes only its own environment's Slack channel; a console session any", async () => {
    const { routeEnvironment } = await import("../src/api/routes/slack-approvals.ts");
    const probe = (authType: string, credentialEnvironment: string | undefined) => {
      const mini = new Hono();
      mini.use("*", async (c, next) => {
        c.set("authType" as never, authType as never);
        c.set("environmentId" as never, credentialEnvironment as never);
        await next();
      });
      mini.put("/routes/:environmentId", (c) => c.json({ environmentId: routeEnvironment(c) }));
      mini.onError((error, c) => c.json({ error: error.message }, 403));
      return mini.request(`/routes/${prod}`, { method: "PUT" });
    };
    expect((await probe("apiKey", prod)).status).toBe(200);
    expect((await probe("apiKey", staging)).status).toBe(403);
    expect((await probe("apiKey", undefined)).status).toBe(403);
    expect((await probe("oauth", staging)).status).toBe(403);
    expect((await probe("session", staging)).status).toBe(200);
  });

  it("a console request records the session user as requester; keys and apps do not", async () => {
    const { sessionRequester } = await import("../src/api/policy-actor.ts");
    const ctx = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as never;
    expect(sessionRequester(ctx({ authType: "session", userId: "u_req" }))).toBe("u_req");
    expect(sessionRequester(ctx({ authType: "oauth", userId: "u_req" }))).toBeUndefined();
    expect(sessionRequester(ctx({ authType: "apiKey" }))).toBeUndefined();
  });

  it("never matches a user of another Slack organisation by email", async () => {
    const { row, message } = await newApproval();
    await click(message, row.approvalId, "anlyon_approve", "U_OUTSIDER");
    expect((await current(row.id)).status).toBe("pending");
    expect((await attempts(row.id))[0]).toMatchObject({ result: "refused", reason: "unlinked", userId: null });
  });

  it("enforced SSO: a member needs a live session from the workspace's identity provider to decide from Slack", async () => {
    await sql("INSERT INTO sso_provider (id, issuer, provider_id, domain, domain_verified) VALUES ('sp-slack', 'https://idp.example.test', 'anlyon-slack-sso', 'example.test', true)");
    await sql(
      `INSERT INTO workspace_sso_connections (workspace_id, provider_id, protocol, domains, domain_verification_token, domains_verified_at, enforced)
       VALUES ($1, 'anlyon-slack-sso', 'oidc', '["example.test"]', 'tok', now(), true)`,
      [ws],
    );
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().replace("Z", "");
    try {
      const first = await newApproval();
      await click(first.message, first.row.approvalId, "anlyon_approve", "U_BEA");
      expect((await current(first.row.id)).status).toBe("pending");
      expect((await attempts(first.row.id))[0]).toMatchObject({ result: "refused", reason: "sso_required", userId: "u_bea" });
      expect(ephemerals().at(-1)?.text).toContain("single sign-on");

      await sql("INSERT INTO session (id, expires_at, token, updated_at, user_id) VALUES ('s-old', $1, 'tok-old', now(), 'u_bea')", [at(-3_600_000)]);
      await sql("INSERT INTO sso_sessions (session_id, provider_id) VALUES ('s-old', 'anlyon-slack-sso')");
      await click(first.message, first.row.approvalId, "anlyon_approve", "U_BEA");
      expect((await current(first.row.id)).status).toBe("pending");

      await sql("INSERT INTO session (id, expires_at, token, updated_at, user_id) VALUES ('s-pw', $1, 'tok-pw', now(), 'u_bea')", [at(3_600_000)]);
      await click(first.message, first.row.approvalId, "anlyon_approve", "U_BEA");
      expect((await current(first.row.id)).status).toBe("pending");
      await sql("INSERT INTO session (id, expires_at, token, updated_at, user_id) VALUES ('s-sso', $1, 'tok-sso', now(), 'u_bea')", [at(3_600_000)]);
      await sql("INSERT INTO sso_sessions (session_id, provider_id) VALUES ('s-sso', 'anlyon-slack-sso')");
      await click(first.message, first.row.approvalId, "anlyon_approve", "U_BEA");
      expect(await current(first.row.id)).toMatchObject({ status: "approved", decidedByUserId: "u_bea" });
    } finally {
      await sql("DELETE FROM workspace_sso_connections WHERE workspace_id = $1", [ws]);
      await sql("DELETE FROM session WHERE user_id = 'u_bea'");
      await sql("DELETE FROM sso_provider WHERE id = 'sp-slack'");
    }
  });

  it("quorum: a person and the keys they created count as one decider", async () => {
    const { approveApproval } = await import("../src/core/approvals/service.ts");
    const key = "00000000-0000-4000-8000-0000000051b1";
    await sql(
      "INSERT INTO api_keys (id, workspace_id, environment_id, name, key_hash, key_prefix, created_by) VALUES ($1, $2, $3, 'bea-approver', 'hash-bea', 'anlyon_l', 'u_bea')",
      [key, ws, prod],
    );
    const { row, message } = await newApproval({ requiredApprovals: 2 });
    await approveApproval(ws, row.approvalId, { deciderKeyId: key }, prod);
    expect(await current(row.id)).toMatchObject({ status: "pending", approvedCount: 1 });

    await click(message, row.approvalId, "anlyon_approve", "U_BEA");
    expect(await current(row.id)).toMatchObject({ status: "pending", approvedCount: 1 });

    await click(message, row.approvalId, "anlyon_approve", "U_DEE");
    expect(await current(row.id)).toMatchObject({ status: "approved", approvedCount: 2, decidedByUserId: "u_dee" });
  });

  it("a request made from a console session records its requester, who cannot decide it while others can", async () => {
    const { createApproval, approveApproval } = await import("../src/core/approvals/service.ts");
    const { SelfApprovalError } = await import("../src/utils/errors.ts");
    const created = await createApproval(ws, { title: "Rotate the signing key" }, { requestedByUserId: "u_req", environmentId: prod });
    const [row] = await db.select().from(approvals).where(eq(approvals.approvalId, created.id));
    expect(row).toMatchObject({ requestedByUserId: "u_req", requestedByKeyId: null, requestedByOAuthClientId: null });

    await expect(approveApproval(ws, row.approvalId, { deciderUserId: "u_req" }, prod)).rejects.toBeInstanceOf(SelfApprovalError);
    const [message] = await db.select().from(slackApprovalMessages).where(eq(slackApprovalMessages.approvalId, row.id));
    if (message) {
      await click(message, row.approvalId, "anlyon_approve", "U_REQ");
      expect((await attempts(row.id))[0]).toMatchObject({ result: "refused", reason: "requester" });
    }
    expect((await current(row.id)).status).toBe("pending");
    await approveApproval(ws, row.approvalId, { deciderUserId: "u_bea" }, prod);
    expect(await current(row.id)).toMatchObject({ status: "approved", decidedByUserId: "u_bea" });
  });
});
