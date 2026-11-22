import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ApiError, AuthenticationError } from "../src/utils/errors.ts";

const getSession = vi.hoisted(() => vi.fn());
const verifyApiKey = vi.hoisted(() => vi.fn());
const verifyOAuth = vi.hoisted(() => vi.fn());
const hasWorkspaceAccess = vi.hoisted(() => vi.fn());
const getEnvironment = vi.hoisted(() => vi.fn());
const getDefaultEnvironment = vi.hoisted(() => vi.fn());
const resolveMemberRole = vi.hoisted(() => vi.fn());

vi.mock("../src/core/sso/sessions.ts", () => ({ assertSsoSessionForWorkspace: vi.fn(async () => undefined) }));
vi.mock("../src/utils/auth.ts", () => ({ auth: { api: { getSession } } }));
vi.mock("../src/core/auth/api-keys.ts", () => ({ verifyApiKeyAndGetWorkspace: verifyApiKey }));
vi.mock("../src/core/auth/oauth-tokens.ts", () => ({
  looksLikeJwt: (t: string) => t.split(".").length === 3,
  verifyOAuthAccessToken: verifyOAuth,
}));
vi.mock("../src/core/workspace/service.ts", () => ({ hasWorkspaceAccess }));
vi.mock("../src/core/environments/service.ts", () => ({ getEnvironment, getDefaultEnvironment }));
vi.mock("../src/core/workspace/roles.ts", () => ({ resolveMemberRole }));
vi.mock("../src/api/middleware/rateLimit.ts", () => ({
  rateLimitByWorkspace: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { default: router } = await import("../src/api/routes/auth-identity.ts");

const app = new Hono();
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ success: false, error: { code: error.code, message: error.message } }, error.statusCode as 401);
  return c.json({ success: false }, 500);
});
app.route("/api/v2/auth", router);

const WS = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const KEY_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "anlyon_live_SECRETSECRETSECRETSECRET";
const KEYS = ["apiKeyId", "credentialType", "environmentId", "expiresAt", "role", "scopes", "workspaceId"];

const get = (headers: Record<string, string> = {}) => app.request("/api/v2/auth/identity", { headers });
const data = async (res: Response) => ((await res.json()) as { data: Record<string, unknown> }).data;

beforeEach(() => {
  vi.resetAllMocks();
  getSession.mockResolvedValue(null);
  resolveMemberRole.mockResolvedValue({ workspaceRole: "member", role: "member", grantedInEnvironmentId: null });
});

describe("GET /api/v2/auth/identity", () => {
  it("API key: reports the credential and only the credential", async () => {
    verifyApiKey.mockResolvedValue({
      workspaceId: WS,
      environmentId: ENV,
      keyId: KEY_ID,
      scopes: ["runs:read", "actions:invoke"],
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });
    const res = await get({ Authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await data(res);
    expect(Object.keys(body).sort()).toEqual(KEYS);
    expect(body).toEqual({
      credentialType: "api_key",
      apiKeyId: KEY_ID,
      workspaceId: WS,
      environmentId: ENV,
      scopes: ["actions:invoke", "runs:read"],
      expiresAt: "2027-01-01T00:00:00.000Z",
      role: null,
    });
    expect(resolveMemberRole).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("API key: never-expiring key reports null expiry", async () => {
    verifyApiKey.mockResolvedValue({ workspaceId: WS, environmentId: ENV, keyId: KEY_ID, scopes: [], expiresAt: null });
    expect((await data(await get({ Authorization: `Bearer ${SECRET}` }))).expiresAt).toBeNull();
  });

  it.each([
    ["expired", "Authentication failed"],
    ["revoked", "Authentication failed"],
  ])("a %s key gets a generic 401 that reveals neither the key nor why", async (_kind, message) => {
    verifyApiKey.mockRejectedValue(new AuthenticationError(message));
    const res = await get({ Authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/expired|revoked/i);
  });

  it("OAuth: no API key id is invented, and the granted scopes are reported", async () => {
    verifyOAuth.mockResolvedValue({
      userId: "user_1",
      clientId: "client_1",
      workspaceId: WS,
      environmentId: ENV,
      scopes: ["runs:write", "runs:read"],
      grantedGroups: ["anlyon:memory"],
      expiresAt: new Date("2026-09-20T10:00:00.000Z"),
    });
    const res = await get({ Authorization: "Bearer aaa.bbb.ccc" });
    expect(res.status).toBe(200);
    const body = await data(res);
    expect(Object.keys(body).sort()).toEqual(KEYS);
    expect(body).toMatchObject({
      credentialType: "oauth",
      apiKeyId: null,
      scopes: ["runs:read", "runs:write"],
      expiresAt: "2026-09-20T10:00:00.000Z",
      role: "member",
    });
    expect(resolveMemberRole).toHaveBeenCalledWith(WS, "user_1", ENV);
    expect(JSON.stringify(body)).not.toMatch(/user_1|client_1|anlyon:memory/);
  });

  it("OAuth: an invalid or expired token is a 401", async () => {
    verifyOAuth.mockRejectedValue(new AuthenticationError("Invalid or expired access token"));
    expect((await get({ Authorization: "Bearer aaa.bbb.ccc" })).status).toBe(401);
  });

  it("session: scopes are null (authority is the workspace role) and no key id exists", async () => {
    getSession.mockResolvedValue({ user: { id: "user_1", email: "a@example.com" } });
    hasWorkspaceAccess.mockResolvedValue(true);
    getDefaultEnvironment.mockResolvedValue({ id: ENV });
    const res = await get({ "X-Workspace-Id": WS });
    expect(res.status).toBe(200);
    const body = await data(res);
    expect(Object.keys(body).sort()).toEqual(KEYS);
    expect(body).toEqual({
      credentialType: "session",
      apiKeyId: null,
      workspaceId: WS,
      environmentId: ENV,
      scopes: null,
      expiresAt: null,
      role: "member",
    });
    expect(JSON.stringify(body)).not.toContain("a@example.com");
  });

  it("session: an environment the caller names is validated against the workspace", async () => {
    getSession.mockResolvedValue({ user: { id: "user_1", email: "a@example.com" } });
    hasWorkspaceAccess.mockResolvedValue(true);
    getEnvironment.mockResolvedValue({ id: ENV });
    const res = await get({ "X-Workspace-Id": WS, "X-Environment-Id": ENV });
    expect(res.status).toBe(200);
    expect(getEnvironment).toHaveBeenCalledWith(WS, ENV);
  });

  it("session: a workspace the user cannot access is refused", async () => {
    getSession.mockResolvedValue({ user: { id: "user_1", email: "a@example.com" } });
    hasWorkspaceAccess.mockResolvedValue(false);
    expect((await get({ "X-Workspace-Id": WS })).status).toBe(403);
  });

  it("session: reports the role a per-environment grant gives in the request's environment", async () => {
    getSession.mockResolvedValue({ user: { id: "user_1", email: "a@example.com" } });
    hasWorkspaceAccess.mockResolvedValue(true);
    getEnvironment.mockResolvedValue({ id: ENV });
    resolveMemberRole.mockResolvedValue({ workspaceRole: "viewer", role: "approver", grantedInEnvironmentId: ENV });
    const body = await data(await get({ "X-Workspace-Id": WS, "X-Environment-Id": ENV }));
    expect(body.role).toBe("approver");
    expect(resolveMemberRole).toHaveBeenCalledWith(WS, "user_1", ENV);
  });

  it("no credential at all is a 401", async () => {
    expect((await get()).status).toBe(401);
  });
});
