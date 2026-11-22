import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ApiError } from "../src/utils/errors.ts";

const getSession = vi.hoisted(() => vi.fn());
const verifyApiKey = vi.hoisted(() => vi.fn());
const verifyOAuthAccessToken = vi.hoisted(() => vi.fn());
const hasWorkspaceAccess = vi.hoisted(() => vi.fn());
const getEnvironment = vi.hoisted(() => vi.fn());
const getDefaultEnvironment = vi.hoisted(() => vi.fn());
const resolveMemberRole = vi.hoisted(() => vi.fn());
const limits = vi.hoisted(() => ({
  createLimit: vi.fn(),
  updateLimit: vi.fn(),
  archiveLimit: vi.fn(),
  getLimit: vi.fn(),
  listLimits: vi.fn(),
}));

vi.mock("../src/api/governance-gate.ts", () => ({ signOffIfLoosening: async () => null, isHumanPresent: () => true }));
vi.mock("../src/utils/auth.ts", () => ({ auth: { api: { getSession } } }));
vi.mock("../src/core/auth/api-keys.ts", () => ({ verifyApiKeyAndGetWorkspace: verifyApiKey }));
vi.mock("../src/core/auth/oauth-tokens.ts", () => ({
  looksLikeJwt: (token: string) => token.startsWith("eyJ"),
  verifyOAuthAccessToken,
}));
vi.mock("../src/core/workspace/service.ts", () => ({ hasWorkspaceAccess }));
vi.mock("../src/core/environments/service.ts", () => ({ getEnvironment, getDefaultEnvironment }));
vi.mock("../src/core/workspace/roles.ts", () => ({ resolveMemberRole }));
vi.mock("../src/core/sso/sessions.ts", () => ({ assertSsoSessionForWorkspace: async () => undefined }));
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock("../src/api/audit-caller.ts", () => ({ auditRequest: vi.fn() }));
vi.mock("../src/core/effects/impact.ts", () => limits);

const { default: impactLimitsRouter } = await import("../src/api/routes/impact-limits.ts");
const { expandOAuthScopes } = await import("../src/core/auth/oauth-scopes.ts");

const WS = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "http://localhost:3000";
const LIMIT = {
  id: "lim_1", name: "Daily refunds", dimension: "money", currency: "usd",
  scope: { environmentId: ENV, actionName: null, resourcePrefix: null }, period: "day", limit: 5000,
};

const app = new Hono();
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.statusCode as 403);
  return c.json({ error: String(error) }, 500);
});
app.route("/api/v2/impact-limits", impactLimitsRouter);

interface Route { name: string; method: string; path: string; body?: unknown }

const WRITES: Route[] = [
  { name: "create", method: "POST", path: "/api/v2/impact-limits", body: { name: "Daily refunds", dimension: "money", currency: "usd", period: "day", amount: 5000 } },
  { name: "update", method: "PATCH", path: "/api/v2/impact-limits/lim_1", body: { amount: 500000 } },
  { name: "archive", method: "DELETE", path: "/api/v2/impact-limits/lim_1" },
];
const READS: Route[] = [
  { name: "list", method: "GET", path: "/api/v2/impact-limits" },
  { name: "get", method: "GET", path: "/api/v2/impact-limits/lim_1" },
];

type Caller = "session" | { bearer: string };

function send(caller: Caller, route: Route): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (caller === "session") Object.assign(headers, { "X-Workspace-Id": WS, "X-Environment-Id": ENV, origin: ORIGIN });
  else headers.Authorization = `Bearer ${caller.bearer}`;
  return Promise.resolve(app.request(route.path, {
    method: route.method,
    headers,
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  }));
}

const writeCalls = () =>
  limits.createLimit.mock.calls.length + limits.updateLimit.mock.calls.length + limits.archiveLimit.mock.calls.length;

function role(name: string) {
  resolveMemberRole.mockResolvedValue({ workspaceRole: name, role: name, grantedInEnvironmentId: null });
}

function oauth(scopes: string[]): Caller {
  verifyOAuthAccessToken.mockResolvedValue({
    userId: "user_1", workspaceId: WS, environmentId: ENV, clientId: "client_1", scopes, expiresAt: null,
  });
  return { bearer: "eyJ.token" };
}

