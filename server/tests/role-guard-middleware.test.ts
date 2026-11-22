import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ApiError } from "../src/utils/errors.ts";

const getSession = vi.hoisted(() => vi.fn());
const verifyApiKey = vi.hoisted(() => vi.fn());
const verifyOAuth = vi.hoisted(() => vi.fn());
const hasWorkspaceAccess = vi.hoisted(() => vi.fn());
const getEnvironment = vi.hoisted(() => vi.fn());
const getDefaultEnvironment = vi.hoisted(() => vi.fn());
const resolveMemberRole = vi.hoisted(() => vi.fn());

vi.mock("../src/utils/auth.ts", () => ({ auth: { api: { getSession } } }));
vi.mock("../src/core/auth/api-keys.ts", () => ({ verifyApiKeyAndGetWorkspace: verifyApiKey }));
vi.mock("../src/core/auth/oauth-tokens.ts", () => ({
  looksLikeJwt: (t: string) => t.split(".").length === 3,
  verifyOAuthAccessToken: verifyOAuth,
}));
vi.mock("../src/core/workspace/service.ts", () => ({ hasWorkspaceAccess }));
vi.mock("../src/core/environments/service.ts", () => ({ getEnvironment, getDefaultEnvironment }));
vi.mock("../src/core/workspace/roles.ts", () => ({ resolveMemberRole }));
vi.mock("../src/core/sso/sessions.ts", () => ({ assertSsoSessionForWorkspace: async () => undefined }));

const { requireApiKey, requireSession, requireWorkspaceAccess, requirePermission } = await import(
  "../src/api/middleware/auth.ts"
);

const WS = "11111111-1111-4111-8111-111111111111";
const PROD = "22222222-2222-4222-8222-222222222222";
const STAGING = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "http://localhost:3000";

const app = new Hono();
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.statusCode as 403);
  return c.json({ error: String(error) }, 500);
});
app.use("/api/v2/actions/*", requireApiKey);
app.use("/api/v2/approvals/*", requireApiKey);
app.all("/api/v2/actions/*", (c) => c.json({ ok: true }));
app.all("/api/v2/approvals/*", (c) => c.json({ ok: true }));
app.post("/api/v2/workspaces/:workspaceId/leave", requireSession, requireWorkspaceAccess, (c) => c.json({ ok: true }));
app.post("/api/v2/workspaces/:workspaceId/api-keys", requireSession, requireWorkspaceAccess, requirePermission("keys.manage"), (c) => c.json({ ok: true }));
app.get("/api/v2/workspaces/:workspaceId/api-keys", requireSession, requireWorkspaceAccess, (c) => c.json({ ok: true }));

const role = (r: string, workspaceRole = r) => ({ workspaceRole, role: r, grantedInEnvironmentId: null });

const session = (method: string, path: string, env = PROD) =>
  app.request(path, { method, headers: { "X-Workspace-Id": WS, "X-Environment-Id": env, origin: ORIGIN } });

beforeEach(() => {
  vi.resetAllMocks();
  getSession.mockResolvedValue({ user: { id: "user_1", email: "a@example.com" } });
  hasWorkspaceAccess.mockResolvedValue(true);
  getEnvironment.mockImplementation(async (_ws: string, id: string) => ({ id }));
  getDefaultEnvironment.mockResolvedValue({ id: PROD });
});

