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
const apps = vi.hoisted(() => ({
  putEnvironmentOAuthApp: vi.fn(),
  deleteEnvironmentOAuthApp: vi.fn(),
  getEnvironmentOAuthApp: vi.fn(),
  listEnvironmentOAuthApps: vi.fn(),
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
vi.mock("../src/api/middleware/feature-gate.ts", () => ({ requireFeature: () => async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock("../src/api/audit-caller.ts", () => ({ auditRequest: vi.fn() }));
vi.mock("../src/core/end-users/oauth-apps.ts", () => apps);

const { default: environmentOAuthAppsRouter } = await import("../src/api/routes/environment-oauth-apps.ts");

const WS = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const OTHER_ENV = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "http://localhost:3000";
const APP = { integration: "hubspot", configured: true, clientId: "client_attacker", redirectUri: "https://api.example.com/cb" };

const app = new Hono();
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.statusCode as 403);
  return c.json({ error: String(error) }, 500);
});
app.route("/api/v2/environments", environmentOAuthAppsRouter);

interface Route { name: string; method: string; path: string; body?: unknown }

const WRITES: Route[] = [
  { name: "set", method: "PUT", path: `/api/v2/environments/${ENV}/oauth-apps/hubspot`, body: { clientId: "client_attacker", clientSecret: "secret_attacker" } },
  { name: "remove", method: "DELETE", path: `/api/v2/environments/${ENV}/oauth-apps/hubspot` },
];
const READS: Route[] = [
  { name: "list", method: "GET", path: `/api/v2/environments/${ENV}/oauth-apps` },
  { name: "get", method: "GET", path: `/api/v2/environments/${ENV}/oauth-apps/hubspot` },
];

type Caller = "session" | { bearer: string };

function send(caller: Caller, route: Route): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (caller === "session") Object.assign(headers, { "X-Workspace-Id": WS, "X-Environment-Id": OTHER_ENV, origin: ORIGIN });
  else headers.Authorization = `Bearer ${caller.bearer}`;
  return Promise.resolve(app.request(route.path, {
    method: route.method,
    headers,
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  }));
}

const writeCalls = () => apps.putEnvironmentOAuthApp.mock.calls.length + apps.deleteEnvironmentOAuthApp.mock.calls.length;

function role(name: string) {
  resolveMemberRole.mockResolvedValue({ workspaceRole: name, role: name, grantedInEnvironmentId: null });
}

function oauth(scopes: string[]): Caller {
  verifyOAuthAccessToken.mockResolvedValue({
    userId: "user_1", workspaceId: WS, environmentId: ENV, clientId: "client_1", scopes, expiresAt: null,
  });
  return { bearer: "eyJ.token" };
}

function key(scopes: string[]): Caller {
  verifyApiKey.mockResolvedValue({ workspaceId: WS, environmentId: ENV, keyId: "key_1", scopes, expiresAt: null, endUserRequired: false });
  return { bearer: "anlyon_live_xxx" };
}

beforeEach(() => {
  vi.resetAllMocks();
  getSession.mockImplementation(async ({ headers }: { headers: Headers }) =>
    headers.get("authorization") ? null : { user: { id: "user_1", email: "a@example.com" }, session: { id: "s_1" } });
  hasWorkspaceAccess.mockResolvedValue(true);
  getEnvironment.mockImplementation(async (_ws: string, id: string) => ({ id }));
  getDefaultEnvironment.mockResolvedValue({ id: ENV });
  apps.putEnvironmentOAuthApp.mockResolvedValue(APP);
  apps.deleteEnvironmentOAuthApp.mockResolvedValue({ deleted: true, affectedConnections: 0 });
  apps.getEnvironmentOAuthApp.mockResolvedValue(APP);
  apps.listEnvironmentOAuthApps.mockResolvedValue([APP]);
  role("admin");
});

describe("a console session", () => {
  it.each(WRITES)("as a member is refused $name, and the app is untouched", async (route) => {
    role("member");
    const res = await send("session", route);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "AUTHORIZATION_ERROR", message: "Only a workspace admin can do this." } });
    expect(writeCalls()).toBe(0);
  });

  it.each(WRITES)("as an admin may $name", async (route) => {
    expect((await send("session", route)).status).toBe(200);
    expect(writeCalls()).toBe(1);
  });

  it("is judged by the role in the path's environment, where a per-environment grant applies", async () => {
    resolveMemberRole.mockImplementation(async (_ws: string, _user: string, environmentId: string | null) =>
      environmentId === ENV
        ? { workspaceRole: "member", role: "admin", grantedInEnvironmentId: ENV }
        : { workspaceRole: "member", role: "member", grantedInEnvironmentId: null });
    expect((await send("session", WRITES[0])).status).toBe(200);
    expect(resolveMemberRole).toHaveBeenCalledWith(WS, "user_1", ENV);

    resolveMemberRole.mockImplementation(async (_ws: string, _user: string, environmentId: string | null) =>
      environmentId === ENV
        ? { workspaceRole: "admin", role: "member", grantedInEnvironmentId: ENV }
        : { workspaceRole: "admin", role: "admin", grantedInEnvironmentId: null });
    expect((await send("session", WRITES[0])).status).toBe(403);
    expect(writeCalls()).toBe(1);
  });

  it.each(READS)("as a member still may $name", async (route) => {
    role("member");
    expect((await send("session", route)).status).toBe(200);
  });
});

describe("an OAuth connection", () => {
  it("is held to the consenting member's role, whatever scopes it carries", async () => {
    const scopes = ["secrets:read", "secrets:write"];
    role("member");
    for (const route of WRITES) expect((await send(oauth(scopes), route)).status, route.name).toBe(403);
    expect(writeCalls()).toBe(0);
    role("admin");
    for (const route of WRITES) expect((await send(oauth(scopes), route)).status, route.name).toBe(200);
    expect(writeCalls()).toBe(WRITES.length);
  });
});

describe("an API key", () => {
  it("is held to its scopes, not to a role", async () => {
    for (const route of WRITES) expect((await send(key(["secrets:read"]), route)).status, route.name).toBe(403);
    expect(writeCalls()).toBe(0);
    for (const route of WRITES) expect((await send(key(["secrets:read", "secrets:write"]), route)).status, route.name).toBe(200);
    expect(resolveMemberRole).not.toHaveBeenCalled();
    expect(writeCalls()).toBe(WRITES.length);
  });

  it("reaches only its own environment", async () => {
    const res = await send(key(["secrets:read", "secrets:write"]), { ...WRITES[0], path: `/api/v2/environments/${OTHER_ENV}/oauth-apps/hubspot` });
    expect(res.status).toBe(404);
    expect(writeCalls()).toBe(0);
  });
});
