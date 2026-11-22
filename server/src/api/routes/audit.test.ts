import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ENVIRONMENT = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  enabled: true,
  caller: { authType: "apiKey", scopes: [] as string[], userId: undefined as string | undefined },
  role: "admin",
  listAuditEvents: vi.fn(),
  iterateAuditEvents: vi.fn(),
  createSink: vi.fn(),
  listSinks: vi.fn(),
  sendTestEvent: vi.fn(),
  recordExport: vi.fn(),
}));

vi.mock("../../core/edition/features.ts", () => ({ isFeatureEnabled: () => mocks.enabled }));

vi.mock("../middleware/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/auth.ts")>();
  const resolve = async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set("authType", mocks.caller.authType);
    c.set("apiKeyScopes", mocks.caller.scopes);
    c.set("workspaceId", WORKSPACE_ID);
    c.set("environmentId", KEY_ENVIRONMENT);
    if (mocks.caller.authType === "apiKey") c.set("apiKeyId", "key_1");
    if (mocks.caller.userId) c.set("userId", mocks.caller.userId);
    await next();
  };
  return {
    ...actual,
    requireApiKey: resolve,
    requireSession: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      if (mocks.caller.authType !== "session") {
        const { AuthenticationError } = await import("../../utils/errors.ts");
        throw new AuthenticationError("No active session");
      }
      await resolve(c, next);
    },
    requireWorkspaceAccess: async (_c: unknown, next: () => Promise<void>) => next(),
  };
});

vi.mock("../middleware/rateLimit.ts", () => ({
  rateLimitByWorkspace: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("../../core/workspace/service.ts", () => ({
  getWorkspace: async () => ({ role: mocks.role }),
}));
vi.mock("../../core/workspace/roles.ts", () => ({
  resolveMemberRole: async () => ({ workspaceRole: mocks.role, role: mocks.role, grantedInEnvironmentId: null }),
}));

vi.mock("../../core/audit/archive-read.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/audit/archive-read.ts")>()),
  archivesInRange: async () => [],
}));

vi.mock("../../core/audit/service.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/audit/service.ts")>();
  return {
    ...actual,
    listAuditEvents: mocks.listAuditEvents,
    iterateAuditEvents: mocks.iterateAuditEvents,
    createSink: mocks.createSink,
    listSinks: mocks.listSinks,
    sendTestEvent: mocks.sendTestEvent,
    recordExport: mocks.recordExport,
  };
});

const { auditConsoleRouter, auditRouter } = await import("./audit.ts");
const { buildErrorResponse } = await import("../middleware/error.ts");

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/workspaces", auditConsoleRouter);
app.route("/audit", auditRouter);

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  mocks.enabled = true;
  mocks.role = "admin";
  mocks.caller = { authType: "apiKey", scopes: [], userId: undefined };
  mocks.listAuditEvents.mockReset().mockResolvedValue({ events: [], nextBefore: null });
  mocks.iterateAuditEvents.mockReset().mockImplementation(async function* () {
    yield [{ id: "aud_1", sequence: 1, occurredAt: "2026-10-01T00:00:00.000Z", type: "member.added", category: "access", outcome: null,
      workspaceId: WORKSPACE_ID, environmentId: null, actor: { type: "user", id: "u" }, resource: null, data: {}, context: null }];
  });
  mocks.createSink.mockReset().mockResolvedValue({ sink: { sinkId: "asink_1" }, signingSecret: "whsec_once" });
  mocks.listSinks.mockReset().mockResolvedValue([]);
  mocks.recordExport.mockReset().mockResolvedValue(undefined);
});

describe("the edition gate", () => {
  it("answers 404 on both doors when audit streaming is not in this edition", async () => {
    mocks.enabled = false;
    mocks.caller = { authType: "session", scopes: [], userId: "user_1" };
    expect((await call("GET", `/workspaces/${WORKSPACE_ID}/audit/sinks`)).status).toBe(404);
    mocks.caller = { authType: "apiKey", scopes: ["audit:read"], userId: undefined };
    expect((await call("GET", "/audit/events")).status).toBe(404);
  });
});