beforeEach(() => {
  vi.resetAllMocks();
  getSession.mockImplementation(async ({ headers }: { headers: Headers }) =>
    headers.get("authorization") ? null : { user: { id: "user_1", email: "a@example.com" }, session: { id: "s_1" } });
  hasWorkspaceAccess.mockResolvedValue(true);
  getEnvironment.mockImplementation(async (_ws: string, id: string) => ({ id }));
  getDefaultEnvironment.mockResolvedValue({ id: ENV });
  limits.createLimit.mockResolvedValue(LIMIT);
  limits.updateLimit.mockResolvedValue(LIMIT);
  limits.archiveLimit.mockResolvedValue(LIMIT);
  limits.getLimit.mockResolvedValue(LIMIT);
  limits.listLimits.mockResolvedValue([LIMIT]);
  role("admin");
});

describe("a console session", () => {
  it.each(WRITES)("as a member is refused $name, and nothing changes", async (route) => {
    role("member");
    const res = await send("session", route);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "AUTHORIZATION_ERROR", message: "Only a workspace admin can do this." },
    });
    expect(writeCalls()).toBe(0);
  });

  it.each(WRITES)("as an admin may $name", async (route) => {
    const res = await send("session", route);
    expect(res.status).toBe(route.method === "POST" ? 201 : 200);
    expect(resolveMemberRole).toHaveBeenCalledWith(WS, "user_1", ENV);
    expect(writeCalls()).toBe(1);
  });

  it("is judged by the role in the limit's environment, where a per-environment grant applies", async () => {
    resolveMemberRole.mockResolvedValue({ workspaceRole: "member", role: "admin", grantedInEnvironmentId: ENV });
    expect((await send("session", WRITES[1])).status).toBe(200);
    resolveMemberRole.mockResolvedValue({ workspaceRole: "admin", role: "member", grantedInEnvironmentId: ENV });
    expect((await send("session", WRITES[1])).status).toBe(403);
  });

  it.each(READS)("as a member still may $name", async (route) => {
    role("member");
    expect((await send("session", route)).status).toBe(200);
  });

  it.each(READS)("as a viewer still may $name", async (route) => {
    role("viewer");
    expect((await send("session", route)).status).toBe(200);
  });
});

describe("an OAuth connection", () => {
  it("never holds impact-limits:write from a consent group, so even an admin's token cannot change a limit", async () => {
    const scopes = expandOAuthScopes(["anlyon:actions"]);
    expect(scopes).toContain("impact-limits:read");
    expect(scopes).not.toContain("impact-limits:write");
    for (const route of WRITES) expect((await send(oauth(scopes), route)).status, route.name).toBe(403);
    for (const route of READS) expect((await send(oauth(scopes), route)).status, route.name).toBe(200);
    expect(writeCalls()).toBe(0);
  });

  it("is held to the consenting member's role, whatever scopes it carries", async () => {
    const scopes = ["impact-limits:read", "impact-limits:write"];
    role("member");
    for (const route of WRITES) expect((await send(oauth(scopes), route)).status, route.name).toBe(403);
    expect(writeCalls()).toBe(0);
    role("admin");
    for (const route of WRITES) expect((await send(oauth(scopes), route)).status, route.name).toBeLessThan(300);
    expect(writeCalls()).toBe(WRITES.length);
  });
});

describe("an API key", () => {
  const key = (scopes: string[]): Caller => {
    verifyApiKey.mockResolvedValue({ workspaceId: WS, environmentId: ENV, keyId: "key_1", scopes, expiresAt: null, endUserRequired: false });
    return { bearer: "anlyon_live_xxx" };
  };

  it("is held to its scopes, not to a role", async () => {
    for (const route of WRITES) expect((await send(key(["impact-limits:read"]), route)).status, route.name).toBe(403);
    for (const route of WRITES) expect((await send(key(["impact-limits:read", "impact-limits:write"]), route)).status, route.name).toBeLessThan(300);
    expect(resolveMemberRole).not.toHaveBeenCalled();
    expect(writeCalls()).toBe(WRITES.length);
  });
});