describe("session callers", () => {
  it.each(["viewer", "approver"])("a %s can read", async (r) => {
    resolveMemberRole.mockResolvedValue(role(r));
    expect((await session("GET", "/api/v2/actions/list")).status).toBe(200);
    expect(resolveMemberRole).not.toHaveBeenCalled();
  });

  it.each(["viewer", "approver"])("a %s cannot change anything", async (r) => {
    resolveMemberRole.mockResolvedValue(role(r));
    for (const [method, path] of [["POST", "/api/v2/actions/x"], ["PATCH", "/api/v2/actions/x"], ["DELETE", "/api/v2/actions/x"], ["POST", "/api/v2/approvals/"]]) {
      expect((await session(method, path)).status).toBe(403);
    }
  });

  it.each(["admin", "member"])("a %s writes as before", async (r) => {
    resolveMemberRole.mockResolvedValue(role(r));
    expect((await session("POST", "/api/v2/actions/x")).status).toBe(200);
  });

  it("an approver reaches the decide route; the service then checks the approval's environment", async () => {
    resolveMemberRole.mockResolvedValue(role("approver"));
    expect((await session("POST", "/api/v2/approvals/apr_1/approve")).status).toBe(200);
    expect((await session("POST", "/api/v2/approvals/apr_1/deny")).status).toBe(200);
  });

  it("a viewer does not reach the decide route", async () => {
    resolveMemberRole.mockResolvedValue(role("viewer"));
    expect((await session("POST", "/api/v2/approvals/apr_1/approve")).status).toBe(403);
  });

  it("checks the role in the request's environment, where a grant can change it", async () => {
    resolveMemberRole.mockImplementation(async (_ws: string, _u: string, env: string | null) =>
      env === PROD ? { workspaceRole: "member", role: "viewer", grantedInEnvironmentId: PROD } : role("member"));
    expect((await session("POST", "/api/v2/actions/x", PROD)).status).toBe(403);
    expect((await session("POST", "/api/v2/actions/x", STAGING)).status).toBe(200);
    expect(resolveMemberRole).toHaveBeenCalledWith(WS, "user_1", PROD);
    expect(resolveMemberRole).toHaveBeenCalledWith(WS, "user_1", STAGING);
  });
});

describe("OAuth tokens act for a person", () => {
  beforeEach(() => {
    verifyOAuth.mockResolvedValue({
      userId: "user_1", clientId: "client_1", workspaceId: WS, environmentId: PROD,
      scopes: ["actions:invoke"], expiresAt: new Date(Date.now() + 60_000),
    });
  });

  it("a viewer's agent cannot write, whatever it was consented", async () => {
    resolveMemberRole.mockResolvedValue(role("viewer"));
    const res = await app.request("/api/v2/actions/refund/invoke", { method: "POST", headers: { Authorization: "Bearer aaa.bbb.ccc" } });
    expect(res.status).toBe(403);
  });

  it("a member's agent writes as before", async () => {
    resolveMemberRole.mockResolvedValue(role("member"));
    const res = await app.request("/api/v2/actions/refund/invoke", { method: "POST", headers: { Authorization: "Bearer aaa.bbb.ccc" } });
    expect(res.status).toBe(200);
  });
});

describe("API keys", () => {
  it("are governed by their scopes alone; no role is looked up", async () => {
    getSession.mockResolvedValue(null);
    verifyApiKey.mockResolvedValue({ workspaceId: WS, environmentId: PROD, keyId: "key_1", scopes: [], expiresAt: null });
    const res = await app.request("/api/v2/actions/x", { method: "POST", headers: { Authorization: "Bearer anlyon_live_xxx" } });
    expect(res.status).toBe(200);
    expect(resolveMemberRole).not.toHaveBeenCalled();
  });
});

describe("dashboard routers behind requireWorkspaceAccess", () => {
  const ws = (method: string, path: string) =>
    app.request(path.replace(":ws", WS), { method, headers: { origin: ORIGIN } });

  it("a viewer can leave the workspace", async () => {
    resolveMemberRole.mockResolvedValue(role("viewer"));
    expect((await ws("POST", "/api/v2/workspaces/:ws/leave")).status).toBe(200);
  });

  it("a viewer can list keys but not create one", async () => {
    resolveMemberRole.mockResolvedValue(role("viewer"));
    expect((await ws("GET", "/api/v2/workspaces/:ws/api-keys")).status).toBe(200);
    expect((await ws("POST", "/api/v2/workspaces/:ws/api-keys")).status).toBe(403);
  });

  it("a member still cannot create a key; an admin can", async () => {
    resolveMemberRole.mockResolvedValue(role("member"));
    const refused = await ws("POST", "/api/v2/workspaces/:ws/api-keys");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("Only a workspace admin can do this.");
    resolveMemberRole.mockResolvedValue(role("admin"));
    expect((await ws("POST", "/api/v2/workspaces/:ws/api-keys")).status).toBe(200);
  });

  it("resolves the role once per request", async () => {
    resolveMemberRole.mockResolvedValue(role("admin"));
    await ws("POST", "/api/v2/workspaces/:ws/api-keys");
    expect(resolveMemberRole).toHaveBeenCalledTimes(1);
  });
});
