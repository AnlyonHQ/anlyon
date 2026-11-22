import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ApiError, NotFoundError } from "../src/utils/errors.ts";

const getSession = vi.hoisted(() => vi.fn());
const hasWorkspaceAccess = vi.hoisted(() => vi.fn());
const resolveMemberRole = vi.hoisted(() => vi.fn());
const policies = vi.hoisted(() => ({
  createPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  deletePolicy: vi.fn(),
  getPolicy: vi.fn(),
  listPolicies: vi.fn(),
  listPolicyVersions: vi.fn(),
  getPolicyVersion: vi.fn(),
  assistCondition: vi.fn(),
}));

vi.mock("../src/utils/auth.ts", () => ({ auth: { api: { getSession } } }));
vi.mock("../src/core/auth/oauth-tokens.ts", () => ({ looksLikeJwt: () => false, verifyOAuthAccessToken: vi.fn() }));
vi.mock("../src/core/workspace/service.ts", () => ({ hasWorkspaceAccess }));
vi.mock("../src/core/workspace/roles.ts", () => ({ resolveMemberRole }));
vi.mock("../src/core/sso/sessions.ts", () => ({ assertSsoSessionForWorkspace: async () => undefined }));
vi.mock("../src/core/approvals/policy.ts", () => policies);
vi.mock("../src/lib/redis.ts", () => {
  const nothing = new Proxy({}, { get: () => async () => null });
  return {
    redis: nothing,
    redisBlocking: nothing,
    RedisKeys: new Proxy({}, { get: (_t, name) => (...parts: unknown[]) => [String(name), ...parts].join(":") }),
    createBlockingConnection: () => nothing,
    incrementWithTtl: async () => 1,
    USAGE_COUNTER_TTL_SECONDS: 1,
    WAITING_EVENT_TTL_SECONDS: 1,
  };
});

const { default: workspaces } = await import("../src/api/routes/workspaces.ts");

const WS = "11111111-1111-4111-8111-111111111111";
const PROD = "22222222-2222-4222-8222-222222222222";
const STAGING = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "http://localhost:3000";
const POLICY_ENV: Record<string, string> = { apol_prod: PROD, apol_staging: STAGING };

const app = new Hono();
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.statusCode as 403);
  return c.json({ error: String(error) }, 500);
});
app.route("/api/v2/workspaces", workspaces);

const send = (method: string, path: string, body?: unknown) =>
  app.request(`/api/v2/workspaces/${WS}/approval-policies${path}`, {
    method,
    headers: { origin: ORIGIN, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const newPolicy = (environmentId: string) => ({
  environmentId, name: "Refunds", matchKind: "action", matchActionName: "refund", effect: "require_approval",
});

beforeEach(() => {
  vi.resetAllMocks();
  getSession.mockResolvedValue({ user: { id: "user_1", email: "a@example.com" }, session: { id: "s_1" } });
  hasWorkspaceAccess.mockResolvedValue(true);
  resolveMemberRole.mockImplementation(async (_ws: string, _u: string, env: string | null) =>
    env === PROD
      ? { workspaceRole: "admin", role: "viewer", grantedInEnvironmentId: PROD }
      : { workspaceRole: "admin", role: "admin", grantedInEnvironmentId: null });
  policies.getPolicy.mockImplementation(async (_ws: string, id: string) => {
    if (!POLICY_ENV[id]) throw new NotFoundError("Approval policy");
    return { id, environmentId: POLICY_ENV[id] };
  });
  policies.createPolicy.mockResolvedValue({ id: "apol_new" });
  policies.updatePolicy.mockResolvedValue({ id: "apol_1" });
  policies.deletePolicy.mockResolvedValue(undefined);
});

describe("console approval-policy routes honour per-environment grants", () => {
  it("creating a policy is checked in the environment the body names", async () => {
    expect((await send("POST", "", newPolicy(PROD))).status).toBe(403);
    expect(policies.createPolicy).not.toHaveBeenCalled();
    expect(resolveMemberRole).toHaveBeenCalledWith(WS, "user_1", PROD);

    const staging = await send("POST", "", newPolicy(STAGING));
    expect(staging.status).toBe(201);
  });

  it("changing or deleting a policy is checked in the policy's environment", async () => {
    expect((await send("PATCH", "/apol_prod", { enabled: false })).status).toBe(403);
    expect((await send("DELETE", "/apol_prod")).status).toBe(403);
    expect(policies.updatePolicy).not.toHaveBeenCalled();
    expect(policies.deletePolicy).not.toHaveBeenCalled();

    expect((await send("PATCH", "/apol_staging", { enabled: false })).status).toBe(200);
    expect((await send("DELETE", "/apol_staging")).status).toBe(200);
  });

  it("an unknown policy is 404, as the route answers", async () => {
    expect((await send("PATCH", "/apol_missing", { enabled: false })).status).toBe(404);
  });
});
