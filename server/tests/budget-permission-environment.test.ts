import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ApiError } from "../src/utils/errors.ts";

const getSession = vi.hoisted(() => vi.fn());
const verifyApiKey = vi.hoisted(() => vi.fn());
const hasWorkspaceAccess = vi.hoisted(() => vi.fn());
const getEnvironment = vi.hoisted(() => vi.fn());
const getDefaultEnvironment = vi.hoisted(() => vi.fn());
const resolveMemberRole = vi.hoisted(() => vi.fn());
const budgets = vi.hoisted(() => ({
  budgetKeyEnvironment: vi.fn(),
  putBudget: vi.fn(),
  deleteBudget: vi.fn(),
  getBudget: vi.fn(),
  listBudgets: vi.fn(),
}));

vi.mock("../src/api/governance-gate.ts", () => ({ signOffIfLoosening: async () => null, isHumanPresent: () => true }));
vi.mock("../src/utils/auth.ts", () => ({ auth: { api: { getSession } } }));
vi.mock("../src/core/auth/api-keys.ts", () => ({ verifyApiKeyAndGetWorkspace: verifyApiKey }));
vi.mock("../src/core/auth/oauth-tokens.ts", () => ({ looksLikeJwt: () => false, verifyOAuthAccessToken: vi.fn() }));
vi.mock("../src/core/workspace/service.ts", () => ({ hasWorkspaceAccess }));
vi.mock("../src/core/environments/service.ts", () => ({ getEnvironment, getDefaultEnvironment }));
vi.mock("../src/core/workspace/roles.ts", () => ({ resolveMemberRole }));
vi.mock("../src/core/sso/sessions.ts", () => ({ assertSsoSessionForWorkspace: async () => undefined }));
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock("../src/core/billing/budgets.ts", () => budgets);

const { default: budgetsRouter } = await import("../src/api/routes/budgets.ts");

const WS = "11111111-1111-4111-8111-111111111111";
const PROD = "22222222-2222-4222-8222-222222222222";
const STAGING = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "http://localhost:3000";
const KEY_ENV: Record<string, string> = { key_prod: PROD, key_staging: STAGING };

const app = new Hono();
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.statusCode as 403);
  return c.json({ error: String(error) }, 500);
});
app.route("/api/v2/budgets", budgetsRouter);

const send = (method: "PUT" | "DELETE", apiKeyId: string, env: string) =>
  app.request(`/api/v2/budgets/${apiKeyId}`, {
    method,
    headers: { "X-Workspace-Id": WS, "X-Environment-Id": env, origin: ORIGIN, "Content-Type": "application/json" },
    ...(method === "PUT" ? { body: JSON.stringify({ monthlyCostCentsCap: 500 }) } : {}),
  });

beforeEach(() => {
  vi.resetAllMocks();
  getSession.mockResolvedValue({ user: { id: "user_1", email: "a@example.com" } });
  hasWorkspaceAccess.mockResolvedValue(true);
  getEnvironment.mockImplementation(async (_ws: string, id: string) => ({ id }));
  getDefaultEnvironment.mockResolvedValue({ id: PROD });
  budgets.budgetKeyEnvironment.mockImplementation(async (_ws: string, id: string) => KEY_ENV[id] ?? null);
  budgets.putBudget.mockResolvedValue({ apiKeyId: "k" });
  budgets.deleteBudget.mockResolvedValue(undefined);
  resolveMemberRole.mockImplementation(async (_ws: string, _u: string, env: string | null) =>
    env === PROD
      ? { workspaceRole: "admin", role: "viewer", grantedInEnvironmentId: PROD }
      : { workspaceRole: "admin", role: "admin", grantedInEnvironmentId: null });
});

describe("budget writes check limits.manage in the key's environment", () => {
  it.each(["PUT", "DELETE"] as const)("%s on a production key from a staging header is refused", async (method) => {
    const res = await send(method, "key_prod", STAGING);
    expect(res.status).toBe(403);
    expect(resolveMemberRole).toHaveBeenCalledWith(WS, "user_1", PROD);
    expect(budgets.putBudget).not.toHaveBeenCalled();
    expect(budgets.deleteBudget).not.toHaveBeenCalled();
  });

  it.each(["PUT", "DELETE"] as const)("%s on a staging key is allowed where the person may change caps", async (method) => {
    expect((await send(method, "key_staging", STAGING)).status).toBe(200);
  });

  it("an unknown key is left to the route", async () => {
    budgets.putBudget.mockRejectedValue(new (await import("../src/utils/errors.ts")).NotFoundError("API key"));
    expect((await send("PUT", "key_missing", STAGING)).status).toBe(404);
  });

  it("an API key is held to its scopes and its own environment, not to a role", async () => {
    getSession.mockResolvedValue(null);
    verifyApiKey.mockResolvedValue({ workspaceId: WS, environmentId: STAGING, keyId: "key_1", scopes: ["budgets:write"], expiresAt: null });
    const res = await app.request("/api/v2/budgets/key_staging", {
      method: "PUT",
      headers: { Authorization: "Bearer anlyon_live_xxx", "Content-Type": "application/json" },
      body: JSON.stringify({ monthlyCostCentsCap: 500 }),
    });
    expect(res.status).toBe(200);
    expect(resolveMemberRole).not.toHaveBeenCalled();
    expect(budgets.putBudget).toHaveBeenCalledWith(WS, "key_staging", { monthlyCostCentsCap: 500 }, STAGING);
  });
});
