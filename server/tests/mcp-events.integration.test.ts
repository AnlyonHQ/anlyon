import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@anlyon/feature-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anlyon/feature-flags")>();
  return { ...actual, isFeatureEnabled: (feature: string) => feature === "mcp-events" || actual.isFeatureEnabled(feature as never) };
});

const CALLBACK_ORIGIN = "https://hooks.chatgpt.test";
let callbackPort = 0;

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return {
    ...actual,
    safeFetch: (url: string, init?: RequestInit) =>
      url.startsWith(CALLBACK_ORIGIN)
        ? fetch(`http://127.0.0.1:${callbackPort}${new URL(url).pathname}`, { ...init, redirect: "error" })
        : actual.safeFetch(url, init),
  };
});

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  raw: string;
  body: Record<string, unknown>;
}

function verifyStandardWebhook(secret: string, received: Received): boolean {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key)
    .update(`${received.headers["webhook-id"]}.${received.headers["webhook-timestamp"]}.${received.raw}`)
    .digest("base64");
  return String(received.headers["webhook-signature"])
    .split(" ")
    .some((candidate) => candidate === `v1,${expected}`);
}

const suffix = randomUUID().slice(0, 8);
const userId = `mcp_events_user_${suffix}`;
const clientId = `mcp_events_client_${suffix}`;

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("MCP Events through the hosted route", () => {
  let pool: Pool;
  let app: { close: (cb?: () => void) => void } | undefined;
  let callback: Server | undefined;
  const received: Received[] = [];
  let respond: (request: Received) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

  let workspaceId = "";
  let productionId = "";
  let stagingId = "";
  let mcpUrl = "";
  let sign: (scope: string) => Promise<string>;
  let createApproval: typeof import("../src/core/approvals/service.ts").createApproval;
  let deliverMessage: typeof import("../src/core/messaging/consumer.ts").deliverMessage;
  let redis: typeof import("../src/lib/redis.ts").redis;
  let RedisKeys: typeof import("../src/lib/redis.ts").RedisKeys;
  let worker: { fanOut: (eventInternalId: string, workspaceId: string) => Promise<void> };

  const secret = `whsec_${randomBytes(32).toString("base64")}`;

  async function rpc(token: string, method: string, params: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...extraHeaders,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "chatgpt-test", version: "0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    return { status: response.status, message: (await response.json()) as { result?: any; error?: any } };
  }

  const subscribeParams = (path: string, overrides: Record<string, unknown> = {}) => ({
    name: "approval.requested",
    arguments: {},
    delivery: { mode: "webhook", url: `${CALLBACK_ORIGIN}${path}`, secret },
    ttlMs: 60 * 60 * 1000,
    ...overrides,
  });

  async function eventFor(approvalId: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = await pool.query(
        `SELECT id, event_id, environment_id FROM events WHERE workspace_id = $1 AND data->>'approvalId' = $2`,
        [workspaceId, approvalId],
      );
      if (row.rowCount) return row.rows[0] as { id: string; event_id: string; environment_id: string };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no platform event was published for ${approvalId}`);
  }

  async function fanOutAndDeliver(eventInternalId: string) {
    await worker.fanOut(eventInternalId, workspaceId);
    const rows = await pool.query(`SELECT message_id, url FROM messages WHERE event_id = $1`, [eventInternalId]);
    for (const { message_id: messageId } of rows.rows) {
      const data = await redis.hgetall(RedisKeys.message(workspaceId, messageId));
      await deliverMessage(data as never);
    }
    return rows.rows as Array<{ message_id: string; url: string }>;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    callback = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString();
      const entry = { path: request.url ?? "", headers: request.headers, raw, body: JSON.parse(raw) };
      received.push(entry);
      const answer = entry.body.type === "verification" ? { status: 200, body: { challenge: entry.body.challenge } } : respond(entry);
      response.writeHead(answer.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => callback?.listen(0, "127.0.0.1", resolve));
    callbackPort = (callback.address() as AddressInfo).port;

    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Events', $2, true, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (await pool.query(
      `INSERT INTO workspaces (name, slug, plan) VALUES ('MCP Events', $1, 'paygo') RETURNING id`,
      [`mcp-events-${suffix}`],
    )).rows[0].id;
    productionId = (await pool.query(
      `INSERT INTO environments (id, workspace_id, name, slug, is_default) VALUES (gen_random_uuid(), $1, 'Production', 'production', true) RETURNING id`,
      [workspaceId],
    )).rows[0].id;
    stagingId = (await pool.query(
      `INSERT INTO environments (id, workspace_id, name, slug, is_default) VALUES (gen_random_uuid(), $1, 'Staging', 'staging', false) RETURNING id`,
      [workspaceId],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at) VALUES (gen_random_uuid(), $1, $2, 'admin', now())`,
      [workspaceId, userId],
    );
    await pool.query(
      `INSERT INTO oauth_client (id, client_id, name, redirect_uris, public, disabled, created_at, updated_at)
       VALUES ($1, $2, 'ChatGPT', ARRAY['https://chatgpt.com/connector/oauth/cb_test'], true, false, now(), now())`,
      [randomUUID(), clientId],
    );
    await pool.query(
      `INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at, updated_at)
       VALUES ($1, $2, $3, ARRAY['openid','anlyon:actions','anlyon:messaging'], now(), now())`,
      [randomUUID(), clientId, userId],
    );
    await pool.query(
      `INSERT INTO oauth_workspace_binding (id, user_id, client_id, workspace_id, environment_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [randomUUID(), userId, clientId, workspaceId, stagingId],
    );

    const { auth, MCP_RESOURCE_URL, OAUTH_ISSUER } = await import("../src/utils/auth.ts");
    sign = async (scope: string) => {
      const now = Math.floor(Date.now() / 1000);
      const { token } = await auth.api.signJWT({
        body: { payload: { sub: userId, azp: clientId, scope, aud: MCP_RESOURCE_URL, iss: OAUTH_ISSUER, iat: now, exp: now + 900 } },
      });
      return token;
    };
    mcpUrl = MCP_RESOURCE_URL;
    ({ createApproval } = await import("../src/core/approvals/service.ts"));
    ({ deliverMessage } = await import("../src/core/messaging/consumer.ts"));
    ({ redis, RedisKeys } = await import("../src/lib/redis.ts"));
    const { EventsFanoutWorker } = await import("../src/workers/events.ts");
    worker = new EventsFanoutWorker(0) as unknown as typeof worker;

    const server = (await import("../src/api/index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
    const { serve } = await import("@hono/node-server");
    const started = serve({ fetch: server.fetch, port: Number(new URL(OAUTH_ISSUER).port), hostname: "127.0.0.1" });
    await new Promise((ready, fail) => {
      (started as unknown as NodeJS.EventEmitter).once("listening", ready);
      (started as unknown as NodeJS.EventEmitter).once("error", fail);
    });
    app = started as unknown as { close: (cb?: () => void) => void };
  });

  afterAll(async () => {
    if (app) await new Promise<void>((resolve) => app?.close(() => resolve()));
    if (callback) await new Promise<void>((resolve) => callback?.close(() => resolve()));
    if (!pool) return;
    await pool.query(`DELETE FROM messages WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM approvals WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM event_topics WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM oauth_workspace_binding WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_consent WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_client WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM queues WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM environments WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
    await pool.end();
  });

  it("advertises events in server/discover and lists the six event types", async () => {
    const token = await sign("openid anlyon:actions anlyon:messaging");

    const discover = await rpc(token, "server/discover");
    expect(discover.status).toBe(200);
    expect(discover.message.result.supportedVersions).toContain("2026-07-28");
    expect(discover.message.result.capabilities).toMatchObject({ tools: {}, events: {} });

    const listed = await rpc(token, "events/list");
    expect(listed.message.result.events.map((event: { name: string }) => event.name)).toEqual([
      "approval.requested",
      "approval.decided",
      "approval.expired",
      "action.invocation.completed",
      "action.invocation.unknown",
      "environment.halted",
    ]);
    expect(listed.message.result.events[0].delivery).toEqual(["webhook"]);
  });

  it("serves tools over the same protocol, since a modern client will not fall back", async () => {
    const token = await sign("openid anlyon:actions anlyon:messaging");
    const { message } = await rpc(token, "tools/list");
    expect(message.result.resultType).toBe("complete");
    expect(message.result.tools.map((tool: { name: string }) => tool.name)).toContain("list_actions");
  });

  it("refuses a callback that is not HTTPS or not public, and a malformed secret", async () => {
    const token = await sign("openid anlyon:actions anlyon:messaging");
    for (const url of ["http://hooks.chatgpt.test/cb", "https://10.0.0.5/cb", "https://localhost/cb"]) {
      const { message } = await rpc(token, "events/subscribe", subscribeParams("/x", { delivery: { mode: "webhook", url, secret } }));
      expect(message.error?.code, url).toBe(-32602);
    }
    const bad = await rpc(token, "events/subscribe", subscribeParams("/x", { delivery: { mode: "webhook", url: `${CALLBACK_ORIGIN}/x`, secret: "whsec_short" } }));
    expect(bad.message.error?.code).toBe(-32602);
    expect((await pool.query(`SELECT count(*)::int AS n FROM event_subscriptions WHERE workspace_id = $1`, [workspaceId])).rows[0].n).toBe(0);
  });

  it("refuses a subscriber that cannot read what the event describes", async () => {
    const { message } = await rpc(await sign("openid anlyon:messaging"), "events/subscribe", subscribeParams("/scope"));
    expect(message.error?.code).toBe(-31003);
    expect(message.error?.data?.missing).toEqual(["approvals:read"]);
  });

  it("stores nothing when the callback fails the challenge", async () => {
    const original = callback?.listeners("request")[0];
    callback?.removeAllListeners("request");
    callback?.on("request", (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ challenge: "not-the-one-we-sent" }));
    });
    try {
      const { message } = await rpc(await sign("openid anlyon:actions anlyon:messaging"), "events/subscribe", subscribeParams("/liar"));
      expect(message.error?.code).toBe(-32015);
      expect(message.error?.data?.reason).toBe("challenge_failed");
    } finally {
      callback?.removeAllListeners("request");
      callback?.on("request", original as never);
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM event_subscriptions WHERE workspace_id = $1`, [workspaceId])).rows[0].n).toBe(0);
  });

  it("subscribes after a signed single-use challenge, delivers a signed event, and stops after unsubscribe", async () => {
    const token = await sign("openid anlyon:actions anlyon:messaging");
    received.length = 0;

    const subscribed = await rpc(token, "events/subscribe", subscribeParams("/automation"));
    expect(subscribed.message.error).toBeUndefined();
    const { id, refreshBefore, cursor, truncated } = subscribed.message.result;
    expect(id).toMatch(/^sub_mcp_[0-9a-f]{32}$/);
    expect(cursor).toBeNull();
    expect(truncated).toBe(false);
    expect(Date.parse(refreshBefore)).toBeGreaterThan(Date.now());

    const [challenge] = received;
    expect(challenge.body.type).toBe("verification");
    expect(String(challenge.headers["webhook-id"])).toMatch(/^msg_verification_/);
    expect(verifyStandardWebhook(secret, challenge)).toBe(true);

    const again = await rpc(token, "events/subscribe", subscribeParams("/automation"));
    expect(again.message.result.id).toBe(id);
    const rows = await pool.query(
      `SELECT environment_id, mcp_environment_id, delivery_format, event_types, secret_encrypted, mcp_principal FROM event_subscriptions WHERE subscription_id = $1`,
      [id],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      environment_id: productionId,
      mcp_environment_id: stagingId,
      delivery_format: "mcp",
      event_types: ["approval.requested"],
      mcp_principal: `${userId}:${clientId}`,
    });
    expect(rows.rows[0].secret_encrypted).not.toContain(secret.slice(6, 20));

    received.length = 0;
    const approval = await createApproval(workspaceId, { title: "Raise ticket T-1042" }, { environmentId: stagingId });
    const event = await eventFor(approval.id);
    const deliveries = await fanOutAndDeliver(event.id);
    expect(deliveries.map((d) => d.url)).toEqual([`${CALLBACK_ORIGIN}/automation`]);

    expect(received).toHaveLength(1);
    const [delivery] = received;
    expect(delivery.path).toBe("/automation");
    expect(delivery.body).toMatchObject({
      eventId: event.event_id,
      name: "approval.requested",
      cursor: null,
      data: { approvalId: approval.id, environmentId: stagingId },
    });
    expect(delivery.headers["webhook-id"]).toBe(event.event_id);
    expect(delivery.headers["x-mcp-subscription-id"]).toBe(id);
    expect(verifyStandardWebhook(secret, delivery)).toBe(true);
    expect(delivery.headers["anlyon-signature"]).toBeUndefined();

    const gone = await rpc(token, "events/unsubscribe", {
      name: "approval.requested",
      arguments: {},
      delivery: { mode: "webhook", url: `${CALLBACK_ORIGIN}/automation` },
    });
    expect(gone.message.result).toMatchObject({});
    expect((await pool.query(`SELECT 1 FROM event_subscriptions WHERE subscription_id = $1`, [id])).rowCount).toBe(0);

    expect(await redis.exists(RedisKeys.eventsHasSubs(workspaceId))).toBe(0);
  });

  it("stops at expiry, and does not retry a 410", async () => {
    const token = await sign("openid anlyon:actions anlyon:messaging");
    const { message } = await rpc(token, "events/subscribe", subscribeParams("/gone"));
    const id = message.result.id as string;

    respond = () => ({ status: 410, body: {} });
    try {
      received.length = 0;
      const approval = await createApproval(workspaceId, { title: "Rotate key" }, { environmentId: stagingId });
      const [delivery] = await fanOutAndDeliver((await eventFor(approval.id)).id);
      expect(received).toHaveLength(1);
      expect(await redis.zscore(RedisKeys.dlqSet(workspaceId), delivery.message_id)).not.toBeNull();
    } finally {
      respond = () => ({ status: 200, body: {} });
    }

    await pool.query(`UPDATE event_subscriptions SET expires_at = now() - interval '1 minute' WHERE subscription_id = $1`, [id]);
    received.length = 0;
    const late = await createApproval(workspaceId, { title: "Too late" }, { environmentId: stagingId });
    expect(await fanOutAndDeliver((await eventFor(late.id)).id)).toEqual([]);
    expect(received).toHaveLength(0);
    await pool.query(`DELETE FROM event_subscriptions WHERE subscription_id = $1`, [id]);
  });

  it("delivers only the bound environment's events, and leaves customer deliveries as they were", async () => {
    const { createSubscription } = await import("../src/core/events/service.ts");
    const customer = await createSubscription(workspaceId, "anlyon", { url: `${CALLBACK_ORIGIN}/customer`, generateSecret: true }, productionId);
    const token = await sign("openid anlyon:actions anlyon:messaging");
    const { message } = await rpc(token, "events/subscribe", subscribeParams("/staging-only"));
    expect(message.error).toBeUndefined();

    received.length = 0;
    const staging = await createApproval(workspaceId, { title: "Staging only" }, { environmentId: stagingId });
    const stagingDeliveries = await fanOutAndDeliver((await eventFor(staging.id)).id);
    expect(stagingDeliveries.map((d) => d.url).sort()).toEqual([`${CALLBACK_ORIGIN}/customer`, `${CALLBACK_ORIGIN}/staging-only`]);

    const toCustomer = received.find((r) => r.path === "/customer");
    const toMcp = received.find((r) => r.path === "/staging-only");
    expect(toCustomer?.headers["anlyon-signature"]).toEqual(expect.any(String));
    expect(toCustomer?.headers["webhook-signature"]).toBeUndefined();
    expect(toCustomer?.headers["x-mcp-subscription-id"]).toBeUndefined();
    expect(toCustomer?.body).toMatchObject({ type: "approval.requested", data: { approvalId: staging.id } });
    const { signDeliveryPayload, signDeliveryPayloadForEnvironment } = await import("../src/utils/crypto.ts");
    const environmentHeader = toCustomer?.headers["x-anlyon-environment-id"] as string | undefined;
    const timestamp = Number(toCustomer?.headers["anlyon-timestamp"]);
    expect(toCustomer?.headers["anlyon-signature"]).toBe(
      environmentHeader
        ? signDeliveryPayloadForEnvironment(toCustomer?.raw ?? "", customer.secret as string, environmentHeader, timestamp)
        : signDeliveryPayload(toCustomer?.raw ?? "", customer.secret as string, timestamp),
    );
    expect(toMcp && verifyStandardWebhook(secret, toMcp)).toBe(true);

    received.length = 0;
    const production = await createApproval(workspaceId, { title: "Production" }, { environmentId: productionId });
    const productionDeliveries = await fanOutAndDeliver((await eventFor(production.id)).id);
    expect(productionDeliveries.map((d) => d.url)).toEqual([`${CALLBACK_ORIGIN}/customer`]);
  });
});
