import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ApiError } from "../src/utils/errors.ts";

const getSession = vi.hoisted(() => vi.fn());
const verifyApiKey = vi.hoisted(() => vi.fn());
const hasWorkspaceAccess = vi.hoisted(() => vi.fn());
const getEnvironment = vi.hoisted(() => vi.fn());
const getDefaultEnvironment = vi.hoisted(() => vi.fn());
const resolveMemberRole = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({
  getWorkspaceIntegrations: vi.fn(),
  getIntegrationById: vi.fn(),
  deleteIntegration: vi.fn(),
  toggleIntegration: vi.fn(),
  updateIntegrationEventTypes: vi.fn(),
}));

vi.mock("../src/db/index.ts", () => ({ db: {} }));
vi.mock("../src/utils/auth.ts", () => ({ auth: { api: { getSession } } }));
vi.mock("../src/core/auth/api-keys.ts", () => ({ verifyApiKeyAndGetWorkspace: verifyApiKey }));
vi.mock("../src/core/auth/oauth-tokens.ts", () => ({ looksLikeJwt: () => false, verifyOAuthAccessToken: vi.fn() }));
vi.mock("../src/core/workspace/service.ts", () => ({ hasWorkspaceAccess }));
vi.mock("../src/core/environments/service.ts", () => ({ getEnvironment, getDefaultEnvironment }));
vi.mock("../src/core/workspace/roles.ts", () => ({ resolveMemberRole }));
vi.mock("../src/core/sso/sessions.ts", () => ({ assertSsoSessionForWorkspace: async () => undefined }));
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock("../src/core/integrations/integration-service.ts", () => store);

const { default: integrationsRouter } = await import("../src/api/routes/integrations.ts");

const WS = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const INTEGRATION = "44444444-4444-4444-8444-444444444444";
const ORIGIN = "http://localhost:3000";

const app = new Hono();
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.statusCode as 403);
  return c.json({ error: String(error) }, 500);
});
app.route("/api/v2/integrations", integrationsRouter);

interface Route { name: string; method: string; path: string; body?: unknown }

const WRITES: Route[] = [
  { name: "delete", method: "DELETE", path: `/api/v2/integrations/${INTEGRATION}` },
  { name: "disable", method: "PATCH", path: `/api/v2/integrations/${INTEGRATION}/toggle`, body: { isActive: false } },
  { name: "change its alerts", method: "PATCH", path: `/api/v2/integrations/${INTEGRATION}/events`, body: { enabledEventTypes: [] } },
];

function send(route: Route): Promise<Response> {
  return Promise.resolve(app.request(route.path, {
    method: route.method,
    headers: { "Content-Type": "application/json", "X-Workspace-Id": WS, "X-Environment-Id": ENV, origin: ORIGIN },
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  }));
}

const writeCalls = () =>
  store.deleteIntegration.mock.calls.length + store.toggleIntegration.mock.calls.length + store.updateIntegrationEventTypes.mock.calls.length;

function roles(workspaceRole: string, environmentRole: string) {
  resolveMemberRole.mockImplementation(async (_ws: string, _user: string, environmentId: string | null | undefined) => ({
    workspaceRole,
    role: environmentId ? environmentRole : workspaceRole,
    grantedInEnvironmentId: environmentId && environmentRole !== workspaceRole ? environmentId : null,
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  getSession.mockResolvedValue({ user: { id: "user_1", email: "a@example.com" }, session: { id: "s_1" } });
  hasWorkspaceAccess.mockResolvedValue(true);
  getEnvironment.mockImplementation(async (_ws: string, id: string) => ({ id }));
  getDefaultEnvironment.mockResolvedValue({ id: ENV });
  store.getIntegrationById.mockResolvedValue({ id: INTEGRATION, workspaceId: WS, type: "slack", enabledEventTypes: [] });
  store.deleteIntegration.mockResolvedValue(undefined);
  store.toggleIntegration.mockResolvedValue(undefined);
  store.updateIntegrationEventTypes.mockResolvedValue({ id: INTEGRATION, enabledEventTypes: [] });
  roles("member", "member");
});

describe("a workspace's chat integrations", () => {
  it.each(WRITES)("refuse a viewer granted member in one environment to $name them", async (route) => {
    roles("viewer", "member");
    const res = await send(route);
    expect(res.status).toBe(403);
    expect(writeCalls()).toBe(0);
  });

  it.each(WRITES)("let a workspace member $name them", async (route) => {
    expect((await send(route)).status).toBe(200);
    expect(writeCalls()).toBe(1);
  });

  it("are judged by the workspace role, not the role in the environment the request names", async () => {
    expect((await send(WRITES[0])).status).toBe(200);
    expect(resolveMemberRole).toHaveBeenCalledWith(WS, "user_1", null);
  });
});
