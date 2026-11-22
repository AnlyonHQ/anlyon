import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "user_1";

const mocks = vi.hoisted(() => ({
  caller: { authType: "oauth", scopes: [] as string[], groups: [] as string[] },
  role: "admin",
  createApiKey: vi.fn(),
}));

vi.mock("../middleware/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/auth.ts")>();
  return {
    ...actual,
    requireApiKey: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      c.set("authType", mocks.caller.authType);
      c.set("apiKeyScopes", mocks.caller.scopes);
      c.set("oauthGrantedGroups", mocks.caller.groups);
      c.set("workspaceId", WORKSPACE_ID);
      c.set("environmentId", ENVIRONMENT_ID);
      c.set("userId", USER_ID);
      await next();
    },
  };
});

vi.mock("../middleware/rateLimit.ts", () => ({
  rateLimitByWorkspace: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("../../core/workspace/roles.ts", () => ({
  resolveMemberRole: async () => ({ workspaceRole: mocks.role, role: mocks.role, grantedInEnvironmentId: null }),
}));

vi.mock("../../core/auth/api-keys.ts", () => ({ createApiKey: mocks.createApiKey }));

const { default: router, STANDARD_AGENT_KEY_SCOPES, agentKeyScopes } = await import("./agent-api-keys.ts");
const { buildErrorResponse } = await import("../middleware/error.ts");
const { PRIVILEGED_API_KEY_SCOPES } = await import("../../core/auth/api-key-scopes.ts");
const { DEFAULT_OAUTH_SCOPES, OAUTH_SCOPE_GROUPS, expandOAuthScopes } = await import("../../core/auth/oauth-scopes.ts");

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/", router);

const DEFAULT_LOGIN = expandOAuthScopes(["anlyon:actions", "anlyon:observability"]);

function post(body: unknown = { name: "anlyon init: my-app" }) {
  return app.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  mocks.caller = { authType: "oauth", scopes: DEFAULT_LOGIN, groups: ["openid", "anlyon:actions", "anlyon:observability", "anlyon:keys"] };
  mocks.role = "admin";
  mocks.createApiKey.mockReset();
  mocks.createApiKey.mockResolvedValue({ apiKey: { id: "key_1", name: "anlyon init: my-app" }, key: "anlyon_live_fake_not_a_real_key" });
});

describe("the standard agent key", () => {
  it("is the default consent groups' scopes, with no privileged scope", () => {
    expect([...STANDARD_AGENT_KEY_SCOPES].sort()).toEqual(expandOAuthScopes(DEFAULT_OAUTH_SCOPES).sort());
    expect(STANDARD_AGENT_KEY_SCOPES.filter((scope) => PRIVILEGED_API_KEY_SCOPES.includes(scope))).toEqual([]);
    expect(STANDARD_AGENT_KEY_SCOPES).toContain("actions:invoke");
  });

  it("never holds more than the login that made it", () => {
    expect(agentKeyScopes(["actions:invoke", "policies:write", "secrets:read"])).toEqual(["actions:invoke"]);
  });

  it("is granted by a sensitive consent group that expands to no scope", () => {
    expect(OAUTH_SCOPE_GROUPS["anlyon:keys"].sensitive).toBe(true);
    expect(OAUTH_SCOPE_GROUPS["anlyon:keys"].scopes).toEqual([]);
    expect(DEFAULT_OAUTH_SCOPES).not.toContain("anlyon:keys");
  });
});

describe("POST /api/v2/api-keys", () => {
  it("creates a key for the login's own environment and does not let it be cached", async () => {
    const response = await post();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [workspaceId, userId, name, expiresAt, scopes, environmentId] = mocks.createApiKey.mock.calls[0]!;
    expect({ workspaceId, userId, name, expiresAt, environmentId }).toEqual({
      workspaceId: WORKSPACE_ID, userId: USER_ID, name: "anlyon init: my-app", expiresAt: undefined, environmentId: ENVIRONMENT_ID,
    });
    expect((scopes as string[]).sort()).toEqual(agentKeyScopes(DEFAULT_LOGIN).sort());
    expect(scopes).not.toContain("events:write");
  });

  it("refuses an API key: a key never mints keys", async () => {
    mocks.caller.authType = "apiKey";
    const response = await post();
    expect(response.status).toBe(403);
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("refuses a login that was not granted anlyon:keys", async () => {
    mocks.caller.groups = ["openid", "anlyon:actions", "anlyon:observability"];
    const response = await post();
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).toContain("anlyon:keys");
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("refuses a person whose role cannot manage keys", async () => {
    mocks.role = "viewer";
    const response = await post();
    expect(response.status).toBe(403);
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("refuses a login that cannot invoke actions, since its key would be useless", async () => {
    mocks.caller.scopes = expandOAuthScopes(["anlyon:observability"]);
    const response = await post();
    expect(response.status).toBe(403);
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("takes a name and nothing else: no environment, no scopes", async () => {
    expect((await post({ name: "x", scopes: ["policies:write"] })).status).toBe(400);
    expect((await post({ name: "x", environmentId: ENVIRONMENT_ID })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });
});