describe("the console door", () => {
  it("refuses an API key, even one holding audit:read", async () => {
    mocks.caller = { authType: "apiKey", scopes: ["audit:read"], userId: undefined };
    expect((await call("GET", `/workspaces/${WORKSPACE_ID}/audit/sinks`)).status).toBe(401);
  });

  it("refuses a member who is not an admin", async () => {
    mocks.caller = { authType: "session", scopes: [], userId: "user_1" };
    mocks.role = "member";
    expect((await call("GET", `/workspaces/${WORKSPACE_ID}/audit/sinks`)).status).toBe(403);
  });

  it("creates a sink for an admin and returns the webhook secret once", async () => {
    mocks.caller = { authType: "session", scopes: [], userId: "user_1" };
    const response = await call("POST", `/workspaces/${WORKSPACE_ID}/audit/sinks`, {
      name: "SIEM", type: "webhook", config: { url: "https://siem.example.com/audit" },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).data).toEqual({ sinkId: "asink_1", signingSecret: "whsec_once" });
    expect(mocks.createSink.mock.calls[0][2].actor).toEqual({ type: "user", id: "user_1" });
  });

  it("validates the sink body", async () => {
    mocks.caller = { authType: "session", scopes: [], userId: "user_1" };
    const bad = [
      { name: "x", type: "ftp", config: {} },
      { name: "x", type: "webhook", config: {}, eventTypes: ["DROP TABLE"] },
      { name: "x", type: "webhook", config: {}, extra: true },
    ];
    for (const body of bad) {
      expect((await call("POST", `/workspaces/${WORKSPACE_ID}/audit/sinks`, body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("the operator door", () => {
  it("needs audit:read, which no key holds by default", async () => {
    const { DEFAULT_API_KEY_SCOPES } = await import("../../core/auth/api-key-scopes.ts");
    expect(DEFAULT_API_KEY_SCOPES).not.toContain("audit:read");
    mocks.caller = { authType: "apiKey", scopes: [...DEFAULT_API_KEY_SCOPES], userId: undefined };
    expect((await call("GET", "/audit/events")).status).toBe(403);
  });

  it("limits a key to its own environment whatever the query asks", async () => {
    mocks.caller = { authType: "apiKey", scopes: ["audit:read"], userId: undefined };
    const response = await call("GET", "/audit/events?environmentId=44444444-4444-4444-8444-444444444444&type=approval.*,policy.updated&limit=10");
    expect(response.status).toBe(200);
    const [workspaceId, filter, page] = mocks.listAuditEvents.mock.calls[0];
    expect(workspaceId).toBe(WORKSPACE_ID);
    expect(filter).toMatchObject({ onlyEnvironmentId: KEY_ENVIRONMENT, types: ["approval.*", "policy.updated"] });
    expect(page).toEqual({ limit: 10, before: undefined });
  });

  it("streams a CSV export and records who took it", async () => {
    mocks.caller = { authType: "apiKey", scopes: ["audit:read"], userId: undefined };
    const response = await call("GET", "/audit/export?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z&format=csv&action=refund");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toMatch(/attachment; filename="anlyon-audit-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = (await response.text()).trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith("aud_1,1,")).toBe(true);
    expect(mocks.iterateAuditEvents.mock.calls[0][1]).toMatchObject({ action: "refund", onlyEnvironmentId: KEY_ENVIRONMENT });
    const [workspaceId, environmentId, caller, data] = mocks.recordExport.mock.calls[0];
    expect([workspaceId, environmentId, caller.actor]).toEqual([WORKSPACE_ID, KEY_ENVIRONMENT, { type: "api_key", id: "key_1" }]);
    expect(data).toMatchObject({ format: "csv" });
  });

  it("refuses an export without a range, or longer than a year", async () => {
    mocks.caller = { authType: "apiKey", scopes: ["audit:read"], userId: undefined };
    expect((await call("GET", "/audit/export")).status).toBe(400);
    expect((await call("GET", "/audit/export?from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z")).status).toBe(400);
    expect((await call("GET", "/audit/export?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z")).status).toBe(400);
  });

  it("serves the JSON Schema of the v1 event", async () => {
    mocks.caller = { authType: "apiKey", scopes: ["audit:read"], userId: undefined };
    const body = await (await call("GET", "/audit/schema")).json();
    expect(body.data.schema).toBe("anlyon.audit.v1");
    expect(body.data.jsonSchema.required).toContain("id");
  });
});
