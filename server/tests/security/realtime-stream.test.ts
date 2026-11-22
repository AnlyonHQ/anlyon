import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Next } from "hono";

const replayed = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
const hold = vi.hoisted(() => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { workspace: "ws_full", gate, release };
});

vi.mock("../../src/api/middleware/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/middleware/auth.ts")>();
  return {
    ...actual,
    requireApiKey: async (c: Context, next: Next) => {
      c.set("authType", c.req.header("x-test-auth") ?? "apiKey");
      c.set("workspaceId", c.req.header("x-test-workspace") ?? "ws_1");
      c.set("environmentId", c.req.header("x-test-environment"));
      c.set("apiKeyScopes", (c.req.header("x-test-scopes") ?? "").split(",").filter(Boolean));
      await next();
    },
  };
});

vi.mock("../../src/api/middleware/rateLimit.ts", () => ({
  rateLimitByWorkspace: async (_c: Context, next: Next) => next(),
}));

vi.mock("../../src/core/realtime/publisher.ts", () => ({
  replaySince: async () => replayed.events,
  createTailer: (workspaceId: string) => ({
    next: async () => {
      if (workspaceId === hold.workspace) await hold.gate;
      throw new Error("end of test stream");
    },
    close: () => {},
  }),
}));

const { default: streamRouter, visibleToEnvironment, streamSlotsInUse, MAX_STREAMS_PER_WORKSPACE } =
  await import("../../src/api/routes/stream.ts");
const { buildErrorResponse } = await import("../../src/api/middleware/error.ts");
const { Hono } = await import("hono");

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/stream", streamRouter);

function open(headers: Record<string, string>) {
  return app.request("/stream", { headers: { "Last-Event-ID": "1-0", ...headers } });
}

beforeEach(() => {
  replayed.events = [
    { id: "2-0", v: 1, type: "approval.requested", environmentId: "env_prod", data: { title: "Refund $9,000 to jane@example.com" }, ts: 2 },
    { id: "3-0", v: 1, type: "action.failed", environmentId: "env_staging", data: { actionName: "staging_only" }, ts: 3 },
    { id: "4-0", v: 1, type: "budget.alert", environmentId: null, data: { apiKeyId: "key_unattributed" }, ts: 4 },
  ];
});

describe("GET /stream authority", () => {
  it("refuses a key without events:read", async () => {
    const response = await open({ "x-test-scopes": "messages:write", "x-test-environment": "env_staging" });
    expect(response.status).toBe(403);
  });

  it("serves a key with events:read", async () => {
    const response = await open({ "x-test-scopes": "events:read", "x-test-environment": "env_staging" });
    expect(response.status).toBe(200);
  });
});

describe("GET /stream environment isolation", () => {
  it("never shows a staging key production's events, or unattributed ones", async () => {
    const response = await open({ "x-test-scopes": "events:read", "x-test-environment": "env_staging" });
    const body = await response.text();
    expect(body).toContain("staging_only");
    expect(body).not.toContain("jane@example.com");
    expect(body).not.toContain("key_unattributed");
  });

  it("shows a dashboard session its whole workspace, as it did before", async () => {
    const response = await open({ "x-test-auth": "session", "x-test-environment": "env_staging" });
    const body = await response.text();
    expect(body).toContain("staging_only");
    expect(body).toContain("jane@example.com");
  });

  it("fails closed for events with no environment and callers with none", () => {
    expect(visibleToEnvironment({ environmentId: null }, "env_a")).toBe(false);
    expect(visibleToEnvironment({ environmentId: "env_a" }, undefined)).toBe(false);
    expect(visibleToEnvironment({ environmentId: "env_a" }, "env_b")).toBe(false);
    expect(visibleToEnvironment({ environmentId: "env_a" }, "env_a")).toBe(true);
  });
});

describe("GET /stream connection budget", () => {
  it("releases its slot when the stream ends", async () => {
    const response = await open({ "x-test-scopes": "events:read", "x-test-environment": "env_a", "x-test-workspace": "ws_release" });
    await response.text();
    expect(streamSlotsInUse("ws_release")).toBe(0);
  });

  it("refuses a workspace that already holds the maximum, and frees slots on close", async () => {
    const headers = { "x-test-scopes": "events:read", "x-test-environment": "env_a", "x-test-workspace": hold.workspace };
    const held = [];
    for (let i = 0; i < MAX_STREAMS_PER_WORKSPACE; i++) {
      const response = await open(headers);
      expect(response.status).toBe(200);
      held.push(response);
    }
    expect(streamSlotsInUse(hold.workspace)).toBe(MAX_STREAMS_PER_WORKSPACE);

    expect((await open(headers)).status).toBe(429);
    expect((await open({ ...headers, "x-test-workspace": "ws_other" })).status).toBe(200);

    hold.release();
    await Promise.all(held.map((response) => response.text()));
    expect(streamSlotsInUse(hold.workspace)).toBe(0);
  });
});
